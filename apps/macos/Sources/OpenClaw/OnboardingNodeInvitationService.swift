import AppKit
import Foundation
import OpenClawKit

/// Accountless node enrollment. Account/owner signing and operator grants remain separate.
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
    private let readInvitation: () throws -> String
    private let describeNode: () async throws -> OpenClawIDNodeEnrollmentDescription
    private let identityStore: (UUID) -> any OpenClawIDNodeIdentityStore
    private let http: any OpenClawIDNodeEnrollmentHTTP
    private let now: @Sendable () -> Int64
    private let install: (MacNodeOpenClawIDTarget) -> Void
    private let isConnected: (MacNodeOpenClawIDTarget) -> Bool
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
            readInvitation: {
                guard let link = NSPasteboard.general.string(forType: .string) else {
                    throw OpenClawIDNodeEnrollmentError.invalidLink
                }
                return link
            },
            describeNode: { try await MacNodeModeCoordinator.shared.openClawIDEnrollmentDescription() },
            install: {
                MacNodeModeCoordinator.shared.selectOpenClawIDTarget($0)
                MacNodeModeCoordinator.shared.start()
            },
            isConnected: { MacNodeModeCoordinator.shared.isOpenClawIDTargetConnected($0) })
    }

    init(
        databaseURL: URL,
        unavailableReason: String? = nil,
        readInvitation: @escaping () throws -> String,
        describeNode: @escaping () async throws -> OpenClawIDNodeEnrollmentDescription,
        identityStore: @escaping (UUID) -> any OpenClawIDNodeIdentityStore = {
            OpenClawIDNodeIdentityKeychainStore(enrollmentID: $0)
        },
        http: any OpenClawIDNodeEnrollmentHTTP = OpenClawIDNodeEnrollmentURLSession(),
        now: @escaping @Sendable () -> Int64 = { Int64(Date().timeIntervalSince1970) },
        install: @escaping (MacNodeOpenClawIDTarget) -> Void,
        isConnected: @escaping (MacNodeOpenClawIDTarget) -> Bool)
    {
        self.databaseURL = databaseURL
        self.unavailableReason = unavailableReason
        self.readInvitation = readInvitation
        self.describeNode = describeNode
        self.identityStore = identityStore
        self.http = http
        self.now = now
        self.install = install
        self.isConnected = isConnected
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
        case let .pasteNodeInvitation(discoveryOrigin):
            self.cancel()
            let authority = MacNodeOpenClawIDRouteAuthority()
            self.authority = authority
            let origin = try OpenClawIDNodeEnrollmentLink.discoveryOrigin(discoveryOrigin)
            let invitation = try self.readInvitation()
            let link = try OpenClawIDNodeEnrollmentLink(invitation)
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
                    try authority.check()
                    let client = OpenClawIDNodeEnrollmentClient(http: http, trustStore: store, now: now)
                    _ = try await client.enroll(
                        joinLink: invitation,
                        discoveryOrigin: origin,
                        identity: identity,
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
            guard let enrollment = self.enrollment, let authority = self.authority else {
                throw OpenClawIDNodeEnrollmentError.notAdmitted
            }
            let target = try await enrollment.value
            // No await between current-attempt validation and the coordinator's installation.
            try authority.check()
            if self.installedTarget == nil {
                self.install(target)
                self.installedTarget = target
            }
            return .nodeConnection(claw: target.hostname, connected: self.isConnected(target))
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
