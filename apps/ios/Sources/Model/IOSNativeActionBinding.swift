import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawNativeActions
import OpenClawProtocol

struct IOSNativeActionBinding: Sendable {
    let session: OpenClawNativeSessionRef
    let gateway: GatewayNodeSession
    let route: GatewayNodeSessionRoute
    let sessionRoutingContract: String?
    private let httpContext: GatewayAdmittedHTTPContext?

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
    }

    static func capture(
        session: OpenClawNativeSessionRef,
        gateway: GatewayNodeSession,
        route: GatewayNodeSessionRoute) async throws -> Self
    {
        let binding = Self(session: session, gateway: gateway, route: route)
        try await binding.requireAvailable()
        let roster = try await binding.request(OpenClawChatGatewayRequests.agentsList())
        let routing = try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(roster)
        guard let context = await gateway.admittedHTTPContext(ifCurrentRoute: route),
              await binding.isCurrent()
        else { throw OpenClawNativeActionError(Self.unavailableReason) }
        return Self(
            session: session,
            gateway: gateway,
            route: route,
            sessionRoutingContract: routing.contract,
            httpContext: context)
    }

    var mediaConnection: IOSMediaArtifactLoader.Connection? {
        self.httpContext.map { IOSMediaArtifactLoader.Connection(binding: self, context: $0) }
    }

    var expectedProfileId: String {
        self.session.owner.profileID
    }

    static let unavailableReason = "The selected account or Gateway connection changed. Open the session again."

    func isCurrent() async -> Bool {
        await self.gateway.currentRoute(ifGatewayID: self.session.owner.gatewayID) == self.route
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
        let data = try await self.gateway.request(
            request,
            ifCurrentRoute: self.route,
            distinguishPreDispatchRouteChange: true,
            expectedProfileId: self.expectedProfileId,
            completionPolicy: completionPolicy)
        if completionPolicy.preservesSuccessfulResponse(for: request.method) { return data }
        // Dispatch already happened. A lost route here is not evidence that a
        // mutation was never sent; retain the caller's uncertain-result handling.
        guard await self.isCurrent() else { throw CancellationError() }
        return data
    }

    func accepts(_ event: EventFrame) async -> Bool {
        guard event.recipientprofileid?.utf8.elementsEqual(self.expectedProfileId.utf8) == true else { return false }
        return await self.isCurrent()
    }

    func matches(_ other: Self) -> Bool {
        self.session == other.session && self.gateway === other.gateway && self.route == other.route
    }

    @MainActor
    func canReopen(_ next: Self, preserving chat: OpenClawChatViewModel, captureIsActive: Bool) -> Bool {
        self.session == next.session && self.gateway === next.gateway && self.route != next.route &&
            next.sessionRoutingContract != nil &&
            chat.sessionKey.utf8.elementsEqual(self.session.sessionKey.utf8) &&
            chat.canPreserveIdleTextDraft && !captureIsActive
    }

    static func isProfileMismatch(_ error: Error) -> Bool {
        (error as? GatewayResponseError)?.detailsReason == "EXPECTED_PROFILE_MISMATCH"
    }

    func request(method: String, paramsJSON: String?, timeoutSeconds: Int) async throws -> Data {
        let params = try paramsJSON.map {
            try JSONDecoder().decode([String: OpenClawProtocol.AnyCodable].self, from: Data($0.utf8))
        } ?? [:]
        return try await self.request(.init(
            method: method, params: params, timeoutMs: Double(timeoutSeconds) * 1000))
    }

    func resolveHTTPURL(_ raw: String) throws -> URL {
        guard let httpContext else { throw OpenClawNativeActionError(Self.unavailableReason) }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let absolute = URL(string: trimmed)
        let resolved = absolute?.scheme == nil
            ? GatewayPluginSurfaceURL.canonicalize(raw: trimmed, against: httpContext.gatewayURL)
            .flatMap(URL.init(string:))
            : absolute
        guard let resolved, ["http", "https"].contains(resolved.scheme?.lowercased() ?? "") else {
            throw OpenClawNativeActionError("The selected Gateway returned an invalid voice URL.")
        }
        return resolved
    }

    func exchangeVoiceOffer(_ original: URLRequest) async throws -> (Data, URLResponse) {
        try await self.requireAvailable()
        guard let httpContext, let url = original.url else {
            throw OpenClawNativeActionError(Self.unavailableReason)
        }
        let isGateway = url.host?.lowercased() == httpContext.gatewayURL.host?.lowercased() &&
            (url.port ?? (url.scheme == "https" ? 443 : 80)) ==
            (httpContext.gatewayURL.port ?? (httpContext.gatewayURL.scheme == "wss" ? 443 : 80)) &&
            (url.scheme == "https") == (httpContext.gatewayURL.scheme == "wss")
        let session = GatewayTLSPinningSession(
            params: GatewayTLSParams(
                required: true,
                expectedFingerprint: isGateway ? httpContext.tlsFingerprintSHA256 : nil,
                allowTOFU: false,
                storeKey: nil),
            allowsRedirects: false,
            allowsStoredCredentials: false)
        defer { session.finishTasksAndInvalidate() }
        var request = original
        request.timeoutInterval = 12
        if isGateway, url.scheme == "https" {
            // Offer credentials and content headers own collisions with proxy headers.
            for (name, value) in httpContext.customHeaders where request.value(forHTTPHeaderField: name) == nil {
                request.setValue(value, forHTTPHeaderField: name)
            }
        }
        let result = try await session.data(for: request, maximumBytes: 1024 * 1024)
        guard await self.isCurrent() else { throw CancellationError() }
        return result
    }

    func subscribeServerEvents(
        bufferingNewest: Int,
        onUnavailable: @escaping @MainActor @Sendable () -> Void) async -> AsyncStream<EventFrame>
    {
        let subscription = await self.gateway.makeServerEventSubscription(bufferingNewest: bufferingNewest)
        let (stream, continuation) = AsyncStream<EventFrame>.makeStream(
            bufferingPolicy: .bufferingNewest(bufferingNewest))
        let task = Task {
            defer {
                subscription.cancel()
                continuation.finish()
            }
            for await event in subscription.events {
                guard !Task.isCancelled else { return }
                guard await self.accepts(event) else {
                    await onUnavailable()
                    return
                }
                continuation.yield(event)
            }
            if !Task.isCancelled { await onUnavailable() }
        }
        continuation.onTermination = { _ in task.cancel() }
        return stream
    }
}
