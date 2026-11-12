import Foundation
import OpenClawKit
import Synchronization

/// This Mac's OpenClaw ID access to one claw, as recorded by its enrollment owner. Selecting
/// the claw is synchronous so a saved primary connection is recognized before any dial.
struct MacOpenClawIDOperatorEnrollment: Sendable {
    let id: UUID
    let hostname: String
    /// Loads the human key and its verification hook when a route starts.
    let credential: @Sendable () async throws -> MacOpenClawIDOperatorCredential
}

/// The in-process owner or member peer key for a claw, and how to re-verify the claw before a
/// dial. The key never leaves the app process, and the node transport never receives it.
struct MacOpenClawIDOperatorCredential: Sendable {
    let identity: OpenClawIDNodeIdentity
    /// Returns the server key and relay from a binding re-verified for this dial.
    let verifiedTarget: @Sendable () async throws -> (serverKey: String, relayURL: URL)
    /// Releases enrollment-owned resources (such as a trust store) after the route retires.
    let close: @Sendable () async -> Void
}

/// One live operator route: the tunnel the primary Gateway connection uses directly, and the
/// loopback dashboard proxy the dashboard WebView reaches with a per-launch cookie.
struct MacOpenClawIDOperatorLive: Sendable {
    let generation: UInt64
    let logicalOrigin: URL
    let sessionBox: WebSocketSessionBox
    let dashboardURL: URL
    let dashboardCookie: HTTPCookie
}

/// Owns the Mac's chat and dashboard access to its OpenClaw ID claw over the human key.
@MainActor
final class MacOpenClawIDOperatorRoute {
    static let shared = MacOpenClawIDOperatorRoute()

    /// Synchronous guard checked while a route is prepared and after it is published.
    private final class Authority: Sendable {
        private let current = Mutex(true)

        func revoke() {
            self.current.withLock { $0 = false }
        }

        func check() throws {
            try Task.checkCancellation()
            guard self.current.withLock({ $0 }) else { throw CancellationError() }
        }
    }

    private struct Resources: Sendable {
        let tunnel: OpenClawIDNodeTunnel
        let proxy: MacOpenClawIDDashboardProxy
        let credential: MacOpenClawIDOperatorCredential
    }

    /// Set once at launch by the enrollment owner; nil while this Mac has no OpenClaw ID claw.
    var enrollment: @MainActor () -> MacOpenClawIDOperatorEnrollment?
    private var generation: UInt64 = 0
    private var route: (
        enrollmentID: UUID,
        authority: Authority,
        task: Task<(MacOpenClawIDOperatorLive, Resources), Error>)?
    /// Read synchronously by dashboard URL derivation, which runs off the main actor.
    private nonisolated static let published = Mutex<(host: String, live: MacOpenClawIDOperatorLive)?>(nil)

    init(enrollment: @escaping @MainActor () -> MacOpenClawIDOperatorEnrollment? = { nil }) {
        self.enrollment = enrollment
    }

    /// The claw hostname whose primary Gateway connection this route serves, if enrolled.
    var hostname: String? {
        self.enrollment()?.hostname
    }

    /// Whether a configured Gateway URL is this Mac's OpenClaw ID claw.
    func serves(_ url: URL) -> Bool {
        guard let hostname = self.hostname, let host = url.host else { return false }
        return host.lowercased() == hostname.lowercased()
    }

    /// Starts or joins the route. A refused or retired route throws; the next call retries.
    func current() async throws -> MacOpenClawIDOperatorLive {
        guard let enrollment = self.enrollment() else { throw OpenClawIDNodeEnrollmentError.notAdmitted }
        if let route = self.route, route.enrollmentID != enrollment.id {
            self.stop()
        }
        if self.route == nil {
            self.generation &+= 1
            let generation = self.generation
            let authority = Authority()
            let invalidate: @Sendable () -> Void = { [weak self] in
                guard let self else { return }
                Task { @MainActor in await self.invalidated(authority) }
            }
            let task = Task {
                try await Self.prepare(
                    enrollment: enrollment, generation: generation, authority: authority, onInvalidated: invalidate)
            }
            self.route = (enrollment.id, authority, task)
        }
        guard let route = self.route else { throw CancellationError() }
        do {
            let (live, _) = try await route.task.value
            try route.authority.check()
            Self.published.withLock { $0 = (enrollment.hostname.lowercased(), live) }
            return live
        } catch {
            if self.route?.authority === route.authority { self.stop() }
            throw error
        }
    }

    /// A tunnel or proxy failure retires only the route it belongs to, then re-resolves chat.
    private func invalidated(_ authority: Authority) async {
        guard self.route?.authority === authority else { return }
        self.stop()
        await GatewayEndpointStore.shared.refresh()
    }

    /// Retires the route; its tunnel, proxy and credential close in the background.
    func stop() {
        guard let route = self.route else { return }
        self.route = nil
        route.authority.revoke()
        route.task.cancel()
        Self.published.withLock { $0 = nil }
        Task {
            guard let (_, resources) = try? await route.task.value else { return }
            await resources.tunnel.shutdown()
            await resources.proxy.shutdown()
            await resources.credential.close()
        }
    }

    /// The dashboard proxy URL standing in for a Gateway URL on this route, with its cookie.
    nonisolated static func dashboardRoute(for gatewayURL: URL) -> (url: URL, cookie: HTTPCookie)? {
        self.published.withLock { published in
            guard let published, gatewayURL.host?.lowercased() == published.host else { return nil }
            return (published.live.dashboardURL, published.live.dashboardCookie)
        }
    }

    private nonisolated static func prepare(
        enrollment: MacOpenClawIDOperatorEnrollment,
        generation: UInt64,
        authority: Authority,
        onInvalidated: @escaping @Sendable () -> Void) async throws
        -> (MacOpenClawIDOperatorLive, Resources)
    {
        let credential = try await enrollment.credential()
        do {
            let relayURL = try await credential.verifiedTarget().relayURL
            guard let origin = URL(string: "wss://\(enrollment.hostname)/") else {
                throw OpenClawIDNodeEnrollmentError.wrongHost
            }
            try authority.check()
            let endpoint = try await OpenClawIDNodeNativeEndpoint.bind(
                identity: credential.identity, relayURL: relayURL)
            let tunnel = OpenClawIDNodeTunnel(
                endpoint: endpoint,
                verifiedServerKey: {
                    let refreshed = try await credential.verifiedTarget()
                    // The endpoint and tunnel bind one relay; a moved relay needs a new route.
                    guard refreshed.relayURL == relayURL else {
                        onInvalidated()
                        throw OpenClawIDNodeTransportError.closed
                    }
                    return refreshed.serverKey
                },
                relayURL: relayURL)
            do {
                let proxy = try await MacOpenClawIDDashboardProxy.start(
                    tunnel: tunnel, logicalOrigin: origin, onUnexpectedStop: onInvalidated)
                do {
                    try authority.check()
                } catch {
                    await proxy.shutdown()
                    throw error
                }
                let live = MacOpenClawIDOperatorLive(
                    generation: generation,
                    logicalOrigin: origin,
                    sessionBox: WebSocketSessionBox(session: OpenClawIDNodeWebSocketSession(
                        tunnel: tunnel, logicalOrigin: origin, role: .operator)),
                    dashboardURL: proxy.baseURL,
                    dashboardCookie: proxy.cookie)
                return (live, Resources(tunnel: tunnel, proxy: proxy, credential: credential))
            } catch {
                await tunnel.shutdown()
                throw error
            }
        } catch {
            await credential.close()
            throw error
        }
    }
}
