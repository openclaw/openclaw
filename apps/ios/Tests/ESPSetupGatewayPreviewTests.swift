import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct ESPSetupGatewayPreviewTests {
    @Test(arguments: [false, true])
    func `fresh operator setup cannot survive authority loss and regrant`(revokeDuringRPC: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try await DeviceIdentityStore.withStateDirectory(directory) {
            let model = NodeAppModel()
            defer { model.disconnectGateway() }
            let stableID = "esp-preview-test"
            var options = GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions
            options.allowStoredDeviceAuth = false
            options.deviceAuthGatewayID = stableID
            let url = try #require(URL(string: "wss://gateway.example.com:443/openclaw"))
            model.activeGatewayConnectConfig = GatewayConnectConfig(
                url: url,
                stableID: stableID,
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: options)
            let identity = DeviceIdentityStore.loadOrCreate()
            #expect(DeviceAuthStore.storeTokenPersisted(
                deviceId: identity.deviceId,
                role: "operator",
                token: "fixture-operator-token",
                scopes: ["operator.admin"],
                gatewayID: stableID))
            let code = #"{"url":"wss://gateway.example.com:443/openclaw","urls":["wss://fallback.example.com:18789"],"bootstrapToken":"fixture-device-bootstrap"}"#
            let socket = GatewayTestWebSocketTask(sendHook: { socket, message, _ in
                guard GatewayWebSocketTestSupport.requestMethod(from: message) == "device.pair.setupCode"
                else { return }
                let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
                if revokeDuringRPC {
                    await MainActor.run {
                        model.apply(.dropped, to: .operator, route: nil)
                        model.apply(.connected(GatewaySessionInfo(hasAdminScope: true)), to: .operator, route: nil)
                    }
                }
                let reply = try JSONSerialization.data(withJSONObject: [
                    "type": "res", "id": id, "ok": true, "payload": ["setupCode": code],
                ])
                socket.emitReceiveSuccess(.data(reply))
            })
            try await model.operatorSession.connect(
                url: url,
                credentials: .init(),
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: GatewayTestWebSocketSession(taskFactory: { socket })),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
            model.apply(.connected(GatewaySessionInfo(hasAdminScope: true)), to: .operator, route: nil)
            let route = try #require(await model.operatorSession.currentRoute())
            if revokeDuringRPC {
                await #expect(throws: ESPSetupError.self) {
                    try await ESPSetupGatewayPreview.prepare(appModel: model)
                }
            } else {
                let preview = try await ESPSetupGatewayPreview.prepare(appModel: model)
                #expect(preview.link.connectionEndpoints.compactMap(\.websocketURL).map(\.absoluteString) == [
                    "wss://gateway.example.com:443/openclaw", "wss://fallback.example.com:18789",
                ])
                try await preview.authorize(appModel: model)
                DeviceAuthStore.clearToken(deviceId: identity.deviceId, role: "operator", gatewayID: stableID)
                model.apply(.connected(GatewaySessionInfo()), to: .operator, route: nil)
                await #expect(throws: ESPSetupError.self) { try await preview.authorize(appModel: model) }
            }
            #expect(await model.operatorSession.currentRoute() == route)
            #expect(model.activeGatewayConnectConfig?.url == url)
            await model.operatorSession.disconnect()
        }
    }
}
