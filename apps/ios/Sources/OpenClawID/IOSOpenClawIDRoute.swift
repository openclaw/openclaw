import Foundation
import OpenClawKit

/// This device's routes to its OpenClaw ID claw. The operator tunnel runs over the owner or member
/// key (W) and also serves the dashboard proxy; the node tunnel runs over W_node when this device
/// runs tools. Both re-verify the claw against its pin before every dial, and tunnel admission is
/// the Gateway's only authentication on them.
@MainActor
final class IOSOpenClawIDRoute {
    static let shared = IOSOpenClawIDRoute()

    /// Runs after the claw stops listing this device and its local state is gone.
    var onRemoved: (@MainActor () -> Void)?

    private var route: (device: OpenClawIDDevice, task: Task<Live, Error>)?

    struct Live: Sendable {
        let hostname: String
        let owner: Bool
        let tunnel: OpenClawIDNodeTunnel
        let operatorBox: WebSocketSessionBox
        let dashboard: OpenClawIDDashboardProxy
        let node: (tunnel: OpenClawIDNodeTunnel, box: WebSocketSessionBox)?
        let stores: [OpenClawIDNodeNativeTrustStore]

        func shutdown() async {
            await self.dashboard.shutdown()
            await self.tunnel.shutdown()
            await self.node?.tunnel.shutdown()
            for store in self.stores {
                await store.close()
            }
        }
    }

    static func stableID(_ hostname: String) -> String {
        "openclaw-id:\(hostname.lowercased())"
    }

    /// The Gateway config for the saved device, or nil when this device has no OpenClaw ID claw.
    func connectConfig(options: GatewayConnectOptions) async throws -> GatewayConnectConfig? {
        guard IOSOpenClawIDFeature.records.load() != nil else { return nil }
        let live = try await self.current()
        guard let url = URL(string: "wss://\(live.hostname)/") else {
            throw OpenClawIDNodeEnrollmentError.wrongHost
        }
        var config = GatewayConnectConfig(
            url: url,
            stableID: Self.stableID(live.hostname),
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)
        config.openClawIDOperatorSession = live.operatorBox
        config.openClawIDNodeSession = live.node?.box
        config.openClawIDOwner = live.owner
        config.openClawIDDashboard = (live.dashboard.baseURL, live.dashboard.cookie)
        return config
    }

    /// The live route for the saved device, prepared once and replaced when the device changes.
    func current() async throws -> Live {
        guard let device = IOSOpenClawIDFeature.records.load() else {
            throw OpenClawIDNodeEnrollmentError.notAdmitted
        }
        if let route, route.device != device { self.stop() }
        if self.route == nil {
            let session = IOSOpenClawIDFeature.records.session(for: device)
            let databaseURL = IOSOpenClawIDFeature.databaseURL
            self.route = (device, Task {
                try await Self.prepare(device: device, session: session, databaseURL: databaseURL) {
                    Task { @MainActor in await IOSOpenClawIDRoute.shared.removed(device) }
                }
            })
        }
        guard let route else { throw CancellationError() }
        do {
            return try await route.task.value
        } catch {
            if self.route?.task == route.task { self.route = nil }
            throw error
        }
    }

    /// Retires the route; its tunnels, proxy and trust stores close in the background.
    func stop() {
        guard let route else { return }
        self.route = nil
        route.task.cancel()
        Task { await (try? route.task.value)?.shutdown() }
    }

    /// Retires this device's local OpenClaw ID state once the claw no longer admits it.
    func removed(_ device: OpenClawIDDevice) async {
        let records = IOSOpenClawIDFeature.records
        guard records.load()?.deviceEnrollmentID == device.deviceEnrollmentID else { return }
        self.stop()
        records.save(nil)
        records.saveSession(nil)
        await OpenClawIDDeviceRecords.forgetKeys(device: device.deviceEnrollmentID, node: device.nodeEnrollmentID)
        self.onRemoved?()
    }

    private nonisolated static func prepare(
        device: OpenClawIDDevice,
        session: OpenClawIDDiscoverySession?,
        databaseURL: URL,
        onNotAdmitted: @escaping @Sendable () -> Void) async throws -> Live
    {
        guard let origin = URL(string: "wss://\(device.hostname)/") else {
            throw OpenClawIDNodeEnrollmentError.wrongHost
        }
        let peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
            enrollmentID: device.deviceEnrollmentID, purpose: .devicePeer))
        var node: OpenClawIDNodeIdentity?
        if let nodeID = device.nodeEnrollmentID {
            node = try await OpenClawIDNodeIdentity.loadOrCreate(
                store: OpenClawIDNodeIdentityKeychainStore(enrollmentID: nodeID, purpose: .node))
        }
        let store = OpenClawIDNodeNativeTrustStore(
            databaseURL: databaseURL, enrollmentID: device.deviceEnrollmentID, assertCurrent: {})
        var stores = [store]
        var tunnels: [OpenClawIDNodeTunnel] = []
        do {
            // W_node signs the claw's descriptor read, so a device that runs tools keeps reaching
            // its claw after the Discovery session ends.
            let signingNode = node
            let verify: @Sendable () async throws -> OpenClawIDNodeTrustTarget = {
                do {
                    return try await OpenClawIDDeviceRoute.refresh(
                        hostname: device.hostname,
                        discoveryOrigin: device.discoveryOrigin,
                        peer: peer,
                        admission: device.admission,
                        node: signingNode,
                        session: session,
                        store: store)
                } catch OpenClawIDNodeEnrollmentError.notAdmitted {
                    onNotAdmitted()
                    throw OpenClawIDNodeEnrollmentError.notAdmitted
                }
            }
            let relayURL = try await verify().relayURL
            let tunnel = try await Self.tunnel(identity: peer, relayURL: relayURL) { try await verify() }
            tunnels.append(tunnel)
            var nodeRoute: (tunnel: OpenClawIDNodeTunnel, box: WebSocketSessionBox)?
            if let node, let nodeID = device.nodeEnrollmentID {
                let nodeStore = OpenClawIDNodeNativeTrustStore(
                    databaseURL: databaseURL, enrollmentID: nodeID, assertCurrent: {})
                stores.append(nodeStore)
                guard let enrollment = try await nodeStore.savedEnrollment(hostname: device.hostname) else {
                    throw OpenClawIDNodeEnrollmentError.notAdmitted
                }
                let client = OpenClawIDNodeEnrollmentClient(trustStore: nodeStore)
                let target = try await client.refresh(hostname: device.hostname, enrollment: enrollment, identity: node)
                let nodeTunnel = try await Self.tunnel(identity: node, relayURL: target.relayURL) {
                    try await client.refresh(hostname: device.hostname, enrollment: enrollment, identity: node)
                }
                tunnels.append(nodeTunnel)
                nodeRoute = (tunnel: nodeTunnel, box: WebSocketSessionBox(session: OpenClawIDNodeWebSocketSession(
                    tunnel: nodeTunnel, logicalOrigin: origin, role: .node)))
            }
            let dashboard = try await OpenClawIDDashboardProxy.start(
                tunnel: tunnel, logicalOrigin: origin, onUnexpectedStop: {
                    Task { @MainActor in IOSOpenClawIDRoute.shared.stop() }
                })
            return Live(
                hostname: device.hostname,
                owner: device.memberRole == nil,
                tunnel: tunnel,
                operatorBox: WebSocketSessionBox(session: OpenClawIDNodeWebSocketSession(
                    tunnel: tunnel, logicalOrigin: origin, role: .operator)),
                dashboard: dashboard,
                node: nodeRoute,
                stores: stores)
        } catch {
            for tunnel in tunnels {
                await tunnel.shutdown()
            }
            for store in stores {
                await store.close()
            }
            throw error
        }
    }

    private nonisolated static func tunnel(
        identity: OpenClawIDNodeIdentity,
        relayURL: URL,
        verify: @escaping @Sendable () async throws -> OpenClawIDNodeTrustTarget) async throws -> OpenClawIDNodeTunnel
    {
        let endpoint = try await OpenClawIDNodeNativeEndpoint.bind(identity: identity, relayURL: relayURL)
        return OpenClawIDNodeTunnel(
            endpoint: endpoint,
            verifiedServerKey: {
                let refreshed = try await verify()
                // The endpoint binds one relay; a moved relay needs a new route.
                guard refreshed.relayURL == relayURL else {
                    Task { @MainActor in IOSOpenClawIDRoute.shared.stop() }
                    throw OpenClawIDNodeTransportError.closed
                }
                return refreshed.serverKey
            },
            relayURL: relayURL)
    }
}
