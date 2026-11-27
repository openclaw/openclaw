import AppKit
import CryptoKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized)
@MainActor
struct DashboardTokenlessRouteTests {
    @Test(arguments: ["revision", "url", "reconnect"])
    func `accepted tokenless Primary routes recover with native challenge authority`(_ transition: String) async throws {
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let defaultsName = "DashboardTokenlessRouteTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let server = try await DashboardHTTPFixture.start()
            defer { server.stop() }
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: (server.websocketURL(), nil, nil), routeAuthority: nil,
                deviceAuthGatewayID: "tokenless-primary", revision: 0)
            let source = GatewayConnectionEndpointSource(endpoint: endpoint)
            let connection = GatewayConnection(
                endpointProvider: { source.snapshot() },
                currentEndpointRevision: { source.snapshot().revision ?? 0 },
                supportsSharedEndpointRecovery: false,
                activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: Self.nonsharedSession()))
            let ready: @Sendable () -> GatewayEndpointState = {
                let current = source.snapshot()
                return .ready(
                    mode: .remote, url: current.config.url, token: nil, password: nil,
                    routeRevision: current.revision ?? 0)
            }
            let manager = DashboardManager._testMake(
                selection: MacGatewaySelectionPreferences(defaults: defaults),
                authTokenProvider: { await connection.controlUiAutoAuthToken(config: $0) },
                connectionProvider: { _ in connection },
                browserIdentityURLProvider: nil,
                legacyCredentialsProvider: nil,
                routeProbe: { _ in
                    _ = try? await connection.request(method: "health", params: nil, retryTransportFailures: false)
                },
                endpointStateProvider: ready,
                automaticGatewayProfileRefreshEnabled: false,
                primaryEndpointProvider: { _ in source.snapshot() })
            let result: Result<Void, Error>
            do {
                await manager._testOpenWindow(for: .primary)
                let original = try #require(manager._testAuxiliaryWindows().first?.controller)
                try await waitForNativeDashboardDocument(original)
                let identity = DeviceIdentityStore.loadOrCreate()
                #expect(await connection.authSource() == GatewayAuthSource.none)
                #expect(await connection.controlUiAutoAuthToken(config: endpoint.config) == nil)
                #expect(original.auth.hasAcceptedNativeBinding)
                #expect(!original.auth.hasCredential)
                let originalProvider = try #require(original.documentHost.nativeGatewayAuthProvider)
                let originalReply = try await originalProvider("old-document", 122)

                switch transition {
                case "revision":
                    // A new accepted nonshared socket still need not export a token.
                    DeviceAuthStore.clearToken(
                        deviceId: identity.deviceId, role: "operator", gatewayID: "tokenless-primary")
                    source.setEndpoint(.init(
                        config: endpoint.config, routeAuthority: nil,
                        deviceAuthGatewayID: "tokenless-primary", revision: 1))
                    await manager.handleEndpointState(ready())
                    #expect(!originalReply.isCurrent())
                case "url":
                    // Returning from a same-origin route exercises the in-place URL-update branch.
                    original.update(url: server.url("/chat/"), auth: original.auth)
                    try await waitForNativeDashboardDocument(original)
                    await manager.handleEndpointState(ready())
                default:
                    await manager.handleEndpointState(.connecting(mode: .remote, detail: "Reconnecting"))
                    let failure = try #require(manager._testAuxiliaryWindows().first?.controller)
                    #expect(failure.isShowingFailurePage)
                    #expect(failure.documentHost.nativeGatewayAuthProvider == nil)
                    await manager._testHandleControlChannelStateChange(.connected)
                }
                let recovered = try #require(manager._testAuxiliaryWindows().first?.controller)
                #expect(recovered.currentURL == server.url())
                try #require(!recovered.isShowingFailurePage)
                #expect(transition == "url" ? recovered === original : recovered !== original)
                #expect(recovered.auth.hasAcceptedNativeBinding)
                #expect(!recovered.auth.hasCredential)
                #expect(await connection.authSource() == GatewayAuthSource.none)
                #expect(await connection.controlUiAutoAuthToken(config: endpoint.config) == nil)
                let startup = try await dashboardNativeAuthSnapshot(recovered)
                #expect(startup["nativeConnectAuth"] as? Bool == true)
                #expect(startup["token"] == nil)
                #expect(startup["password"] == nil)
                #expect(startup["deviceToken"] == nil)
                #expect(recovered.currentURL.fragment == nil)
                try scopeNativeDashboardIdentity(recovered.documentHost, stateDirectory: stateDir)
                let response = try await Self.challenge(recovered)
                let signed = try #require(response["result"] as? [String: Any])
                #expect(signed["auth"] as? [String: String] == ["deviceToken": "issued-native-grant"])
                #expect(signed["scopes"] as? [String] == ["operator.read"])
                let device = try #require(signed["device"] as? [String: Any])
                #expect(device["id"] as? String == identity.deviceId)
                let encoded = try #require(device["signature"] as? String)
                let signature = try #require(Data(base64Encoded: encoded
                        .replacingOccurrences(of: "-", with: "+")
                        .replacingOccurrences(of: "_", with: "/") + "=="))
                let key = try Curve25519.Signing.PublicKey(rawRepresentation: #require(
                    Data(base64Encoded: identity.publicKey)))
                let payload = "v2|\(identity.deviceId)|openclaw-macos|ui|operator|operator.read|123|issued-native-grant|challenge"
                #expect(key.isValidSignature(signature, for: Data(payload.utf8)))
                DeviceAuthStore.clearToken(
                    deviceId: identity.deviceId, role: "operator", gatewayID: "tokenless-primary")
                let revoked = try await Self.challenge(recovered)
                #expect(revoked["error"] as? String != nil)
                #expect(revoked["result"] == nil)
                result = .success(())
            } catch {
                result = .failure(error)
            }
            manager.close()
            NSWindow.removeFrame(usingName: manager.mainWindowAutosaveName)
            await connection.shutdown()
            try result.get()
        }
    }

    private static func challenge(_ controller: DashboardWindowController) async throws -> [String: Any] {
        let json = try #require(try await controller.webView.callAsyncJavaScript("""
        try {
          return JSON.stringify(await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
            id: 'request', nonce: 'challenge', signedAt: 123
          }));
        } catch (error) { return JSON.stringify({error:String(error)}); }
        """, in: nil, contentWorld: .page) as? String)
        return try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private static func nonsharedSession() -> GatewayTestWebSocketSession {
        GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(
                sendHook: { task, message, index in
                    guard index > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                },
                receiveHook: { task, index in
                    if index == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                    let data = GatewayWebSocketTestSupport.connectOkData(
                        id: task.snapshotConnectRequestID() ?? "connect",
                        deviceToken: "issued-native-grant", scopes: ["operator.read"])
                    var response = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
                    var payload = try #require(response["payload"] as? [String: Any])
                    var auth = try #require(payload["auth"] as? [String: Any])
                    auth["method"] = "none"
                    payload["auth"] = auth
                    response["payload"] = payload
                    return try .data(JSONSerialization.data(withJSONObject: response))
                })
        })
    }
}
