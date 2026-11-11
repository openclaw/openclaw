import Foundation
import OpenClawKit
import Synchronization

/// One live operator route: the W_op tunnel the native chat connection uses directly, and the
/// loopback dashboard proxy the dashboard WebView reaches with a per-launch cookie.
struct MacOpenClawIDOperatorLive: Sendable {
    let generation: UInt64
    let logicalOrigin: URL
    let sessionBox: WebSocketSessionBox
    let dashboardURL: URL
    let dashboardCookie: HTTPCookie
}

/// Owns the Mac's chat/dashboard access over the operator key approved with its node.
///
/// W_op is read from Keychain only inside this process. The node transport and its worker
/// bridge never receive it, so commands the node runs cannot act as an operator. Discovery is
/// queried with W (the node key), whose verified descriptor names the claw's server key.
@MainActor
final class MacOpenClawIDOperatorRoute {
    static let shared = MacOpenClawIDOperatorRoute(selectionStore: .shared)

    private struct Resources: Sendable {
        let tunnel: OpenClawIDNodeTunnel
        let proxy: MacOpenClawIDDashboardProxy
        let trustStore: OpenClawIDNodeNativeTrustStore
    }

    private let selectionStore: MacNodeOpenClawIDSelectionStore
    private var generation: UInt64 = 0
    private var route: (
        hostname: String,
        authority: MacNodeOpenClawIDRouteAuthority,
        task: Task<(MacOpenClawIDOperatorLive, Resources), Error>)?
    /// Read synchronously by dashboard URL derivation, which runs off the main actor.
    nonisolated private static let published = Mutex<(host: String, live: MacOpenClawIDOperatorLive)?>(nil)

    init(selectionStore: MacNodeOpenClawIDSelectionStore) {
        self.selectionStore = selectionStore
    }

    /// The claw hostname whose primary Gateway connection this route serves, if enrolled.
    var hostname: String? {
        guard let target = try? self.selectionStore.load(), self.selectionStore.operatorRequested else {
            return nil
        }
        return target.hostname
    }

    /// Whether a configured Gateway URL is this Mac's OpenClaw ID claw.
    func serves(_ url: URL) -> Bool {
        guard let hostname = self.hostname, let host = url.host else { return false }
        return host.lowercased() == hostname.lowercased()
    }

    /// Starts or joins the route. A refused or retired route throws; the next call retries.
    func current() async throws -> MacOpenClawIDOperatorLive {
        guard let target = try self.selectionStore.load(), self.selectionStore.operatorRequested else {
            throw OpenClawIDNodeEnrollmentError.notAdmitted
        }
        if let route = self.route, route.hostname != target.hostname {
            self.stop()
        }
        if self.route == nil {
            self.generation &+= 1
            let generation = self.generation
            let authority = MacNodeOpenClawIDRouteAuthority()
            let task = Task { [weak self] in
                try await Self.prepare(target: target, generation: generation, authority: authority) {
                    Task { @MainActor [weak self] in
                        guard let self, self.route?.authority === authority else { return }
                        self.stop()
                        await GatewayEndpointStore.shared.refresh()
                    }
                }
            }
            self.route = (target.hostname, authority, task)
        }
        guard let route = self.route else { throw CancellationError() }
        do {
            let (live, _) = try await route.task.value
            try route.authority.check()
            Self.published.withLock { $0 = (target.hostname.lowercased(), live) }
            return live
        } catch {
            if self.route?.authority === route.authority { self.stop() }
            throw error
        }
    }

    /// Retires the route; its tunnel, proxy and trust adapter close in the background.
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
            await resources.trustStore.close()
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
        target: MacNodeOpenClawIDTarget,
        generation: UInt64,
        authority: MacNodeOpenClawIDRouteAuthority,
        onInvalidated: @escaping @Sendable () -> Void) async throws
        -> (MacOpenClawIDOperatorLive, Resources)
    {
        let trustStore = OpenClawIDNodeNativeTrustStore(
            databaseURL: target.databaseURL,
            enrollmentID: target.enrollmentID,
            assertCurrent: { try authority.check() })
        do {
            guard let enrollment = try await trustStore.savedEnrollment(hostname: target.hostname),
                  enrollment.enrollmentID == target.enrollmentID
            else { throw OpenClawIDNodeEnrollmentError.notAdmitted }
            let node = try await OpenClawIDNodeIdentity.loadOrCreate(store: target.identityStore)
            let operatorIdentity = try await OpenClawIDNodeIdentity.loadOrCreate(
                store: OpenClawIDNodeIdentityKeychainStore(enrollmentID: target.enrollmentID, operatorKey: true))
            let client = OpenClawIDNodeEnrollmentClient(trustStore: trustStore)
            let verified = try await client.refresh(hostname: target.hostname, enrollment: enrollment, identity: node)
            guard let origin = URL(string: "wss://\(verified.hostname)/") else {
                throw OpenClawIDNodeEnrollmentError.wrongHost
            }
            try authority.check()
            let endpoint = try await OpenClawIDNodeNativeEndpoint.bind(
                identity: operatorIdentity, relayURL: verified.relayURL)
            let tunnel = MacNodeOpenClawIDTransport.makeTunnel(
                endpoint: endpoint,
                relayURL: verified.relayURL,
                verifiedTarget: {
                    let refreshed = try await client.refresh(
                        hostname: target.hostname, enrollment: enrollment, identity: node)
                    return (refreshed.serverKey, refreshed.relayURL)
                },
                onInvalidated: onInvalidated)
            do {
                let proxy = try await MacOpenClawIDDashboardProxy.start(
                    tunnel: tunnel, logicalOrigin: origin, onUnexpectedStop: onInvalidated)
                try authority.check()
                let live = MacOpenClawIDOperatorLive(
                    generation: generation,
                    logicalOrigin: origin,
                    sessionBox: WebSocketSessionBox(session: OpenClawIDNodeWebSocketSession(
                        tunnel: tunnel, logicalOrigin: origin, role: .operator)),
                    dashboardURL: proxy.baseURL,
                    dashboardCookie: proxy.cookie)
                return (live, Resources(tunnel: tunnel, proxy: proxy, trustStore: trustStore))
            } catch {
                await tunnel.shutdown()
                throw error
            }
        } catch {
            await trustStore.close()
            throw error
        }
    }
}
