import Foundation
import OpenClawKit

/// This device's chat route to its OpenClaw ID claw: the iroh tunnel over the owner or member key
/// (W), re-verified against the pinned claw before every dial. The Gateway connection runs its
/// operator session through the tunnel; tunnel admission is its only authentication.
@MainActor
final class IOSOpenClawIDRoute {
    static let shared = IOSOpenClawIDRoute()

    private var route: (enrollmentID: UUID, task: Task<Live, Error>)?

    struct Live: Sendable {
        let hostname: String
        let tunnel: OpenClawIDNodeTunnel
        let store: OpenClawIDNodeNativeTrustStore
        let operatorBox: WebSocketSessionBox
    }

    /// The Gateway config for the saved device, or nil when this device has no OpenClaw ID claw.
    func connectConfig(options: GatewayConnectOptions) async throws -> GatewayConnectConfig? {
        let records = IOSOpenClawIDFeature.records
        guard let device = records.load() else { return nil }
        if let route, route.enrollmentID != device.deviceEnrollmentID { self.stop() }
        if self.route == nil {
            let session = records.session(for: device)
            let databaseURL = IOSOpenClawIDFeature.databaseURL
            self.route = (device.deviceEnrollmentID, Task {
                try await Self.prepare(device: device, session: session, databaseURL: databaseURL)
            })
        }
        guard let route else { throw CancellationError() }
        let live: Live
        do {
            live = try await route.task.value
        } catch {
            if self.route?.task == route.task { self.route = nil }
            throw error
        }
        guard let url = URL(string: "wss://\(live.hostname)/") else { throw OpenClawIDNodeEnrollmentError.wrongHost }
        var config = GatewayConnectConfig(
            url: url,
            stableID: Self.stableID(live.hostname),
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: options)
        config.openClawIDOperatorSession = live.operatorBox
        return config
    }

    static func stableID(_ hostname: String) -> String {
        "openclaw-id:\(hostname.lowercased())"
    }

    /// Retires the route; its tunnel and trust store close in the background.
    func stop() {
        guard let route else { return }
        self.route = nil
        route.task.cancel()
        Task {
            guard let live = try? await route.task.value else { return }
            await live.tunnel.shutdown()
            await live.store.close()
        }
    }

    private nonisolated static func prepare(
        device: OpenClawIDDevice,
        session: OpenClawIDDiscoverySession?,
        databaseURL: URL) async throws -> Live
    {
        let peer = try await OpenClawIDNodeIdentity.loadOrCreate(store: OpenClawIDNodeIdentityKeychainStore(
            enrollmentID: device.deviceEnrollmentID, purpose: .devicePeer))
        let store = OpenClawIDNodeNativeTrustStore(
            databaseURL: databaseURL, enrollmentID: device.deviceEnrollmentID, assertCurrent: {})
        let verify: @Sendable () async throws -> OpenClawIDNodeTrustTarget = {
            try await OpenClawIDDeviceRoute.refresh(
                hostname: device.hostname,
                discoveryOrigin: device.discoveryOrigin,
                peer: peer,
                admission: device.admission,
                node: nil,
                session: session,
                store: store)
        }
        do {
            let relayURL = try await verify().relayURL
            guard let origin = URL(string: "wss://\(device.hostname)/") else {
                throw OpenClawIDNodeEnrollmentError.wrongHost
            }
            let endpoint = try await OpenClawIDNodeNativeEndpoint.bind(identity: peer, relayURL: relayURL)
            let tunnel = OpenClawIDNodeTunnel(
                endpoint: endpoint,
                verifiedServerKey: {
                    let refreshed = try await verify()
                    // The endpoint binds one relay; a moved relay needs a new route.
                    guard refreshed.relayURL == relayURL else { throw OpenClawIDNodeTransportError.closed }
                    return refreshed.serverKey
                },
                relayURL: relayURL)
            return Live(
                hostname: device.hostname,
                tunnel: tunnel,
                store: store,
                operatorBox: WebSocketSessionBox(session: OpenClawIDNodeWebSocketSession(
                    tunnel: tunnel, logicalOrigin: origin, role: .operator)))
        } catch {
            await store.close()
            throw error
        }
    }
}
