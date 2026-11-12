import AppKit
import Foundation
import OpenClawKit
import UniformTypeIdentifiers

/// What sign-in-first enrollment needs from the app, injectable for tests.
@MainActor
struct OnboardingOpenClawIDSignInEnvironment {
    var signIn: () async throws -> String
    var cancelSignIn: () -> Void = {}
    var discovery: (MacOpenClawIDConfiguration) -> any OpenClawIDNodeEnrollmentHTTP = { _ in
        OpenClawIDNodeEnrollmentURLSession()
    }
    var describeNode: () async throws -> OpenClawIDNodeEnrollmentDescription
    var deviceName: () -> String = { InstanceIdentity.displayName }
    var keyStore: (UUID, OpenClawIDKeyPurpose) -> any OpenClawIDNodeIdentityStore = {
        OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, purpose: $1)
    }
    var readKitFile: () -> String? = { OnboardingOpenClawIDSignInService.chooseKitFile() }
    /// Saves the device, selects it for the operator route and starts its node.
    var install: (MacOpenClawIDDevice, OpenClawIDDiscoverySession) -> Void
}

/// Sign-in-first OpenClaw ID enrollment: sign in, pick a claw, then become its owner device by
/// approval from another owner device or with the recovery kit. Node invitations are delegated
/// to the headless node path unchanged.
@MainActor
final class OnboardingOpenClawIDSignInService: OnboardingOpenClawIDService {
    /// Sign-in-first enrollment and node invitations both need the packaged native transport.
    var unavailableReason: String? {
        self.nodeInvitations.unavailableReason
    }

    var accountUnavailableReason: String? {
        if let unavailableReason { return unavailableReason }
        return self.configuration == nil
            ? "OpenClaw ID sign-in isn’t set up in this build. You can use a node invitation instead." : nil
    }

    private let configuration: MacOpenClawIDConfiguration?
    private let environment: OnboardingOpenClawIDSignInEnvironment
    private let nodeInvitations: OnboardingNodeInvitationService
    private let databaseURL: URL
    private var session: OpenClawIDDiscoverySession?
    private var claws: [OpenClawIDDiscoveryClaw] = []
    private var claw: OpenClawIDDiscoveryClaw?
    private var approval: Task<(MacOpenClawIDDevice, OpenClawIDDiscoverySession), Error>?

    convenience init() {
        let configuration = MacOpenClawIDConfiguration.current()
        let signIn = configuration.map { MacOpenClawIDSignIn(configuration: $0) }
        self.init(
            configuration: configuration,
            databaseURL: MacOpenClawIDDeviceStore.shared.databaseURL,
            nodeInvitations: OnboardingNodeInvitationService(),
            environment: .init(
                signIn: {
                    guard let signIn else { throw MacOpenClawIDSignInError.refused }
                    return try await signIn.signIn()
                },
                cancelSignIn: { signIn?.cancel() },
                describeNode: { try await MacNodeModeCoordinator.shared.openClawIDEnrollmentDescription() },
                install: { device, session in
                    let store = MacOpenClawIDDeviceStore.shared
                    store.save(device)
                    store.saveSession(session)
                    MacOpenClawIDOperatorRoute.shared.stop()
                    MacNodeModeCoordinator.shared.selectOpenClawIDTarget(store.nodeTarget(device))
                    MacNodeModeCoordinator.shared.start()
                }))
    }

    init(
        configuration: MacOpenClawIDConfiguration?,
        databaseURL: URL,
        nodeInvitations: OnboardingNodeInvitationService,
        environment: OnboardingOpenClawIDSignInEnvironment)
    {
        self.configuration = configuration
        self.databaseURL = databaseURL
        self.nodeInvitations = nodeInvitations
        self.environment = environment
    }

    func start(_ intent: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep {
        self.cancel()
        switch intent {
        case .joinNode: return try await self.nodeInvitations.start(.joinNode)
        case .connect: return .signIn
        case .makeReachable: throw CocoaError(.featureUnsupported)
        }
    }

    func perform(_ action: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        switch action {
        case .pasteNodeInvitation, .requestNode:
            return try await self.nodeInvitations.perform(action)
        case .checkApproval where self.approval == nil:
            return try await self.nodeInvitations.perform(action)
        case .signIn:
            return try await self.signIn()
        case let .selectClaw(id):
            guard let claw = self.claws.first(where: { $0.id == id }) else { throw CocoaError(.featureUnsupported) }
            self.claw = claw
            guard claw.online else { return .problem(.clawOffline(claw: claw.hostname)) }
            guard claw.relationship == "owner" else { return .problem(.memberNeedsInvite(claw: claw.hostname)) }
            return .chooseApproval(claw: claw.hostname, device: self.environment.deviceName())
        case .approveFromDevice:
            return try await self.approveFromDevice()
        case .retry:
            // From an expired request, ask for a new code; from an offline claw, look again.
            return self.claw?.online == true ? try await self.approveFromDevice() : try await self.refreshClaws()
        case .checkApproval:
            return try await self.awaitApproval()
        case .useRecoveryKit:
            self.approval?.cancel()
            self.approval = nil
            guard let claw = self.claw else { throw CocoaError(.featureUnsupported) }
            return .recoveryKitEntry(claw: claw.hostname)
        case let .submitRecoveryKit(code):
            return try await self.useRecoveryKit(code)
        case .chooseKitFile:
            guard let text = self.environment.readKitFile() else {
                return .recoveryKitEntry(claw: self.claw?.hostname ?? "")
            }
            return try await self.useRecoveryKit(text)
        case .back:
            self.approval?.cancel()
            self.approval = nil
            return try await self.refreshClaws()
        default:
            throw CocoaError(.featureUnsupported)
        }
    }

    func cancel() {
        self.environment.cancelSignIn()
        self.approval?.cancel()
        self.approval = nil
        self.nodeInvitations.cancel()
        self.claw = nil
    }

    private func discovery(_ configuration: MacOpenClawIDConfiguration) -> OpenClawIDDiscoveryAccount {
        .init(origin: configuration.discoveryOrigin, http: self.environment.discovery(configuration))
    }

    private func signIn() async throws -> OnboardingOpenClawIDStep {
        guard let configuration else { throw CocoaError(.featureUnsupported) }
        let idToken: String
        do { idToken = try await self.environment.signIn() } catch MacOpenClawIDSignInError.cancelled {
            return .signIn
        } catch {
            return .problem(.signInFailed)
        }
        self.session = try await self.discovery(configuration).createSession(idToken: idToken)
        return try await self.refreshClaws()
    }

    private func refreshClaws() async throws -> OnboardingOpenClawIDStep {
        guard let configuration, let session else { return .signIn }
        self.claws = try await self.discovery(configuration).listClaws(session)
        let account = session.email ?? session.accountID
        guard !self.claws.isEmpty else { return .problem(.notInvited(account: account)) }
        return .claws(account: account, claws: self.claws.map {
            .init(
                id: $0.id, name: $0.hostname,
                relationship: $0.relationship == "owner" ? "Owner" : ($0.role ?? "member").capitalized,
                online: $0.online)
        })
    }

    /// Generates D, W and W_node for this attempt in this process's Keychain items.
    private func newDevice(_ claw: OpenClawIDDiscoveryClaw, configuration: MacOpenClawIDConfiguration, approval: MacOpenClawIDDevice.Approval)
        async throws -> (MacOpenClawIDDevice, OpenClawIDOwnerDeviceKeys)
    {
        let device = MacOpenClawIDDevice(
            hostname: claw.hostname, clawID: claw.id, discoveryOrigin: configuration.discoveryOrigin,
            deviceEnrollmentID: UUID(), nodeEnrollmentID: UUID(), approvedWith: approval)
        let keys = try await OpenClawIDOwnerDeviceKeys(
            device: OpenClawIDNodeIdentity.loadOrCreate(
                store: self.environment.keyStore(device.deviceEnrollmentID, .device)),
            peer: OpenClawIDNodeIdentity.loadOrCreate(
                store: self.environment.keyStore(device.deviceEnrollmentID, .devicePeer)),
            node: OpenClawIDNodeIdentity.loadOrCreate(store: self.environment.keyStore(device.nodeEnrollmentID!, .node)))
        return (device, keys)
    }

    private func client(_ device: MacOpenClawIDDevice, configuration: MacOpenClawIDConfiguration) -> OpenClawIDOwnerEnrollmentClient {
        .init(
            discoveryOrigin: configuration.discoveryOrigin,
            deviceStore: OpenClawIDNodeNativeTrustStore(
                databaseURL: self.databaseURL, enrollmentID: device.deviceEnrollmentID, assertCurrent: {}),
            nodeStore: device.nodeEnrollmentID.map {
                OpenClawIDNodeNativeTrustStore(databaseURL: self.databaseURL, enrollmentID: $0, assertCurrent: {})
            },
            http: self.environment.discovery(configuration))
    }

    private func label() -> String {
        String(self.environment.deviceName().prefix(64))
    }

    private func approveFromDevice() async throws -> OnboardingOpenClawIDStep {
        guard let configuration, let session, let claw else { throw CocoaError(.featureUnsupported) }
        self.approval?.cancel()
        let description = try await self.environment.describeNode()
        let (device, keys) = try await self.newDevice(claw, configuration: configuration, approval: .device)
        let client = self.client(device, configuration: configuration)
        let label = self.label()
        let codes = AsyncThrowingStream<String, Error>.makeStream()
        self.approval = Task {
            do {
                _ = try await client.approveFromDevice(
                    session: session, claw: claw, keys: keys, label: label, node: description,
                    onCode: { codes.continuation.yield($0) })
                codes.continuation.finish()
                return (device, session)
            } catch {
                codes.continuation.finish(throwing: error)
                throw error
            }
        }
        do {
            var iterator = codes.stream.makeAsyncIterator()
            guard let code = try await iterator.next() else { throw CancellationError() }
            return .ownerCompareCode(
                claw: claw.hostname, device: self.environment.deviceName(), code: Self.spaced(code),
                approvalURL: URL(string: "https://\(claw.hostname)/"))
        } catch {
            return try self.problem(error, claw: claw)
        }
    }

    private func awaitApproval() async throws -> OnboardingOpenClawIDStep {
        guard let approval, let claw else { throw CocoaError(.featureUnsupported) }
        do {
            let (device, session) = try await approval.value
            try Task.checkCancellation()
            self.approval = nil
            return self.finish(device, session: session, approvedWith: "Approved from your other device")
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            self.approval = nil
            return try self.problem(error, claw: claw)
        }
    }

    private func useRecoveryKit(_ text: String) async throws -> OnboardingOpenClawIDStep {
        guard let configuration, let session, let claw else { throw CocoaError(.featureUnsupported) }
        let description = try await self.environment.describeNode()
        let (device, keys) = try await self.newDevice(claw, configuration: configuration, approval: .recoveryKit)
        do {
            _ = try await self.client(device, configuration: configuration).approveWithRecoveryKit(
                text, session: session, claw: claw, keys: keys, label: self.label(), node: description)
        } catch {
            return try self.problem(error, claw: claw)
        }
        return self.finish(device, session: session, approvedWith: "Approved with your recovery kit")
    }

    private func finish(_ device: MacOpenClawIDDevice, session: OpenClawIDDiscoverySession, approvedWith: String)
        -> OnboardingOpenClawIDStep
    {
        self.environment.install(device, session)
        return .ownerConnected(claw: device.hostname, device: self.environment.deviceName(), approvedWith: approvedWith)
    }

    private func problem(_ error: Error, claw: OpenClawIDDiscoveryClaw) throws -> OnboardingOpenClawIDStep {
        switch error as? OpenClawIDOwnerEnrollmentError {
        case .denied, .handoffInvalid: return .problem(.denied(claw: claw.hostname))
        case .kitInvalid, .wrongKit: return .problem(.kitInvalid(claw: claw.hostname))
        case .expired: return .problem(.expired(claw: claw.hostname))
        case nil: throw error
        }
    }

    private static func spaced(_ code: String) -> String {
        code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
    }

    /// The recovery code from a saved kit file. The file is read once and not kept.
    static func chooseKitFile() -> String? {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText, .text, .data]
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url,
              let text = try? String(contentsOf: url, encoding: .utf8),
              let range = text.range(of: "OCK1(-?[0-9A-Za-z]){31}", options: .regularExpression)
        else { return nil }
        return String(text[range])
    }
}
