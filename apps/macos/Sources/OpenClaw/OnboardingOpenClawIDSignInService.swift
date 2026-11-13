import AppKit
import Foundation
import OpenClawKit
import Synchronization
import UniformTypeIdentifiers

/// What sign-in-first enrollment needs from the app, injectable for tests.
@MainActor
struct OnboardingOpenClawIDSignInEnvironment {
    var signIn: (_ freshLogin: Bool) async throws -> String
    var cancelSignIn: () -> Void = {}
    var discovery: (MacOpenClawIDConfiguration) -> any OpenClawIDNodeEnrollmentHTTP = { _ in
        OpenClawIDNodeEnrollmentURLSession()
    }

    var describeNode: () async throws -> OpenClawIDNodeEnrollmentDescription
    var deviceName: () -> String = { InstanceIdentity.displayName }
    var keyStore: (UUID, OpenClawIDKeyPurpose) -> any OpenClawIDNodeIdentityStore = {
        OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, purpose: $1)
    }

    var trustStore: (URL, UUID) -> any OpenClawIDNodeTrustStore = {
        OpenClawIDNodeNativeTrustStore(databaseURL: $0, enrollmentID: $1, assertCurrent: {})
    }

    var readKitFile: () async -> String? = { await OnboardingOpenClawIDSignInService.chooseKitFile() }
    /// The copied invite link, read only when the person chooses Paste and never kept in view state.
    var readInviteLink: () -> String? = { NSPasteboard.general.string(forType: .string) }
    /// Keeps a member request waiting for approval between sheets and launches.
    var store: MacOpenClawIDDeviceStore = .shared
    var savedSession: () -> OpenClawIDDiscoverySession? = { MacOpenClawIDDeviceStore.shared.session() }
    var saveSession: (OpenClawIDDiscoverySession) -> Void = { MacOpenClawIDDeviceStore.shared.saveSession($0) }
    var forgetKeys: (UUID) async -> Void = { await MacOpenClawIDDeviceStore.forgetKeys(device: $0) }
    var now: () -> Date = { Date() }
    var sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    /// Saves the device, selects it for the operator route and starts its node (none for a member).
    var install: (MacOpenClawIDDevice, OpenClawIDDiscoverySession) -> Void
}

/// Sign-in-first OpenClaw ID enrollment: sign in, pick a claw, then become its owner device by
/// approval from another owner device or with the recovery kit, or join a claw as a member with an
/// owner's invite link. Node invitations are delegated to the headless node path unchanged.
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
    private var freshLogin = false
    private var claws: [OpenClawIDDiscoveryClaw] = []
    private var claw: OpenClawIDDiscoveryClaw?
    private var approval: Task<(MacOpenClawIDDevice, OpenClawIDDiscoverySession), Error>?
    /// The current attempt's code and the person's answer (nil until they compare).
    private var compare: (step: OnboardingOpenClawIDStep, answer: CodeAnswer)?
    /// A pasted invite link, held until the person asks to join or leaves the step.
    private var invite: OpenClawIDInviteLink?
    /// The member request this sheet waits on.
    private var pending: MacOpenClawIDPendingJoin?
    /// How often a pending member request looks for the owner's approval.
    static let memberPollInterval = Duration.seconds(5)

    final class CodeAnswer: Sendable {
        private let value = Mutex<Bool?>(nil)
        var current: Bool? {
            self.value.withLock { $0 }
        }

        func set(_ matches: Bool) {
            self.value.withLock { $0 = matches }
        }
    }

    convenience init() {
        let configuration = MacOpenClawIDConfiguration.current()
        let signIn = configuration.map { MacOpenClawIDSignIn(configuration: $0) }
        self.init(
            configuration: configuration,
            databaseURL: MacOpenClawIDDeviceStore.shared.databaseURL,
            nodeInvitations: OnboardingNodeInvitationService(),
            environment: .init(
                signIn: { freshLogin in
                    guard let signIn else { throw MacOpenClawIDSignInError.refused }
                    return try await signIn.signIn(freshLogin: freshLogin)
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
        case .connect:
            guard let session = self.environment.savedSession(), let step = await self.resumeJoin(session: session)
            else { return .signIn }
            self.session = session
            return step
        case .makeReachable: throw CocoaError(.featureUnsupported)
        }
    }

    func perform(_ action: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        if let step = try await self.performMemberJoin(action) { return step }
        switch action {
        case .pasteNodeInvitation, .requestNode:
            return try await self.nodeInvitations.perform(action)
        case .checkApproval where self.approval == nil:
            return try await self.nodeInvitations.perform(action)
        case .switchAccount:
            self.cancel()
            self.freshLogin = true
            return try await self.signIn()
        case .signIn:
            return try await self.signIn()
        case let .selectClaw(id):
            guard let claw = self.claws.first(where: { $0.id == id }) else { throw CocoaError(.featureUnsupported) }
            self.claw = claw
            guard claw.online else { return .problem(.clawOffline(claw: claw.hostname)) }
            // Each of a member's devices joins with its own invite from an owner.
            guard claw.relationship == "owner" else { return .inviteEntry(claw: claw.hostname) }
            return .chooseApproval(claw: claw.hostname, device: self.environment.deviceName())
        case .approveFromDevice:
            return try await self.approveFromDevice()
        case let .confirmCode(matches):
            return try self.confirmCode(matches)
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
            guard let text = await self.environment.readKitFile() else {
                return .recoveryKitEntry(claw: self.claw?.hostname ?? "")
            }
            return try await self.useRecoveryKit(text)
        case .back:
            self.approval?.cancel()
            self.approval = nil
            self.invite = nil
            return try await self.refreshClaws()
        default:
            throw CocoaError(.featureUnsupported)
        }
    }

    func cancel() {
        self.environment.cancelSignIn()
        self.approval?.cancel()
        self.approval = nil
        self.compare = nil
        self.invite = nil
        // A request sent to the claw stays saved: reopening the sheet resumes the wait.
        self.pending = nil
        self.nodeInvitations.cancel()
        self.claw = nil
        self.claws = []
        self.session = nil
        self.freshLogin = false
    }

    private func discovery(_ configuration: MacOpenClawIDConfiguration) -> OpenClawIDDiscoveryAccount {
        .init(origin: configuration.discoveryOrigin, http: self.environment.discovery(configuration))
    }

    private func signIn() async throws -> OnboardingOpenClawIDStep {
        guard let configuration else { throw CocoaError(.featureUnsupported) }
        let idToken: String
        do { idToken = try await self.environment.signIn(self.freshLogin) } catch MacOpenClawIDSignInError.cancelled {
            return .signIn
        } catch {
            return .problem(.signInFailed)
        }
        let session = try await self.discovery(configuration).createSession(idToken: idToken)
        self.session = session
        if let step = await self.resumeJoin(session: session) {
            self.environment.saveSession(session)
            return step
        }
        return try await self.refreshClaws()
    }

    private func refreshClaws() async throws -> OnboardingOpenClawIDStep {
        guard let configuration, let session else { return .signIn }
        self.claws = try await self.discovery(configuration).listClaws(session)
        let account = session.email ?? session.accountID
        guard !self.claws.isEmpty else { return .problem(.notInvited(account: account)) }
        let claws = self.claws.map {
            OnboardingClaw(
                id: $0.id,
                name: $0.hostname,
                relationship: $0.relationship == "owner" ? "Owner" : ($0.role ?? "member").capitalized,
                online: $0.online)
        }
        return .claws(account: account, claws: claws)
    }

    /// Generates D, W and W_node for this attempt in this process's Keychain items.
    private func newDevice(
        _ claw: OpenClawIDDiscoveryClaw,
        configuration: MacOpenClawIDConfiguration,
        approval: MacOpenClawIDDevice.Approval) async throws -> (MacOpenClawIDDevice, OpenClawIDOwnerDeviceKeys)
    {
        let nodeID = UUID()
        let device = MacOpenClawIDDevice(
            hostname: claw.hostname,
            clawID: claw.id,
            discoveryOrigin: configuration.discoveryOrigin,
            deviceEnrollmentID: UUID(),
            nodeEnrollmentID: nodeID,
            approvedWith: approval)
        let store = self.environment.keyStore
        let keys = try await OpenClawIDOwnerDeviceKeys(
            device: OpenClawIDNodeIdentity.loadOrCreate(store: store(device.deviceEnrollmentID, .device)),
            peer: OpenClawIDNodeIdentity.loadOrCreate(store: store(device.deviceEnrollmentID, .devicePeer)),
            node: OpenClawIDNodeIdentity.loadOrCreate(store: store(nodeID, .node)))
        return (device, keys)
    }

    private func client(
        _ device: MacOpenClawIDDevice,
        configuration: MacOpenClawIDConfiguration) -> OpenClawIDOwnerEnrollmentClient
    {
        .init(
            discoveryOrigin: configuration.discoveryOrigin,
            deviceStore: self.environment.trustStore(self.databaseURL, device.deviceEnrollmentID),
            nodeStore: device.nodeEnrollmentID.map {
                self.environment.trustStore(self.databaseURL, $0)
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
        let answer = CodeAnswer()
        self.approval = Task {
            do {
                _ = try await client.approveFromDevice(
                    session: session,
                    claw: claw,
                    keys: keys,
                    label: label,
                    node: description,
                    onCode: { codes.continuation.yield($0) },
                    confirmed: { answer.current })
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
            let step = OnboardingOpenClawIDStep.ownerCompareCode(
                claw: claw.hostname,
                device: self.environment.deviceName(),
                code: Self.spaced(code),
                approvalURL: URL(string: "https://\(claw.hostname)/"),
                confirmed: false)
            self.compare = (step, answer)
            return step
        } catch {
            return try self.problem(error, claw: claw)
        }
    }

    private func confirmCode(_ matches: Bool) throws -> OnboardingOpenClawIDStep {
        guard let compare, case let .ownerCompareCode(claw, device, code, url, _) = compare.step else {
            throw CocoaError(.featureUnsupported)
        }
        compare.answer.set(matches)
        // A mismatch ends the attempt; the wait reports it as not approved.
        return .ownerCompareCode(claw: claw, device: device, code: code, approvalURL: url, confirmed: matches)
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
        try Task.checkCancellation()
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

    // MARK: Member join

    /// The member-join actions, and the approval wait and retry while a member request is pending;
    /// nil for every other action.
    private func performMemberJoin(_ action: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep? {
        switch action {
        case .joinWithInvite:
            self.invite = nil
            return .inviteEntry(claw: nil)
        case .pasteInvite:
            return self.pasteInvite()
        case .requestJoin:
            return try await self.requestJoin()
        case .cancelJoin:
            await self.cancelJoin()
            return try await self.refreshClaws()
        case .checkApproval where self.pending != nil:
            return try await self.awaitMemberApproval()
        case .retry:
            return self.pending.map {
                .memberPending(claw: $0.hostname, device: self.environment.deviceName())
            }
        default:
            return nil
        }
    }

    /// The saved member request of this account, if any. The wait checks admission before it
    /// treats an old request as expired: an owner may have approved it while this Mac was closed.
    private func resumeJoin(session: OpenClawIDDiscoverySession) async -> OnboardingOpenClawIDStep? {
        guard let join = self.environment.store.pendingJoin(), join.accountID == session.accountID else { return nil }
        self.pending = join
        return .memberPending(claw: join.hostname, device: self.environment.deviceName())
    }

    private func pasteInvite() -> OnboardingOpenClawIDStep {
        guard let session, let text = self.environment.readInviteLink(),
              let link = try? OpenClawIDInviteLink(text)
        else { return .problem(.inviteInvalid) }
        self.invite = link
        return .memberRequest(
            claw: link.hostname, device: self.environment.deviceName(), account: session.email ?? session.accountID)
    }

    private func memberClient(_ deviceID: UUID, configuration: MacOpenClawIDConfiguration)
        -> OpenClawIDMemberJoinClient
    {
        .init(
            discoveryOrigin: configuration.discoveryOrigin,
            trustStore: self.environment.trustStore(self.databaseURL, deviceID),
            http: self.environment.discovery(configuration))
    }

    /// Creates this Mac's member keys D and W (no node key) and sends the invite redemption.
    private func requestJoin() async throws -> OnboardingOpenClawIDStep {
        guard let configuration, let session, var link = self.invite else { throw CocoaError(.featureUnsupported) }
        self.invite = nil
        let deviceID = UUID()
        let client = self.memberClient(deviceID, configuration: configuration)
        let clawID: String
        do {
            clawID = try await client.clawID(hostname: link.hostname, session: session)
        } catch OpenClawIDNodeEnrollmentError.wrongHost {
            return .problem(.inviteInvalid)
        }
        let join = MacOpenClawIDPendingJoin(
            hostname: link.hostname,
            clawID: clawID,
            rootFingerprint: link.rootFingerprint,
            discoveryOrigin: configuration.discoveryOrigin,
            deviceEnrollmentID: deviceID,
            accountID: session.accountID,
            requestedAt: self.environment.now())
        // Saved before the redemption is sent: a lost answer or a closed window may follow
        // Discovery's acceptance, and only these keys can then be admitted.
        self.environment.store.savePendingJoin(join)
        self.environment.saveSession(session)
        self.pending = join
        let store = self.environment.keyStore
        do {
            let device = try await OpenClawIDNodeIdentity.loadOrCreate(store: store(deviceID, .device))
            let peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: store(deviceID, .devicePeer))
            try await client.redeem(
                &link, clawID: clawID, session: session, device: device, peer: peer, label: self.label())
        } catch let refused as OpenClawIDDiscoveryAccountError {
            // Discovery refused the request outright: nothing reached the claw.
            await self.forget(join)
            if refused.status == 400 { return .problem(.inviteInvalid) }
            throw refused
        }
        return .memberPending(claw: join.hostname, device: self.environment.deviceName())
    }

    /// Polls until the claw's verified snapshot lists this Mac's W as a member, then installs it
    /// with the invite's role and no node. An ended Discovery session asks for sign-in and keeps
    /// the request.
    private func awaitMemberApproval() async throws -> OnboardingOpenClawIDStep {
        guard let configuration, let session, let join = self.pending else { throw CocoaError(.featureUnsupported) }
        let client = self.memberClient(join.deviceEnrollmentID, configuration: configuration)
        let peer = try await OpenClawIDNodeIdentity.loadOrCreate(
            store: self.environment.keyStore(join.deviceEnrollmentID, .devicePeer))
        while true {
            let joined: OpenClawIDMemberJoined?
            do {
                joined = try await client.admitted(
                    hostname: join.hostname,
                    clawID: join.clawID,
                    rootFingerprint: join.rootFingerprint,
                    session: session,
                    peer: peer)
            } catch let refused as OpenClawIDDiscoveryAccountError where refused.status == 401 {
                self.session = nil
                return .signIn
            }
            try Task.checkCancellation()
            if let joined {
                let device = MacOpenClawIDDevice(
                    hostname: joined.hostname,
                    clawID: joined.clawID,
                    discoveryOrigin: join.discoveryOrigin,
                    deviceEnrollmentID: join.deviceEnrollmentID,
                    nodeEnrollmentID: nil,
                    approvedWith: .invite,
                    memberRole: joined.role,
                    memberAccountID: session.accountID)
                self.environment.install(device, session)
                self.environment.store.savePendingJoin(nil)
                self.pending = nil
                return .memberConnected(
                    claw: joined.hostname, device: self.environment.deviceName(), role: joined.role.capitalized)
            }
            guard !join.expired(now: self.environment.now()) else {
                await self.forget(join)
                return .problem(.inviteExpired(claw: join.hostname))
            }
            try await self.environment.sleep(Self.memberPollInterval)
        }
    }

    /// Stops waiting on this Mac. The request may still be pending at the claw; its keys are gone,
    /// so an approval later admits a key nobody holds.
    private func cancelJoin() async {
        guard let join = self.pending ?? self.environment.store.pendingJoin() else { return }
        await self.forget(join)
    }

    private func forget(_ join: MacOpenClawIDPendingJoin) async {
        self.pending = nil
        self.environment.store.savePendingJoin(nil)
        await self.environment.forgetKeys(join.deviceEnrollmentID)
    }

    private static func spaced(_ code: String) -> String {
        code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
    }

    /// The recovery code from a saved kit file. The file is read once and not kept.
    static func chooseKitFile() async -> String? {
        guard AppLaunchRuntimePlan.current.allowsActivation else { return nil }
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.plainText, .text, .data]
        panel.allowsMultipleSelection = false
        let response = await withCheckedContinuation { continuation in
            panel.begin { continuation.resume(returning: $0) }
        }
        guard response == .OK, let url = panel.url,
              let text = try? String(contentsOf: url, encoding: .utf8),
              let range = text.range(of: "OCK1(-?[0-9A-Za-z]){31}", options: .regularExpression)
        else { return nil }
        return String(text[range])
    }
}
