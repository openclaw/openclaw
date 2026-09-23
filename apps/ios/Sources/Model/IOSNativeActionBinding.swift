import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Synchronization

final class IOSNativeActionBinding: Sendable {
    struct RetirementReservation: Sendable {
        fileprivate let binding: IOSNativeActionBinding
    }

    private final class RetirementOwner: Sendable {
        let id = UUID()
        let retired = Mutex(false)
    }

    let session: OpenClawNativeSessionRef
    let gateway: GatewayNodeSession
    let route: GatewayNodeSessionRoute
    let sessionRoutingContract: String?
    private let httpContext: GatewayAdmittedHTTPContext?
    private let retirement: RetirementOwner

    private var isRetired: Bool {
        self.retirement.retired.withLock { $0 }
    }

    init(
        session: OpenClawNativeSessionRef,
        gateway: GatewayNodeSession,
        route: GatewayNodeSessionRoute,
        sessionRoutingContract: String? = nil,
        httpContext: GatewayAdmittedHTTPContext? = nil)
    {
        self.session = session
        self.gateway = gateway
        self.route = route
        self.sessionRoutingContract = sessionRoutingContract
        self.httpContext = httpContext
        self.retirement = RetirementOwner()
    }

    private init(
        capture: IOSNativeActionBinding,
        retirement: RetirementOwner,
        session: OpenClawNativeSessionRef? = nil,
        sessionRoutingContract: String? = nil,
        httpContext: GatewayAdmittedHTTPContext? = nil)
    {
        self.session = session ?? capture.session
        self.gateway = capture.gateway
        self.route = capture.route
        self.sessionRoutingContract = sessionRoutingContract
        self.httpContext = httpContext
        self.retirement = retirement
    }

    static func capture(
        session: OpenClawNativeSessionRef,
        gateway: GatewayNodeSession,
        route: GatewayNodeSessionRoute,
        reservation: RetirementReservation? = nil) async throws -> Self
    {
        let candidate = Self(session: session, gateway: gateway, route: route)
        // Keep the lifetime selected before verification began. Retirement while
        // owner/history reads suspend must reject this capture, not mint a fresh one.
        let binding = if let previous = reservation?.binding, previous.matchesAccountRoute(candidate) {
            Self(capture: candidate, retirement: previous.retirement)
        } else {
            candidate
        }
        try await binding.requireAvailable()
        let roster = try await binding.request(OpenClawChatGatewayRequests.agentsList())
        let routing = try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(roster)
        guard let context = await gateway.admittedHTTPContext(ifCurrentRoute: route),
              await binding.isCurrent()
        else { throw OpenClawNativeActionError(Self.unavailableReason) }
        return Self(
            capture: binding,
            retirement: binding.retirement,
            sessionRoutingContract: routing.contract,
            httpContext: context)
    }

    func scoped(to target: OpenClawChatSessionTarget) -> IOSNativeActionBinding? {
        let key = target.sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let encodedAgent = OpenClawChatSessionKey.agentID(from: key)?.lowercased()
        let explicitAgent = target.agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !self.isRetired, !key.isEmpty,
              explicitAgent?.isEmpty != true,
              encodedAgent == nil || explicitAgent == nil || encodedAgent == explicitAgent
        else { return nil }
        let session = OpenClawNativeSessionRef(
            owner: self.session.owner,
            agentID: encodedAgent ?? explicitAgent ?? self.session.agentID,
            sessionKey: key)
        // Logical adoption retires presentation, not the captured account lifetime.
        // Old requests and the new target must observe the same profile retirement.
        return IOSNativeActionBinding(
            capture: self,
            retirement: self.retirement,
            session: session,
            sessionRoutingContract: self.sessionRoutingContract,
            httpContext: self.httpContext)
    }

    var mediaConnection: IOSMediaArtifactLoader.Connection? {
        self.httpContext.map { IOSMediaArtifactLoader.Connection(binding: self, context: $0) }
    }

    var expectedProfileId: String {
        self.session.owner.profileID
    }

    var profileObservationID: UUID {
        self.retirement.id
    }

    static let unavailableReason = "The selected account or Gateway connection changed. Open the session again."

    func isCurrent() async -> Bool {
        guard !self.isRetired else { return false }
        let current = await self.gateway.currentRoute(ifGatewayID: self.session.owner.gatewayID) == self.route
        return current && !self.isRetired
    }

    func requireAvailable() async throws {
        guard await self.isCurrent() else { throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch }
        let supported = await self.gateway.supportsServerCapability(.profileBinding, ifCurrentRoute: self.route)
        guard await self.isCurrent() else { throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch }
        guard supported == true else {
            throw OpenClawNativeActionError("Update the selected Gateway to use account-bound native actions.")
        }
    }

    func request(
        _ request: OpenClawChatGatewayRequest,
        completionPolicy: GatewayRequestCompletionPolicy = .requireCurrentRoute) async throws -> Data
    {
        try await self.requireAvailable()
        let data: Data
        do {
            data = try await self.gateway.request(
                request,
                ifCurrentRoute: self.route,
                distinguishPreDispatchRouteChange: true,
                expectedProfileId: self.expectedProfileId,
                completionPolicy: completionPolicy)
        } catch {
            if let observation = GatewayProfileBindingObservation.rejection(
                from: error,
                expectedProfileID: self.expectedProfileId)
            {
                self.observe(observation)
            }
            // Keep the original execution fact: retirement does not prove that
            // an already dispatched mutation had no effect.
            throw error
        }
        if completionPolicy.preservesSuccessfulResponse(for: request.method) { return data }
        // Dispatch already happened. A lost route here is not evidence that a
        // mutation was never sent; retain the caller's uncertain-result handling.
        guard await self.isCurrent() else { throw CancellationError() }
        return data
    }

    func accepts(_ event: EventFrame) async -> Bool {
        // The Gateway stamps operator broadcasts with the current recipient account, not
        // the payload's owner. A missing/different stamp retires this saved selection.
        guard event.recipientprofileid?.utf8.elementsEqual(self.expectedProfileId.utf8) == true else {
            self.observe(.rejected(expectedProfileID: self.expectedProfileId))
            return false
        }
        return await self.isCurrent()
    }

    func observe(_ observation: GatewayProfileBindingObservation) {
        let invalidates: Bool = switch observation {
        case let .verified(profileID): !profileID.utf8.elementsEqual(self.expectedProfileId.utf8)
        case let .rejected(expectedProfileID): expectedProfileID.utf8.elementsEqual(self.expectedProfileId.utf8)
        }
        if invalidates { self.retirement.retired.withLock { $0 = true } }
    }

    func canReuse(_ other: IOSNativeActionBinding) -> Bool {
        // Value-scoped transports keep this reference owner. A new verified
        // capture may reuse a healthy model, never a retired account's model.
        self.session == other.session && self.retirement === other.retirement &&
            !self.isRetired && !other.isRetired && self.matchesAccountRoute(other)
    }

    func reserveRetirement() -> RetirementReservation? {
        self.isRetired ? nil : RetirementReservation(binding: self)
    }

    private func matchesAccountRoute(_ other: IOSNativeActionBinding) -> Bool {
        self.session.owner == other.session.owner &&
            self.gateway === other.gateway && self.route == other.route
    }

    @MainActor
    func canReopen(
        _ next: IOSNativeActionBinding,
        preserving chat: OpenClawChatViewModel,
        captureIsActive: Bool) -> Bool
    {
        self.session == next.session && self.gateway === next.gateway &&
            (self.route != next.route || self.isRetired) && !next.isRetired &&
            next.sessionRoutingContract != nil &&
            chat.sessionKey.utf8.elementsEqual(self.session.sessionKey.utf8) &&
            chat.canPreserveIdleTextDraft && !captureIsActive
    }

    func request(method: String, paramsJSON: String?, timeoutSeconds: Int) async throws -> Data {
        let params = try paramsJSON.map {
            try JSONDecoder().decode([String: OpenClawProtocol.AnyCodable].self, from: Data($0.utf8))
        } ?? [:]
        return try await self.request(.init(
            method: method,
            params: params,
            timeoutMs: Double(timeoutSeconds) * 1000))
    }
}
