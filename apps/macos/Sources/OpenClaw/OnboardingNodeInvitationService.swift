import AppKit
import Foundation
import OpenClawKit

/// Accountless Mac enrollment: one owner approval admits this Mac's node key and, unless the
/// owner opts out, its separate operator key for chat and the dashboard. Owner signing and
/// native account sign-in remain separate.
@MainActor
final class OnboardingNodeInvitationService: OnboardingOpenClawIDService {
    let unavailableReason: String?
    var accountUnavailableReason: String? {
        self.unavailableReason ?? """
        Native account sign-in is not available in this build. \
        You can use an owner-created node invitation instead.
        """
    }

    private let databaseURL: URL
    private let describeNode: () async throws -> OpenClawIDNodeEnrollmentDescription
    private let identityStore: (UUID) -> any OpenClawIDNodeIdentityStore
    private let operatorIdentityStore: (UUID) -> any OpenClawIDNodeIdentityStore
    private let http: any OpenClawIDNodeEnrollmentHTTP
    private let now: @Sendable () -> Int64
    private let install: (MacNodeOpenClawIDTarget) async -> Bool
    private var invitation: String?
    private var origin: String?
    private var hostname: String?
    private var description: OpenClawIDNodeEnrollmentDescription?
    private var authority: MacNodeOpenClawIDRouteAuthority?
    private var enrollment: Task<MacNodeOpenClawIDTarget, Error>?
    private var installedTarget: MacNodeOpenClawIDTarget?

    convenience init() {
        self.init(
            databaseURL: MacNodeOpenClawIDSelectionStore.shared.databaseURL,
            unavailableReason: OpenClawIDNodeNativeEndpoint.isPackaged ? nil :
                "Node invitations are not available in this build because the native transport is not packaged.",
            describeNode: { try await MacNodeModeCoordinator.shared.openClawIDEnrollmentDescription() },
            install: { await Self.installApprovedMac($0) })
    }

    /// Makes the approved claw this Mac's working setup: node route, primary chat/dashboard
    /// connection over the operator key, and the bundled runtime node commands execute with.
    /// Returns whether chat answered; false means the owner approved the node alone.
    private static func installApprovedMac(_ target: MacNodeOpenClawIDTarget) async -> Bool {
        MacNodeModeCoordinator.shared.selectOpenClawIDTarget(target, operatorRequested: true)
        MacNodeModeCoordinator.shared.start()
        if BundledRuntime.isBundledApp {
            // Exec policy resolves the CLI from the prepared runtime; a node-only Mac never
            // started a local Gateway, which is what prepares it otherwise.
            _ = try? await BundledRuntime.seed()
        }
        MacOpenClawIDOperatorRoute.shared.stop()
        let state = AppStateStore.shared
        let previous = (state.connectionMode, state.remoteTransport, state.remoteUrl)
        state.remoteTransport = .direct
        state.remoteUrl = "wss://\(target.hostname)"
        state.connectionMode = .remote
        await GatewayEndpointStore.shared.refresh()
        do {
            _ = try await GatewayConnection.shared.request(method: "health", params: nil, timeoutMs: 30000)
            return true
        } catch {
            // Approved as a node only: keep the primary connection the person already had.
            MacOpenClawIDOperatorRoute.shared.stop()
            (state.connectionMode, state.remoteTransport, state.remoteUrl) = previous
            await GatewayEndpointStore.shared.refresh()
            return false
        }
    }

    init(
        databaseURL: URL,
        unavailableReason: String? = nil,
        describeNode: @escaping () async throws -> OpenClawIDNodeEnrollmentDescription,
        identityStore: @escaping (UUID) -> any OpenClawIDNodeIdentityStore = {
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0)
        },
        operatorIdentityStore: @escaping (UUID) -> any OpenClawIDNodeIdentityStore = {
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, operatorKey: true)
        },
        http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) },
        install: @escaping (MacNodeOpenClawIDTarget) async -> Bool)
    {
        self.databaseURL = databaseURL
        self.unavailableReason = unavailableReason
        self.describeNode = describeNode
        self.identityStore = identityStore
        self.operatorIdentityStore = operatorIdentityStore
        self.http = http
        self.now = now
        self.install = install
    }

    func start(_ intent: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep {
        self.cancel()
        switch intent {
        case .joinNode: return .nodeInvitation
        case .connect: return .signIn
        case .makeReachable: throw CocoaError(.featureUnsupported)
        }
    }

    func perform(_ action: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
        switch action {
        case let .submitNodeInvitation(text, discoveryOrigin):
            self.cancel()
            let authority = MacNodeOpenClawIDRouteAuthority()
            self.authority = authority
            let input = try OnboardingNodeInvitationInput(text)
            let invitation = input.link
            let link = try OpenClawIDNodeEnrollmentLink(invitation)
            // An edited Advanced field wins over the command's flag, which wins over the link.
            let explicit = discoveryOrigin.trimmingCharacters(in: .whitespacesAndNewlines)
            let origin = try OpenClawIDNodeEnrollmentLink.discoveryOrigin(
                explicit.isEmpty ? input.discoveryOrigin ?? link.discoveryOrigin?.absoluteString ?? "" : explicit)
            let description = try await self.describeNode()
            try authority.check()
            self.invitation = invitation
            self.origin = origin.absoluteString
            self.hostname = link.hostname
            self.description = description
            return .addMac(
                claw: link.hostname,
                device: description.displayName,
                capabilities: description.commands.joined(separator: ", "))
        case .requestNode:
            guard self.enrollment == nil, let invitation = self.invitation, let origin = self.origin,
                  let hostname = self.hostname, let description = self.description,
                  let authority = self.authority else { throw OpenClawIDNodeEnrollmentError.invalidLink }
            try authority.check()
            self.invitation = nil
            let id = UUID()
            let identityStore = self.identityStore(id)
            let operatorIdentityStore = self.operatorIdentityStore(id)
            let databaseURL = self.databaseURL
            let http = self.http
            let now = self.now
            let codes = AsyncThrowingStream<String, Error>.makeStream()
            self.enrollment = Task {
                let store = OpenClawIDNodeNativeTrustStore(
                    databaseURL: databaseURL, enrollmentID: id, assertCurrent: { try authority.check() })
                do {
                    try authority.check()
                    let identity = try await OpenClawIDNodeIdentity.loadOrCreate(store: identityStore)
                    // W_op stays in this process; the node transport and worker never receive it.
                    let operatorIdentity = try await OpenClawIDNodeIdentity.loadOrCreate(store: operatorIdentityStore)
                    try authority.check()
                    let client = OpenClawIDNodeEnrollmentClient(http: http, trustStore: store, now: now)
                    _ = try await client.enroll(
                        joinLink: invitation,
                        discoveryOrigin: origin,
                        identity: identity,
                        operatorPeerKey: operatorIdentity.peerKey,
                        description: description,
                        onVerificationCode: { code in
                            codes.continuation.yield(code)
                            codes.continuation.finish()
                        })
                    try authority.check()
                    await store.close()
                    return MacNodeOpenClawIDTarget(
                        hostname: hostname, enrollmentID: id, databaseURL: databaseURL, identityStore: identityStore)
                } catch {
                    codes.continuation.finish(throwing: error)
                    await store.close()
                    throw error
                }
            }
            var iterator = codes.stream.makeAsyncIterator()
            guard let code = try await iterator.next() else { throw CancellationError() }
            try authority.check()
            return .compareCode(claw: hostname, device: description.displayName, code: code, approvalURL: nil)
        case .checkApproval:
            // Waits for the owner's decision; the enrollment polls Discovery until W is admitted.
            guard let enrollment = self.enrollment, let authority = self.authority else {
                throw OpenClawIDNodeEnrollmentError.notAdmitted
            }
            let target = try await enrollment.value
            try authority.check()
            guard self.installedTarget == nil else { return .connected(claw: target.hostname) }
            self.installedTarget = target
            let chat = await self.install(target)
            try authority.check()
            return chat ? .connected(claw: target.hostname) : .nodeConnection(claw: target.hostname, connected: true)
        default:
            throw CocoaError(.featureUnsupported)
        }
    }

    func cancel() {
        self.authority?.revoke()
        self.enrollment?.cancel()
        self.enrollment = nil
        self.authority = nil
        self.invitation = nil
        self.origin = nil
        self.hostname = nil
        self.description = nil
        // A completed installation belongs to the coordinator, not this presentation's lifetime.
        self.installedTarget = nil
    }
}
