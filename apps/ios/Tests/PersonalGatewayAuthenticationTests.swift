import CryptoKit
import Foundation
import JavaScriptCore
import OpenClawChatUI
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct PersonalGatewayAuthenticationTests {
    private let personalRecoveryScope = "synthetic-personal-recovery-scope"

    private func config(personal: Bool) throws -> GatewayConnectConfig {
        try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.example.ts.net")),
            stableID: "manual|gateway.example.ts.net|443",
            tls: nil,
            token: "synthetic-shared-token",
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: [], permissions: [:],
                clientId: "ios", clientMode: "node", clientDisplayName: "Phone",
                deviceAuthGatewayID: "manual|gateway.example.ts.net|443"),
            personalTailscaleAuthentication: personal)
    }

    private func personalConfig(url: URL) -> GatewayConnectConfig {
        let stableID = "personal-auth-\(UUID().uuidString)"
        let options = GatewayConnectOptions(
            role: "operator", scopes: [], caps: [], commands: [], permissions: [:],
            clientId: "ios", clientMode: "ui", clientDisplayName: "Phone",
            includeDeviceIdentity: true, allowStoredDeviceAuth: false,
            deviceAuthGatewayID: stableID)
        return GatewayConnectConfig(
            url: url, stableID: stableID, tls: nil, token: "synthetic-shared-token",
            bootstrapToken: nil, password: nil, nodeOptions: options,
            personalTailscaleAuthentication: true)
    }

    private func connectPersonalOperator(model: NodeAppModel, config: GatewayConnectConfig) async throws {
        model.activeGatewayConnectConfig = config
        try await model.operatorSession.connect(
            url: config.url,
            credentials: config.operatorCredentials(fallback: GatewayNodeSessionCredentials(
                token: config.token, bootstrapToken: config.bootstrapToken, password: config.password)),
            connectOptions: config.operatorOptions(from: config.nodeOptions),
            sessionBox: nil,
            onConnected: { await model.setOperatorConnected(true) },
            onDisconnected: { _ in await model.setOperatorConnected(false) },
            onInvoke: { BridgeInvokeResponse(id: $0.id, ok: true) })
    }

    private func withConnectedPersonalOperator(
        model: NodeAppModel,
        config: GatewayConnectConfig,
        operation: () async throws -> Void) async throws
    {
        do {
            try await self.connectPersonalOperator(model: model, config: config)
            try await operation()
            await model.operatorSession.disconnect()
        } catch {
            await model.operatorSession.disconnect()
            throw error
        }
    }

    private func decodeBase64URL(_ value: String) -> Data? {
        var base64 = value.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while !base64.count.isMultiple(of: 4) {
            base64.append("=")
        }
        return Data(base64Encoded: base64)
    }

    @Test(arguments: [false, true])
    func `personal selection only changes operator authentication`(personal: Bool) throws {
        let config = try self.config(personal: personal)
        let credentials = config.operatorCredentials(fallback: .init(token: config.token))
        #expect(credentials.token == (personal ? nil : config.token))
        let options = config.operatorOptions(from: config.nodeOptions)
        #expect(options.requiredAuthMethod == (personal ? .tailscale : nil))
        #expect(options.deviceAuthGatewayID == config.nodeOptions.deviceAuthGatewayID)
        #expect(options.allowStoredDeviceAuth == !personal)
        #expect(config.nodeOptions.allowStoredDeviceAuth)
        #expect(config.nodeOptions.requiredAuthMethod == nil)
    }

    @Test(arguments: [false, true])
    func `embedded pages preserve the selected authentication without exporting personal credentials`(
        personal: Bool) throws
    {
        let config = try self.config(personal: personal)
        let url = try #require(AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: []))
        #expect(ControlUIHubPage.terminal.url(config: config) != nil)
        #expect(ControlUIHubPage.desktop(source: nil, session: nil).url(config: config) != nil)
        #expect(SessionDashboardScreen.dashboardURL(config: config, sessionKey: "agent:main:chat") != nil)
        let script = try #require(AuthenticatedControlUI.authUserScript(
            config: config, pageURL: url, storedOperatorToken: "synthetic-paired-grant"))
        let context = try #require(JSContext())
        context.evaluateScript("var window = {}; var location = {origin: 'https://gateway.example.ts.net'};")
        context.evaluateScript(script)
        #expect(context.exception == nil)
        let auth = try #require(context.evaluateScript("window.__OPENCLAW_NATIVE_CONTROL_AUTH__")?.toDictionary())
        #expect(auth["gatewayUrl"] as? String == config.url.absoluteString)
        if personal {
            #expect(auth["nativeConnectAuth"] as? Bool == true)
            #expect(auth["token"] == nil)
            #expect(auth["password"] == nil)
            #expect(AuthenticatedControlUI.storedOperatorToken(config: config) == nil)
        } else {
            #expect(auth["token"] as? String == "synthetic-shared-token")
        }
    }

    @Test func `personal mode cannot create a legacy persistent transcript or outbox`() throws {
        let model = NodeAppModel()
        model.activeGatewayConnectConfig = try self.config(personal: true)
        #expect(model.chatTranscriptCacheGatewayID == nil)
        #expect(model.makeChatOfflineStore() == nil)
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: "manual|gateway.example.ts.net|443")
        let owner = model.chatViewModelOwnerID
        model.setOperatorConnected(false)
        #expect(model.chatViewModelOwnerID == owner)
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: "manual|gateway.example.ts.net|443")
        #expect(model.chatViewModelOwnerID == owner)
        model.adoptPersonalChatOwner(scope: "synthetic-person-b", stableID: "manual|gateway.example.ts.net|443")
        #expect(model.chatViewModelOwnerID != owner)
        #expect(model.makeChatOfflineStore() == nil)
    }

    @Test(arguments: [false, true])
    func `native Dashboard bridge refuses foreign documents and retires lost authority`(
        foreignOrigin: Bool) async throws
    {
        let config = try self.config(personal: true)
        let url = try #require(AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: []))
        let fixture =
            DashboardDocumentFixture(url: foreignOrigin ? URL(string: "https://foreign.example/settings")! : url)
        let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        model.activeGatewayConnectConfig = config
        model.setOperatorConnected(true)
        let bridge = IOSPersonalGatewayAuthBridge(appModel: model, config: config, url: url)
        let controller = fixture.webView.configuration.userContentController
        controller.addScriptMessageHandler(bridge, contentWorld: .page, name: IOSPersonalGatewayAuthBridge.name)
        bridge.attach(to: fixture.webView)
        defer {
            bridge.detach()
            controller.removeScriptMessageHandler(forName: IOSPersonalGatewayAuthBridge.name, contentWorld: .page)
        }
        bridge.startNavigation()
        _ = try await fixture.load(hasEmbedMarker: true)
        bridge.commitNavigation()
        let response = try await fixture.webView.callAsyncJavaScript(
            """
            try {
              return await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
                id: 'synthetic-request', nonce: 'synthetic-challenge', signedAt: Date.now()
              });
            } catch (error) { return { rejected: String(error) }; }
            """,
            arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
        let reply = try #require(response)
        #expect(reply["result"] == nil)
        if foreignOrigin {
            #expect((reply["rejected"] as? String)?.contains("Invalid native Gateway") == true)
        } else {
            #expect(reply["error"] as? String == "Personal sign-in is unavailable. Reconnect in the app.")
        }
        model.setOperatorConnected(false)
        try await waitForDashboardCondition { !fixture.webView.isLoading && fixture.webView.url?.host == nil }
        let body = try await fixture.webView.evaluateJavaScript("document.body.textContent") as? String
        #expect(body?.contains("Personal sign-in changed") == true)
    }

    @Test
    func `personal Dashboard bridge returns a signed challenge after users self verifies the profile`() async throws {
        let stateDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("personal-gateway-auth-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDirectory) }
        try await DeviceIdentityStore.withStateDirectory(stateDirectory) {
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                authMethod: "tailscale",
                recoveryScope: self.personalRecoveryScope,
                manualResponseMethods: ["users.self"])
            defer { fixture.stop() }

            let config = self.personalConfig(url: fixture.url())
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            try await self.withConnectedPersonalOperator(model: model, config: config) {
                #expect(model.isOperatorGatewayConnected)
                let route = try #require(await model.operatorSession.currentRoute(
                    ifGatewayID: config.effectiveStableID))
                #expect(await model.operatorSession.currentAuthRecoveryScope(ifCurrentRoute: route) ==
                    self.personalRecoveryScope)

                let url = try #require(
                    AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: []))
                let document = DashboardDocumentFixture(url: url)
                let bridge = IOSPersonalGatewayAuthBridge(appModel: model, config: config, url: url)
                let controller = document.webView.configuration.userContentController
                controller.addScriptMessageHandler(
                    bridge, contentWorld: .page, name: IOSPersonalGatewayAuthBridge.name)
                bridge.attach(to: document.webView)
                defer {
                    bridge.detach()
                    controller.removeScriptMessageHandler(
                        forName: IOSPersonalGatewayAuthBridge.name, contentWorld: .page)
                }
                bridge.startNavigation()
                _ = try await document.load(hasEmbedMarker: true)
                bridge.commitNavigation()

                let requestID = "synthetic-personal-request"
                let nonce = "synthetic-personal-challenge"
                let signedAtMs: Int64 = 1_800_000_000_000
                let replyDataTask = Task<Data?, Error> { @MainActor in
                    let reply = try await document.webView.callAsyncJavaScript(
                        """
                        return await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
                          id: '\(requestID)', nonce: '\(nonce)', signedAt: \(signedAtMs)
                        });
                        """,
                        arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
                    guard let reply, JSONSerialization.isValidJSONObject(reply) else { return nil }
                    return try JSONSerialization.data(withJSONObject: reply)
                }
                let rpc = try await fixture.waitForRPC(method: "users.self")
                #expect(rpc.method == "users.self")
                #expect(rpc.id.isEmpty == false)
                #expect(rpc.params?.isEmpty == true)
                #expect(fixture.capturedRPC(at: rpc.index)?.id == rpc.id)
                #expect(fixture.respond(to: rpc, payload: ["profile": ["id": "synthetic-person-a"]]))

                let replyData = try #require(try await replyDataTask.value)
                let reply = try #require(try JSONSerialization.jsonObject(with: replyData) as? [String: Any])
                #expect(reply["id"] as? String == requestID)
                #expect(reply["error"] == nil)
                let result = try #require(reply["result"] as? [String: Any])
                #expect(result["requiredAuthMethod"] as? String == "tailscale")
                #expect(result["expectedRecoveryScope"] as? String == self.personalRecoveryScope)
                let scopes = try #require(await model.operatorSession.currentOperatorScopes(ifCurrentRoute: route))
                #expect(result["scopes"] as? [String] == scopes.sorted())

                let device = try #require(result["device"] as? [String: Any])
                let deviceID = try #require(device["id"] as? String)
                let publicKey = try #require(device["publicKey"] as? String)
                let publicKeyData = try #require(self.decodeBase64URL(publicKey))
                // Verify the returned ID/key/signature agree; this does not prove identity-store lineage.
                let derivedDeviceID = SHA256.hash(data: publicKeyData)
                    .compactMap { String(format: "%02x", $0) }
                    .joined()
                #expect(deviceID == derivedDeviceID)
                #expect(device["signedAt"] as? Int == Int(signedAtMs))
                #expect(device["nonce"] as? String == nonce)
                let signature = try #require(self.decodeBase64URL(device["signature"] as? String ?? ""))
                let signingKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
                let fields = GatewayDeviceAuthPayload.Fields(
                    deviceId: deviceID,
                    client: .init(id: config.nodeOptions.clientId, mode: "ui"),
                    role: "operator",
                    scopes: scopes.sorted(),
                    signedAtMs: signedAtMs,
                    token: nil,
                    nonce: nonce)
                let payload = GatewayDeviceAuthPayload.buildConnectCompatibilityPayload(fields: fields)
                #expect(signingKey.isValidSignature(signature, for: Data(payload.utf8)))
            }
        }
    }

    @Test
    func `personal Dashboard bridge drops a pending signed result when operator authority is revoked`() async throws {
        let stateDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("personal-gateway-auth-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: stateDirectory) }
        try await DeviceIdentityStore.withStateDirectory(stateDirectory) {
            let fixture = try await NativeGatewayWebSocketFixture.start(
                issuedDeviceTokens: [],
                authMethod: "tailscale",
                recoveryScope: self.personalRecoveryScope,
                manualResponseMethods: ["users.self"])
            defer { fixture.stop() }

            let config = self.personalConfig(url: fixture.url())
            let model = NodeAppModel(audioAdmissionInitiallyAllowed: false)
            try await self.withConnectedPersonalOperator(model: model, config: config) {
                #expect(model.isOperatorGatewayConnected)
                let route = try #require(await model.operatorSession.currentRoute(
                    ifGatewayID: config.effectiveStableID))
                #expect(await model.operatorSession.currentAuthRecoveryScope(ifCurrentRoute: route) ==
                    self.personalRecoveryScope)

                let url = try #require(
                    AuthenticatedControlUI.pageURL(config: config, path: "settings", queryItems: []))
                let document = DashboardDocumentFixture(url: url)
                let bridge = IOSPersonalGatewayAuthBridge(appModel: model, config: config, url: url)
                let controller = document.webView.configuration.userContentController
                controller.addScriptMessageHandler(
                    bridge, contentWorld: .page, name: IOSPersonalGatewayAuthBridge.name)
                bridge.attach(to: document.webView)
                defer {
                    bridge.detach()
                    controller.removeScriptMessageHandler(
                        forName: IOSPersonalGatewayAuthBridge.name, contentWorld: .page)
                }
                bridge.startNavigation()
                _ = try await document.load(hasEmbedMarker: true)
                bridge.commitNavigation()

                let hasSignedResultTask = Task { @MainActor in
                    guard let reply = try? await document.webView.callAsyncJavaScript(
                        """
                        try {
                          return await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
                            id: 'synthetic-revoked-request',
                            nonce: 'synthetic-revoked-challenge',
                            signedAt: 1800000000000
                          });
                        } catch (error) { return { rejected: String(error) }; }
                        """,
                        arguments: [:], in: nil, contentWorld: .page) as? [String: Any]
                    else { return false }
                    return reply["result"] != nil
                }
                let rpc = try await fixture.waitForRPC(method: "users.self")
                #expect(rpc.params?.isEmpty == true)

                model.setOperatorConnected(false)
                try await waitForDashboardCondition {
                    !document.webView.isLoading && document.webView.url?.host == nil
                }
                let body = try await document.webView.evaluateJavaScript("document.body.textContent") as? String
                #expect(body?.contains("Personal sign-in changed") == true)
                #expect(fixture.respond(to: rpc, payload: ["profile": ["id": "synthetic-person-a"]]))
                #expect(await hasSignedResultTask.value == false)
            }
        }
    }

    @Test func `old saved gateways retain shared-owner authentication`() throws {
        let entry = try JSONDecoder().decode(
            GatewaySettingsStore.GatewayRegistryEntry.self,
            from: Data(
                #"{"stableID":"manual|gateway.example.ts.net|443","kind":"manual","name":"Gateway","host":"gateway.example.ts.net","port":443,"useTLS":true}"#
                    .utf8))
        #expect(entry.personalTailscaleAuthentication == nil)
    }

    @Test(arguments: [false, true])
    func `personal draft survives reconnect but cannot retain another person's authority`(changesPerson: Bool) throws {
        let model = NodeAppModel()
        model.enterScreenshotFixtureMode()
        let config = try self.config(personal: true)
        model.activeGatewayConnectConfig = config
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: config.effectiveStableID)
        let owner = model.chatPresentation
        owner.sync(appModel: model)
        let original = try #require(owner.viewModel)
        defer { owner.viewModel?.detachTransport() }
        original.input = "Synthetic draft"
        let attachment = OpenClawPendingAttachment(
            url: nil, data: Data("fixture".utf8), fileName: "fixture.txt", mimeType: "text/plain", preview: nil)
        original.attachments = [attachment]
        model.setOperatorConnected(false)
        model.adoptPersonalChatOwner(
            scope: changesPerson ? "synthetic-person-b" : "synthetic-person-a", stableID: config.effectiveStableID)
        owner.sync(appModel: model)
        #expect(owner.viewModel === original)
        #expect(original.input == "Synthetic draft")
        #expect(original.attachments.map(\.id) == [attachment.id])
        #expect(original.isQuestionAuthorityRetired == changesPerson)
        original.removeAttachment(attachment.id)
        owner.sync(appModel: model)
        let current = try #require(owner.viewModel)
        #expect((current === original) == !changesPerson)
        #expect(current.input == (changesPerson ? "" : "Synthetic draft"))
    }

    @Test func `explicit personal mode retirement clears the verified draft owner`() throws {
        let model = NodeAppModel()
        let config = try self.config(personal: true)
        model.activeGatewayConnectConfig = config
        model.adoptPersonalChatOwner(scope: "synthetic-person-a", stableID: config.effectiveStableID)
        let previousOwner = model.chatViewModelOwnerID
        model.activeGatewayConnectConfig = nil
        model.activeGatewayConnectConfig = config
        #expect(model.chatViewModelOwnerID != previousOwner)
    }

    @Test func `personal Watch admission rejects before taking durable custody`() async throws {
        let model = NodeAppModel()
        model.activeGatewayConnectConfig = try self.config(personal: true)
        let commandID = UUID().uuidString
        let context = OpenClawWatchChatDeliveryContext(
            gatewayStableID: "manual|gateway.example.ts.net|443", routeGeneration: UUID().uuidString,
            agentId: "main", sessionKey: "main", deliverySessionKey: "agent:main:main",
            sessionRoutingContract: "synthetic-routing-contract")
        let command = OpenClawWatchChatDeliveryCommand(
            context: context, commandId: commandID, submittedAtMs: WatchMessagingPayloadCodec.nowMs(),
            body: .chat(text: "Synthetic Watch work"))
        do {
            try await model.admitWatchChatDelivery(command)
            Issue.record("Personal mode must reject machine-owned Watch work")
        } catch let error as WatchMessagingError {
            guard case .admissionUnavailable = error else {
                Issue.record("Unexpected Watch admission error")
                return
            }
        }
        #expect(model.watchChatDeliveryWarning == nil)
    }
}
