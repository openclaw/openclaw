#if os(iOS) || os(macOS)
import Foundation
import Synchronization

/// What sign-in-first enrollment needs from the app, injectable for tests.
@MainActor
public struct OpenClawIDAccountSetupEnvironment {
    public var signIn: (_ freshLogin: Bool) async throws -> String
    public var cancelSignIn: () -> Void
    public var discovery: (OpenClawIDConfiguration) -> any OpenClawIDNodeEnrollmentHTTP
    /// The node this device offers an owner claw; nil when the device joins without a node.
    public var describeNode: (() async throws -> OpenClawIDNodeEnrollmentDescription)?
    public var deviceName: () -> String
    public var keyStore: (UUID, OpenClawIDKeyPurpose) -> any OpenClawIDNodeIdentityStore
    public var trustStore: (URL, UUID) -> any OpenClawIDNodeTrustStore
    public var readKitFile: () async -> String?
    /// The copied invite link, read only when the person chooses Paste and never kept in view state.
    public var readInviteLink: () -> String?
    /// Keeps a member request waiting for approval between sheets and launches.
    public var records: OpenClawIDDeviceRecords
    public var savedSession: () -> OpenClawIDDiscoverySession?
    public var saveSession: (OpenClawIDDiscoverySession) -> Void
    /// Deletes an unfinished enrollment's D and W, and its W_node if it has one.
    public var forgetKeys: (UUID, UUID?) async -> Void
    public var now: () -> Date
    public var sleep: (Duration) async throws -> Void
    /// Saves the device and makes it this app's route to the claw (and starts its node, if any).
    public var install: (OpenClawIDDevice, OpenClawIDDiscoverySession) -> Void

    public init(
        signIn: @escaping (_ freshLogin: Bool) async throws -> String,
        cancelSignIn: @escaping () -> Void = {},
        discovery: @escaping (OpenClawIDConfiguration) -> any OpenClawIDNodeEnrollmentHTTP = { _ in
            OpenClawIDNodeEnrollmentURLSession()
        },
        describeNode: (() async throws -> OpenClawIDNodeEnrollmentDescription)?,
        deviceName: @escaping () -> String,
        keyStore: @escaping (UUID, OpenClawIDKeyPurpose) -> any OpenClawIDNodeIdentityStore = {
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0, purpose: $1)
        },
        trustStore: @escaping (URL, UUID) -> any OpenClawIDNodeTrustStore = {
            OpenClawIDNodeNativeTrustStore(databaseURL: $0, enrollmentID: $1, assertCurrent: {})
        },
        readKitFile: @escaping () async -> String?,
        readInviteLink: @escaping () -> String?,
        records: OpenClawIDDeviceRecords,
        savedSession: (() -> OpenClawIDDiscoverySession?)? = nil,
        saveSession: ((OpenClawIDDiscoverySession) -> Void)? = nil,
        forgetKeys: @escaping (UUID, UUID?) async -> Void = {
            await OpenClawIDDeviceRecords.forgetKeys(device: $0, node: $1)
        },
        now: @escaping () -> Date = { Date() },
        sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        install: @escaping (OpenClawIDDevice, OpenClawIDDiscoverySession) -> Void)
    {
        self.signIn = signIn
        self.cancelSignIn = cancelSignIn
        self.discovery = discovery
        self.describeNode = describeNode
        self.deviceName = deviceName
        self.keyStore = keyStore
        self.trustStore = trustStore
        self.readKitFile = readKitFile
        self.readInviteLink = readInviteLink
        self.records = records
        self.savedSession = savedSession ?? { records.session() }
        self.saveSession = saveSession ?? { records.saveSession($0) }
        self.forgetKeys = forgetKeys
        self.now = now
        self.sleep = sleep
        self.install = install
    }
}

/// Sign-in-first OpenClaw ID enrollment: sign in, pick a claw, then become its owner device by
/// approval from another owner device or with the recovery kit, or another device of a member's
/// account by approval from one of their devices; or join a claw as a member with an owner's invite
/// link. Node invitations, where the app has them, are delegated to its headless node path unchanged.
@MainActor
public final class OpenClawIDAccountSetupService: OpenClawIDSetupService {
    /// Sign-in-first enrollment and node invitations both need the packaged native transport.
    public var unavailableReason: String? {
        if let nodeInvitations { return nodeInvitations.unavailableReason }
        return OpenClawIDNodeNativeEndpoint.isPackaged ? nil : "OpenClaw ID is not available in this build."
    }

    public var accountUnavailableReason: String? {
        if let unavailableReason { return unavailableReason }
        guard self.configuration == nil else { return nil }
        return self.nodeInvitations == nil
            ? "OpenClaw ID sign-in isn’t set up in this build."
            : "OpenClaw ID sign-in isn’t set up in this build. You can use a node invitation instead."
    }

    private let configuration: OpenClawIDConfiguration?
    private let environment: OpenClawIDAccountSetupEnvironment
    private let nodeInvitations: (any OpenClawIDSetupService)?
    private let databaseURL: URL
    private var session: OpenClawIDDiscoverySession?
    private var freshLogin = false
    private var claws: [OpenClawIDDiscoveryClaw] = []
    private var claw: OpenClawIDDiscoveryClaw?
    private var approval: Task<(OpenClawIDDevice, OpenClawIDDiscoverySession), Error>?
    /// The current attempt's code and the person's answer (nil until they compare).
    private var compare: (step: OpenClawIDSetupStep, answer: CodeAnswer)?
    /// A pasted invite link, held until the person asks to join or leaves the step.
    private var invite: OpenClawIDInviteLink?
    /// The member request this sheet waits on.
    private var pending: OpenClawIDPendingJoin?
    /// How often a pending member request looks for the owner's approval.
    public static let memberPollInterval = Duration.seconds(5)

    private final class CodeAnswer: Sendable {
        private let value = Mutex<Bool?>(nil)
        var current: Bool? {
            self.value.withLock { $0 }
        }

        func set(_ matches: Bool) {
            self.value.withLock { $0 = matches }
        }
    }

    /// `databaseURL` holds the native trust store; `nodeInvitations` is nil where the app has no node.
    public init(
        configuration: OpenClawIDConfiguration?,
        databaseURL: URL,
        nodeInvitations: (any OpenClawIDSetupService)?,
        environment: OpenClawIDAccountSetupEnvironment)
    {
        self.configuration = configuration
        self.databaseURL = databaseURL
        self.nodeInvitations = nodeInvitations
        self.environment = environment
    }

    public func start(_ intent: OpenClawIDSetupIntent) async throws -> OpenClawIDSetupStep {
        self.cancel()
        switch intent {
        case .joinNode:
            guard let nodeInvitations else { throw CocoaError(.featureUnsupported) }
            return try await nodeInvitations.start(.joinNode)
        case .connect:
            guard let session = self.environment.savedSession(), let step = await self.resumeJoin(session: session)
            else { return .signIn }
            self.session = session
            return step
        case .makeReachable: throw CocoaError(.featureUnsupported)
        }
    }

    public func perform(_ action: OpenClawIDSetupAction) async throws -> OpenClawIDSetupStep {
        if let step = try await self.performMemberJoin(action) { return step }
        switch action {
        case .pasteNodeInvitation, .requestNode:
            guard let nodeInvitations else { throw CocoaError(.featureUnsupported) }
            return try await nodeInvitations.perform(action)
        case .checkApproval where self.approval == nil:
            guard let nodeInvitations else { throw CocoaError(.featureUnsupported) }
            return try await nodeInvitations.perform(action)
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
            guard claw.relationship == "owner" else {
                return .addMemberDevice(claw: claw.hostname, device: self.environment.deviceName())
            }
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

    public func cancel() {
        self.environment.cancelSignIn()
        self.approval?.cancel()
        self.approval = nil
        self.compare = nil
        self.invite = nil
        // A request sent to the claw stays saved: reopening the sheet resumes the wait.
        self.pending = nil
        self.nodeInvitations?.cancel()
        self.claw = nil
        self.claws = []
        self.session = nil
        self.freshLogin = false
    }

    private func discovery(_ configuration: OpenClawIDConfiguration) -> OpenClawIDDiscoveryAccount {
        .init(origin: configuration.discoveryOrigin, http: self.environment.discovery(configuration))
    }

    private func signIn() async throws -> OpenClawIDSetupStep {
        guard let configuration else { throw CocoaError(.featureUnsupported) }
        let idToken: String
        do { idToken = try await self.environment.signIn(self.freshLogin) } catch OpenClawIDSignInError.cancelled {
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

    private func refreshClaws() async throws -> OpenClawIDSetupStep {
        guard let configuration, let session else { return .signIn }
        self.claws = try await self.discovery(configuration).listClaws(session)
        let account = session.email ?? session.accountID
        guard !self.claws.isEmpty else { return .problem(.notInvited(account: account)) }
        let claws = self.claws.map {
            OpenClawIDSetupClaw(
                id: $0.id,
                name: $0.hostname,
                relationship: $0.relationship == "owner" ? "Owner" : "Member",
                online: $0.online)
        }
        return .claws(account: account, claws: claws)
    }

    /// Generates D and W for this attempt in this process's Keychain items, and W_node when an owner
    /// device offers a node. A member device has no node.
    private func newDevice(
        _ claw: OpenClawIDDiscoveryClaw,
        configuration: OpenClawIDConfiguration,
        approval: OpenClawIDDevice.Approval,
        session: OpenClawIDDiscoverySession,
        node: Bool) async throws -> (OpenClawIDDevice, OpenClawIDOwnerDeviceKeys)
    {
        let member = claw.relationship != "owner"
        let nodeID = node ? UUID() : nil
        let device = OpenClawIDDevice(
            hostname: claw.hostname,
            clawID: claw.id,
            discoveryOrigin: configuration.discoveryOrigin,
            deviceEnrollmentID: UUID(),
            nodeEnrollmentID: nodeID,
            approvedWith: approval,
            memberAccountID: member ? session.accountID : nil)
        let store = self.environment.keyStore
        var node: OpenClawIDNodeIdentity?
        if let nodeID { node = try await OpenClawIDNodeIdentity.loadOrCreate(store: store(nodeID, .node)) }
        let keys = try await OpenClawIDOwnerDeviceKeys(
            device: OpenClawIDNodeIdentity.loadOrCreate(store: store(device.deviceEnrollmentID, .device)),
            peer: OpenClawIDNodeIdentity.loadOrCreate(store: store(device.deviceEnrollmentID, .devicePeer)),
            node: node)
        return (device, keys)
    }

    private func client(
        _ device: OpenClawIDDevice,
        configuration: OpenClawIDConfiguration) -> OpenClawIDOwnerEnrollmentClient
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

    private func approveFromDevice() async throws -> OpenClawIDSetupStep {
        guard let configuration, let session, let claw else { throw CocoaError(.featureUnsupported) }
        self.approval?.cancel()
        let member = claw.relationship != "owner"
        let description = member ? nil : try await self.environment.describeNode?()
        let (device, keys) = try await self.newDevice(
            claw, configuration: configuration, approval: .device, session: session, node: description != nil)
        let client = self.client(device, configuration: configuration)
        let label = self.label()
        let codes = AsyncThrowingStream<String, Error>.makeStream()
        let answer = CodeAnswer()
        self.approval = Task {
            do {
                let enrolled = try await client.approveFromDevice(
                    session: session,
                    claw: claw,
                    keys: keys,
                    label: label,
                    node: description,
                    onCode: { codes.continuation.yield($0) },
                    confirmed: { answer.current })
                codes.continuation.finish()
                var admitted = device
                admitted.memberRole = enrolled.memberRole
                return (admitted, session)
            } catch {
                codes.continuation.finish(throwing: error)
                // Declined, expired or abandoned (recovery kit, invite, Back, Close): nothing will use
                // these keys, even if the approver admitted W before the handoff arrived.
                await self.environment.forgetKeys(device.deviceEnrollmentID, device.nodeEnrollmentID)
                throw error
            }
        }
        do {
            var iterator = codes.stream.makeAsyncIterator()
            guard let code = try await iterator.next() else { throw CancellationError() }
            let step = OpenClawIDSetupStep.deviceCompareCode(
                claw: claw.hostname,
                device: self.environment.deviceName(),
                code: Self.spaced(code),
                approvalURL: URL(string: "https://\(claw.hostname)/"),
                confirmed: false,
                member: member)
            self.compare = (step, answer)
            return step
        } catch {
            return try self.problem(error, claw: claw)
        }
    }

    private func confirmCode(_ matches: Bool) throws -> OpenClawIDSetupStep {
        guard let compare, case let .deviceCompareCode(claw, device, code, url, _, member) = compare.step else {
            throw CocoaError(.featureUnsupported)
        }
        compare.answer.set(matches)
        // A mismatch ends the attempt; the wait reports it as not approved.
        return .deviceCompareCode(
            claw: claw, device: device, code: code, approvalURL: url, confirmed: matches, member: member)
    }

    private func awaitApproval() async throws -> OpenClawIDSetupStep {
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

    private func useRecoveryKit(_ text: String) async throws -> OpenClawIDSetupStep {
        guard let configuration, let session, let claw else { throw CocoaError(.featureUnsupported) }
        let description = try await self.environment.describeNode?()
        let (device, keys) = try await self.newDevice(
            claw, configuration: configuration, approval: .recoveryKit, session: session, node: description != nil)
        do {
            _ = try await self.client(device, configuration: configuration).approveWithRecoveryKit(
                text, session: session, claw: claw, keys: keys, label: self.label(), node: description)
        } catch {
            await self.environment.forgetKeys(device.deviceEnrollmentID, device.nodeEnrollmentID)
            return try self.problem(error, claw: claw)
        }
        try Task.checkCancellation()
        return self.finish(device, session: session, approvedWith: "Approved with your recovery kit")
    }

    private func finish(_ device: OpenClawIDDevice, session: OpenClawIDDiscoverySession, approvedWith: String)
        -> OpenClawIDSetupStep
    {
        self.environment.install(device, session)
        if device.memberRole != nil {
            return .memberConnected(claw: device.hostname, device: self.environment.deviceName(), role: nil)
        }
        return .ownerConnected(claw: device.hostname, device: self.environment.deviceName(), approvedWith: approvedWith)
    }

    private func problem(_ error: Error, claw: OpenClawIDDiscoveryClaw) throws -> OpenClawIDSetupStep {
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
    private func performMemberJoin(_ action: OpenClawIDSetupAction) async throws -> OpenClawIDSetupStep? {
        switch action {
        case .joinWithInvite:
            self.approval?.cancel()
            self.approval = nil
            self.invite = nil
            return .inviteEntry
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
    /// treats an old request as expired: an owner may have approved it while this device was closed.
    private func resumeJoin(session: OpenClawIDDiscoverySession) async -> OpenClawIDSetupStep? {
        guard let join = self.environment.records.pendingJoin(), join.accountID == session.accountID else { return nil }
        self.pending = join
        return .memberPending(claw: join.hostname, device: self.environment.deviceName())
    }

    private func pasteInvite() -> OpenClawIDSetupStep {
        guard let session, let text = self.environment.readInviteLink(),
              let link = try? OpenClawIDInviteLink(text)
        else { return .problem(.inviteInvalid) }
        self.invite = link
        return .memberRequest(
            claw: link.hostname, device: self.environment.deviceName(), account: session.email ?? session.accountID)
    }

    private func memberClient(_ deviceID: UUID, configuration: OpenClawIDConfiguration)
        -> OpenClawIDMemberJoinClient
    {
        .init(
            discoveryOrigin: configuration.discoveryOrigin,
            trustStore: self.environment.trustStore(self.databaseURL, deviceID),
            http: self.environment.discovery(configuration))
    }

    /// Creates this device's member keys D and W (no node key) and sends the invite redemption. The
    /// pasted invite stays usable until the request is with the claw or Discovery refused it, so a
    /// failed lookup or refusal can be retried with Ask to join.
    private func requestJoin() async throws -> OpenClawIDSetupStep {
        guard let configuration, let session, var link = self.invite else { throw CocoaError(.featureUnsupported) }
        let deviceID = UUID()
        let client = self.memberClient(deviceID, configuration: configuration)
        let clawID: String
        do {
            clawID = try await client.clawID(hostname: link.hostname, session: session)
        } catch OpenClawIDNodeEnrollmentError.wrongHost {
            return .problem(.inviteInvalid)
        }
        let store = self.environment.keyStore
        let device: OpenClawIDNodeIdentity
        let peer: OpenClawIDNodeIdentity
        do {
            device = try await OpenClawIDNodeIdentity.loadOrCreate(store: store(deviceID, .device))
            peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: store(deviceID, .devicePeer))
            // Nothing reaches the claw until D and W are bound: a failure here can be retried.
            try await client.bind(session: session, device: device, peer: peer, label: self.label())
        } catch {
            await self.environment.forgetKeys(deviceID, nil)
            throw error
        }
        let join = OpenClawIDPendingJoin(
            hostname: link.hostname,
            clawID: clawID,
            rootFingerprint: link.rootFingerprint,
            discoveryOrigin: configuration.discoveryOrigin,
            deviceEnrollmentID: deviceID,
            accountID: session.accountID,
            requestedAt: self.environment.now())
        return try await self.sendJoin(join, link: &link, keys: (device, peer), client: client, session: session)
    }

    /// Saves the request, then mails the redemption. A refusal forgets it; an uncertain answer keeps
    /// waiting on it.
    private func sendJoin(
        _ join: OpenClawIDPendingJoin,
        link: inout OpenClawIDInviteLink,
        keys: (device: OpenClawIDNodeIdentity, peer: OpenClawIDNodeIdentity),
        client: OpenClawIDMemberJoinClient,
        session: OpenClawIDDiscoverySession) async throws -> OpenClawIDSetupStep
    {
        // Saved before the redemption is sent: a lost answer or a closed window may follow
        // Discovery's acceptance, and only these keys can then be admitted.
        self.environment.records.savePendingJoin(join)
        self.environment.saveSession(session)
        self.pending = join
        do {
            try await client.redeem(
                &link,
                clawID: join.clawID,
                session: session,
                device: keys.device,
                peer: keys.peer,
                label: self.label())
        } catch let OpenClawIDNodeEnrollmentError.discoveryRejected(status) {
            // Discovery refused the request outright: nothing reached the claw.
            await self.forget(join)
            if status == 400 {
                self.invite = nil
                return .problem(.inviteInvalid)
            }
            throw OpenClawIDNodeEnrollmentError.discoveryRejected(status)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Delivery is uncertain: Discovery may have accepted the request before the answer was
            // lost. Wait on it like any other request; Cancel request forgets it.
        }
        self.invite = nil
        return .memberPending(claw: join.hostname, device: self.environment.deviceName())
    }

    /// Polls until the claw's verified snapshot lists this device's W as a member, then installs it
    /// with the invite's role and no node. An ended Discovery session asks for sign-in and keeps
    /// the request.
    private func awaitMemberApproval() async throws -> OpenClawIDSetupStep {
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
            } catch OpenClawIDNodeEnrollmentError.discoveryRejected(401) {
                self.session = nil
                return .signIn
            }
            try Task.checkCancellation()
            if let joined {
                let device = OpenClawIDDevice(
                    hostname: joined.hostname,
                    clawID: joined.clawID,
                    discoveryOrigin: join.discoveryOrigin,
                    deviceEnrollmentID: join.deviceEnrollmentID,
                    nodeEnrollmentID: nil,
                    approvedWith: .invite,
                    memberRole: joined.role,
                    memberAccountID: session.accountID)
                self.environment.install(device, session)
                self.environment.records.savePendingJoin(nil)
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

    /// Stops waiting on this device. The request may still be pending at the claw; its keys are gone,
    /// so an approval later admits a key nobody holds.
    private func cancelJoin() async {
        guard let join = self.pending ?? self.environment.records.pendingJoin() else { return }
        await self.forget(join)
    }

    private func forget(_ join: OpenClawIDPendingJoin) async {
        self.pending = nil
        self.environment.records.savePendingJoin(nil)
        await self.environment.forgetKeys(join.deviceEnrollmentID, nil)
    }

    private static func spaced(_ code: String) -> String {
        code.count == 6 ? "\(code.prefix(3)) \(code.suffix(3))" : code
    }
}
#endif
