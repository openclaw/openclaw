import Foundation
import OpenClawKit
import Synchronization

/// Restart inputs select the existing enrollment and identity, never grant a dial.
struct MacNodeOpenClawIDTarget: Sendable {
    let hostname: String
    let enrollmentID: UUID
    let databaseURL: URL
    let identityStore: any OpenClawIDNodeIdentityStore
}

/// Synchronous guard shared with SQLite while the coordinator retires a route.
final class MacNodeOpenClawIDRouteAuthority: Sendable {
    private let current = Mutex(true)

    func revoke() {
        self.current.withLock { $0 = false }
    }

    func check() throws {
        try Task.checkCancellation()
        guard self.current.withLock({ $0 }) else { throw CancellationError() }
    }
}

/// Resources for one node route. The node coordinator owns their lifetime; operator
/// connections never receive this session or the node's identity.
final class MacNodeOpenClawIDTransport: Sendable {
    let logicalOrigin: URL
    let clawID: String
    let sessionBox: WebSocketSessionBox
    let workerGatewayURL: String
    private let tunnel: OpenClawIDNodeTunnel
    private let bridge: MacNodeOpenClawIDBridge
    private let trustStore: OpenClawIDNodeNativeTrustStore

    private init(
        logicalOrigin: URL,
        clawID: String,
        tunnel: OpenClawIDNodeTunnel,
        bridge: MacNodeOpenClawIDBridge,
        trustStore: OpenClawIDNodeNativeTrustStore)
    {
        self.logicalOrigin = logicalOrigin
        self.clawID = clawID
        self.trustStore = trustStore
        self.tunnel = tunnel
        self.bridge = bridge
        self.workerGatewayURL = bridge.gatewayURL
        self.sessionBox = WebSocketSessionBox(session: OpenClawIDNodeWebSocketSession(
            tunnel: tunnel, logicalOrigin: logicalOrigin))
    }

    /// Saved enrollment selects W and its pinned target, but is not dialing authority.
    /// The store's lifecycle guard remains authoritative throughout preparation.
    static func prepare(
        selection: MacNodeOpenClawIDTarget,
        authority: MacNodeOpenClawIDRouteAuthority,
        onInvalidated: @escaping @Sendable () -> Void) async throws -> MacNodeOpenClawIDTransport
    {
        let store = OpenClawIDNodeNativeTrustStore(
            databaseURL: selection.databaseURL,
            enrollmentID: selection.enrollmentID,
            assertCurrent: { try authority.check() })
        do {
            return try await self.prepare(
                selection: selection, trustStore: store, onInvalidated: onInvalidated)
        } catch {
            await store.close()
            throw error
        }
    }

    private static func prepare(
        selection: MacNodeOpenClawIDTarget,
        trustStore: OpenClawIDNodeNativeTrustStore,
        onInvalidated: @escaping @Sendable () -> Void) async throws -> MacNodeOpenClawIDTransport
    {
        let hostname = selection.hostname
        guard let enrollment = try await trustStore.savedEnrollment(hostname: hostname),
              enrollment.enrollmentID == selection.enrollmentID
        else {
            throw OpenClawIDNodeEnrollmentError.notAdmitted
        }
        let identity = try await OpenClawIDNodeIdentity.loadOrCreate(store: selection.identityStore)
        let client = OpenClawIDNodeEnrollmentClient(trustStore: trustStore)
        let target = try await client.refresh(hostname: hostname, enrollment: enrollment, identity: identity)
        guard let origin = URL(string: "wss://\(target.hostname)/") else {
            throw OpenClawIDNodeEnrollmentError.wrongHost
        }
        try Task.checkCancellation()
        let endpoint = try await OpenClawIDNodeNativeEndpoint.bind(identity: identity, relayURL: target.relayURL)
        let tunnel = self.makeTunnel(
            endpoint: endpoint,
            relayURL: target.relayURL,
            verifiedTarget: {
                let refreshed = try await client.refresh(hostname: hostname, enrollment: enrollment, identity: identity)
                return (refreshed.serverKey, refreshed.relayURL)
            }, onInvalidated: onInvalidated)
        do {
            let bridge = try await MacNodeOpenClawIDBridge.start(
                tunnel: tunnel,
                logicalOrigin: origin,
                onUnexpectedStop: onInvalidated)
            do {
                try Task.checkCancellation()
                return MacNodeOpenClawIDTransport(
                    logicalOrigin: origin,
                    clawID: target.state.clawID,
                    tunnel: tunnel,
                    bridge: bridge,
                    trustStore: trustStore)
            } catch {
                await bridge.shutdown()
                throw error
            }
        } catch {
            await tunnel.shutdown()
            throw error
        }
    }

    static func makeTunnel(
        endpoint: any OpenClawIDNodeEndpoint,
        relayURL: URL,
        verifiedTarget: @escaping @Sendable () async throws -> (serverKey: String, relayURL: URL),
        onInvalidated: @escaping @Sendable () -> Void) -> OpenClawIDNodeTunnel
    {
        OpenClawIDNodeTunnel(
            endpoint: endpoint,
            verifiedServerKey: {
                let refreshed = try await verifiedTarget()
                // The endpoint and tunnel bind one relay; the coordinator must replace both.
                guard refreshed.relayURL == relayURL else {
                    onInvalidated()
                    throw OpenClawIDNodeTransportError.closed
                }
                return refreshed.serverKey
            }, relayURL: relayURL)
    }

    func shutdown() async {
        // Release upstream reads before draining the local bridge's accepted handlers.
        await self.tunnel.shutdown()
        await self.bridge.shutdown()
        await self.trustStore.close()
    }
}
