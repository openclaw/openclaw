import AppKit
import ConcurrencyExtras
import Foundation
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
private final class ConversationAuthDocumentReady: NSObject, WKScriptMessageHandler {
    let loaded = AsyncTestGate()

    func userContentController(_: WKUserContentController, didReceive _: WKScriptMessage) {
        self.loaded.open()
    }
}

/// Keep the retiring page alive to exercise the interval before WebKit's blank commit.
@MainActor
private final class ConversationAuthRetirementNavigation: NSObject, WKNavigationDelegate {
    func webView(
        _: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        decisionHandler(navigationAction.request.url?.absoluteString == "about:blank" ? .cancel : .allow)
    }
}

/// Runs only in the disposable macOS runner; owns its HTTP, native socket, identity and WebKit state.
@Suite(.serialized)
@MainActor
struct ControlUIDocumentNativeAuthTests {
    @Test func `conversation factory signs with native authority and retires replies before blank commit`() async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start(
            html: """
            <html><body><script>
            Object.defineProperty(window, '__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__', {
              value: {contract:1, documentId:crypto.randomUUID()}
            });
            window.webkit.messageHandlers.openclawConversation.postMessage({
              contract:1, documentId:window.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__.documentId,
              type:'ready', surface:'conversation', capabilities:[]
            }).then(reply => {
              if (reply.ok) window.webkit.messageHandlers.fixtureReady.postMessage({});
            });
            </script></body></html>
            """, contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let defaultsName = "ConversationAuthTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: (server.websocketURL("/control/"), "accepted-native-token", nil),
                routeAuthority: 1, deviceAuthGatewayID: "conversation-fixture", revision: 1)
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0,
                              let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        return .data(GatewayWebSocketTestSupport.connectOkData(
                            id: task.snapshotConnectRequestID() ?? "connect", scopes: ["operator.read"]))
                    })
            })
            let connection = GatewayConnection(
                endpointProvider: { endpoint }, currentEndpointRevision: { 1 },
                supportsSharedEndpointRecovery: false, activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: session))
            var outcome: Result<Void, Error>
            var hostedBridge: NativeConversationBridge?
            var pendingReply: Task<String, Error>?
            do {
                let manager = DashboardManager._testMake(
                    selection: MacGatewaySelectionPreferences(defaults: defaults),
                    connectionProvider: { _ in connection }, browserIdentityURLProvider: nil,
                    legacyCredentialsProvider: nil, automaticGatewayProfileRefreshEnabled: false,
                    profileEndpointProvider: { _ in endpoint })
                defer { manager.close() }
                let ready = ConversationAuthDocumentReady()
                let handler = NativeConversationMessageHandler()
                let document = try await manager.conversationDocument(
                    for: .profile("conversation-fixture"))
                { controller, _ in
                    controller.add(ready, name: "fixtureReady")
                    controller.addScriptMessageHandler(
                        handler, contentWorld: .page, name: NativeConversationContract.handlerName)
                }
                try scopeNativeDashboardIdentity(document, stateDirectory: stateDir)
                let bridge = NativeConversationBridge(document: document)
                handler.owner = bridge
                hostedBridge = bridge
                bridge.load(server.url("/control/chat/main"))
                try await AsyncTimeout.withTimeout(
                    seconds: 5, onTimeout: { URLError(.timedOut) }, operation: { await ready.loaded.wait() })
                let bootstrap = try #require(try await document.webView.evaluateJavaScript(
                    "window.__OPENCLAW_NATIVE_CONTROL_AUTH__") as? [String: Any])
                #expect(bootstrap["nativeConnectAuth"] as? Bool == true)
                #expect(bootstrap["token"] as? String == "accepted-native-token")
                #expect(document.currentURL.fragment == nil)
                let accepted = try await Self.decodeReply(Self.challenge(in: document.webView))
                let result = try #require(accepted["result"] as? [String: Any], "Native auth reply: \(accepted)")
                #expect(result["auth"] as? [String: String] == ["token": "accepted-native-token"])
                #expect(result["scopes"] as? [String] == ["operator.read"])
                let device = try #require(result["device"] as? [String: Any])
                #expect(device["id"] as? String == identity.deviceId)
                #expect(device["nonce"] as? String == "conversation-challenge")
                #expect(session.snapshotMakeCount() == 1)

                let provider = try #require(document.nativeGatewayAuthProvider)
                let requested = AsyncTestGate()
                let release = AsyncTestGate()
                defer { release.open() }
                let calls = LockIsolated(0)
                document.nativeGatewayAuthProvider = { nonce, signedAt in
                    calls.withValue { $0 += 1 }
                    let reply = try await provider(nonce, signedAt)
                    requested.open()
                    await release.wait()
                    return reply
                }
                let pending = Task { try await Self.challenge(in: document.webView) }
                pendingReply = pending
                try await AsyncTimeout.withTimeout(
                    seconds: 5, onTimeout: { URLError(.timedOut) }, operation: { await requested.wait() })
                let retirement = ConversationAuthRetirementNavigation()
                defer { withExtendedLifetime(retirement) {} }
                document.webView.navigationDelegate = retirement
                bridge.close()
                release.open()
                let retired = try await Self.decodeReply(pending.value)
                #expect(retired["error"] as? String != nil)
                #expect(retired["result"] == nil)
                // The fixture deliberately retains the old page. A new request
                // must also be denied, not just the earlier in-flight reply.
                let refused = try await Self.decodeReply(Self.challenge(in: document.webView))
                #expect(refused["error"] as? String != nil)
                #expect(calls.value == 1)
                outcome = .success(())
            } catch {
                outcome = .failure(error)
            }
            _ = await pendingReply?.result
            if let bridge = hostedBridge {
                let shutdown = AsyncTestGate()
                bridge.document.webView.navigationDelegate = bridge
                bridge.close { shutdown.open() }
                // Retry the blank load that the retirement fixture deliberately held.
                bridge.document.webView.loadHTMLString("", baseURL: nil)
                do {
                    try await AsyncTimeout.withTimeout(
                        seconds: 5, onTimeout: { URLError(.timedOut) }, operation: { await shutdown.wait() })
                } catch {
                    if case .success = outcome { outcome = .failure(error) }
                }
            }
            await connection.shutdown()
            try outcome.get()
        }
    }

    @Test func `socket retirement clears dashboard and conversation startup scripts without replacing routes`() async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let defaultsName = "StartupAuthTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: (server.websocketURL("/control/"), "accepted-startup-token", nil),
                routeAuthority: 1, deviceAuthGatewayID: "startup-fixture", revision: 1)
            let session = GatewayTestWebSocketSession(taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0,
                              let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                        return .data(GatewayWebSocketTestSupport.connectOkData(
                            id: task.snapshotConnectRequestID() ?? "connect", scopes: ["operator.read"]))
                    })
            })
            let connection = GatewayConnection(
                endpointProvider: { endpoint }, currentEndpointRevision: { 1 },
                supportsSharedEndpointRecovery: false, activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: session))
            let manager = DashboardManager._testMake(
                selection: MacGatewaySelectionPreferences(defaults: defaults),
                connectionProvider: { _ in connection }, browserIdentityURLProvider: nil,
                legacyCredentialsProvider: nil, automaticGatewayProfileRefreshEnabled: false,
                primaryEndpointProvider: { _ in endpoint }, profileEndpointProvider: { _ in endpoint })
            defer { manager.close() }
            let outcome: Result<Void, Error>
            do {
                try await manager.show()
                let controller = try #require(manager._testController())
                try await waitForNativeDashboardDocument(controller)
                let conversation = try await manager.conversationDocument(for: .profile("startup-fixture")) { _, _ in }
                let documents = [controller.documentHost, conversation]
                let window = controller.window
                #expect(manager.immediateResolvedDashboardAuth(url: controller.currentURL, endpoint: endpoint) != nil)
                let before = try await dashboardNativeAuthSnapshot(controller)
                #expect(before["token"] as? String == "accepted-startup-token")
                _ = try await controller.webView.evaluateJavaScript(
                    "history.pushState({}, '', '/control/settings?panel=privacy'); window.unsavedDraft='keep me';")
                let route = controller.webView.url
                let scripts = controller.webView.configuration.userContentController.userScripts.filter {
                    $0 !== controller.documentHost.nativeAuthScript
                }
                let observations = documents.compactMap(\.nativeStartupObservation)
                #expect(observations.count == 2)
                await connection.shutdown()
                // Synchronous cache admission must fail even before an observer
                // turn runs, and must not redirect or replace the existing page.
                #expect(manager.immediateResolvedDashboardAuth(url: controller.currentURL, endpoint: endpoint) == nil)
                try await AsyncTimeout.withTimeout(seconds: 5, onTimeout: { URLError(.timedOut) }) {
                    for observation in observations {
                        await observation.value
                    }
                }
                for document in documents {
                    #expect(!document.auth.hasAcceptedNativeBinding)
                    #expect(document.auth.legacyCredentials.isEmpty)
                    #expect(document.nativeGatewayAuthProvider != nil)
                }
                #expect(controller.window === window)
                #expect(controller.webView.url == route)
                #expect(try await controller.webView.evaluateJavaScript("window.unsavedDraft") as? String == "keep me")
                let retained = controller.webView.configuration.userContentController.userScripts
                #expect(scripts.allSatisfy { script in retained.contains { $0 === script } })
                // Exercise the installed document-start scripts in actual new
                // documents; source-string inspection cannot prove revocation.
                for document in documents {
                    document.webView.load(URLRequest(url: document.currentURL))
                    try await waitForNativeDashboardDocument(
                        webView: document.webView, dashboardURL: document.currentURL)
                    let revoked = try #require(try await document.webView.evaluateJavaScript(
                        "window.__OPENCLAW_NATIVE_CONTROL_AUTH__") as? [String: Any])
                    #expect(revoked["token"] is NSNull)
                    #expect(revoked["password"] is NSNull)
                    #expect(revoked["nativeConnectAuth"] as? Bool == true)
                }
                outcome = .success(())
            } catch { outcome = .failure(error) }
            await connection.shutdown()
            try outcome.get()
        }
    }

    @Test func `saved profile reconnect refreshes retained document before old socket retirement`() async throws {
        _ = AppKitTestSupport.application
        let server = try await DashboardHTTPFixture.start()
        defer { server.stop() }
        let stateDir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: stateDir) }
        let defaultsName = "ProfileReconnectAuthTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: defaultsName))
        defer { defaults.removePersistentDomain(forName: defaultsName) }
        try await DeviceIdentityStore.withStateDirectory(stateDir) {
            let identity = DeviceIdentityStore.loadOrCreate()
            let helloIdentities = LockIsolated<[String]>([])
            let endpoint = GatewayConnection.EndpointSnapshot(
                config: (server.websocketURL("/control/"), "accepted-profile-token", nil),
                routeAuthority: 1, deviceAuthGatewayID: "profile-reconnect", revision: 1)
            let attempts = LockIsolated(0)
            let session = GatewayTestWebSocketSession(taskFactory: {
                let attempt = attempts.withValue { value in
                    defer { value += 1 }
                    return value
                }
                return GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        if sendIndex == 0 {
                            let params = try #require(GatewayWebSocketTestSupport.connectRequestParams(from: message))
                            let device = try #require(params["device"] as? [String: Any])
                            let deviceID = try #require(device["id"] as? String)
                            helloIdentities.withValue { $0.append(deviceID) }
                            return
                        }
                        guard sendIndex > 0,
                              let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                        return .data(GatewayWebSocketTestSupport.connectOkData(
                            id: task.snapshotConnectRequestID() ?? "connect",
                            scopes: attempt == 0 ? ["operator.read"] : ["operator.read", "operator.write"]))
                    })
            })
            let connection = GatewayConnection(
                endpointProvider: { endpoint }, currentEndpointRevision: { 1 },
                supportsSharedEndpointRecovery: false, activationBindingKeyProvider: { nil },
                sessionBox: WebSocketSessionBox(session: session))
            let originalLease = LockIsolated<GatewayConnection.ServerLease?>(nil)
            let retirementObserved = AsyncTestGate()
            let releaseRetirement = AsyncTestGate()
            let successorInstalled = AsyncTestGate()
            let catalogRefreshResolved = LockIsolated<AsyncTestGate?>(nil)
            let target = DashboardGatewayTarget.profile("profile-reconnect")
            let manager = DashboardManager._testMake(
                selection: MacGatewaySelectionPreferences(defaults: defaults),
                connectionProvider: { _ in connection },
                browserIdentityURLProvider: { _, config in
                    // Catalog notifications may arrive outside the test task.
                    // Reconnect must still use this fixture's native identity.
                    try await DeviceIdentityStore.withStateDirectory(stateDir) {
                        try await connection.controlUiBrowserIdentityURL(config: config)
                    }
                },
                legacyCredentialsProvider: { _, endpoint in
                    let credentials = try await DeviceIdentityStore.withStateDirectory(stateDir) {
                        try await connection.controlUiLegacyCredentials(endpoint: endpoint)
                    }
                    let lease = try #require(await connection.captureServerLease())
                    let isOriginal = originalLease.withValue { value in
                        if value == nil { value = lease }
                        return value == lease
                    }
                    let waitForInvalidation = try #require(credentials.waitForInvalidation)
                    let armedRefresh = catalogRefreshResolved.value
                    return DashboardNativeGatewayAuth.LegacyCredentials(
                        credentials: credentials.credentials,
                        isCurrent: {
                            // The manager checks a resolution in the same main-actor job
                            // that keeps or replaces the document's projection.
                            armedRefresh?.open()
                            return credentials.isCurrent()
                        },
                        waitForInvalidation: {
                            // Hold only delivery of an actual old-socket invalidation.
                            // The native owner and its successor hello remain real.
                            if !isOriginal { successorInstalled.open() }
                            await waitForInvalidation()
                            if isOriginal, !credentials.isCurrent() {
                                retirementObserved.open()
                                await releaseRetirement.wait()
                            }
                        })
                },
                observeGatewayChanges: true,
                profileEndpointProvider: { _ in endpoint },
                gatewayEntriesProvider: {
                    [DashboardGatewayEntry(
                        id: target.bridgeID, name: "Saved Gateway", kind: "remote",
                        isPrimary: false, canPromote: true, health: .unknown)]
                })
            let outcome: Result<Void, Error>
            var oldObservation: Task<Void, Never>?
            do {
                await manager._testOpenWindow(for: target)
                let controller = try #require(manager._testAuxiliaryWindows().first?.controller)
                try await waitForNativeDashboardDocument(controller)
                let oldCredentials = try #require(controller.documentHost.legacyNativeCredentials)
                oldObservation = try #require(controller.documentHost.nativeStartupObservation)
                let window = controller.window
                let webView = controller.webView
                _ = try await webView.evaluateJavaScript(
                    "history.pushState({}, '', '/control/settings?panel=privacy'); window.unsavedDraft='keep me';")
                let route = webView.url
                let socket = try #require(session.latestTask())
                socket.emitReceiveFailure()
                try await AsyncTimeout.withTimeout(
                    seconds: 5, onTimeout: { URLError(.timedOut) },
                    operation: { await retirementObserved.wait() })
                #expect(!oldCredentials.isCurrent())
                // This gate opens only when profile reconciliation installs the
                // new projection on its document, not merely when hello arrives.
                try await AsyncTimeout.withTimeout(
                    seconds: 5, onTimeout: { URLError(.timedOut) },
                    operation: { await successorInstalled.wait() })
                releaseRetirement.open()
                await oldObservation?.value
                let retained = try #require(manager._testAuxiliaryWindows().first?.controller)
                #expect(retained === controller)
                #expect(retained.window === window)
                #expect(retained.webView === webView)
                #expect(webView.url == route)
                #expect(try await webView.evaluateJavaScript("window.unsavedDraft") as? String == "keep me")
                #expect(retained.documentHost.hasCurrentNativeStartupCredentials)
                #expect(retained.auth.legacyCredentials == ["token": "accepted-profile-token"])
                #expect(helloIdentities.value == [identity.deviceId, identity.deviceId])
                try scopeNativeDashboardIdentity(retained.documentHost, stateDirectory: stateDir)
                let providerRevision = retained.documentHost.nativeGatewayAuthRevision
                // A catalog change that keeps this socket must not replace the current
                // projection; that would refuse the document's native challenges.
                let refreshResolved = AsyncTestGate()
                catalogRefreshResolved.setValue(refreshResolved)
                NotificationCenter.default.post(
                    name: MacGatewayProfileStore.didChangeNotification, object: nil,
                    userInfo: [MacGatewayProfileStore.changedProfileIDKey: "profile-reconnect"])
                try await AsyncTimeout.withTimeout(
                    seconds: 5, onTimeout: { URLError(.timedOut) },
                    operation: { await refreshResolved.wait() })
                #expect(retained.documentHost.nativeGatewayAuthRevision == providerRevision)
                let response = try await Self.decodeReply(Self.challenge(in: webView))
                let result = try #require(
                    response["result"] as? [String: Any],
                    "Native auth reply: \(response); provider revision \(providerRevision) -> \(retained.documentHost.nativeGatewayAuthRevision)")
                #expect(result["scopes"] as? [String] == ["operator.read", "operator.write"])
                #expect(session.snapshotMakeCount() == 2)
                webView.reload()
                let startup = try await dashboardNativeAuthSnapshot(retained)
                #expect(startup["token"] as? String == "accepted-profile-token")
                #expect(startup["nativeConnectAuth"] as? Bool == true)
                outcome = .success(())
            } catch { outcome = .failure(error) }
            releaseRetirement.open()
            manager.close()
            await oldObservation?.value
            await connection.shutdown()
            try outcome.get()
        }
    }

    private static func challenge(in webView: WKWebView) async throws -> String {
        let value = try await webView.callAsyncJavaScript("""
        try {
          return JSON.stringify(await window.webkit.messageHandlers.OpenClawNativeGatewayAuth.postMessage({
            id:'conversation-request', nonce:'conversation-challenge', signedAt:123
          }));
        } catch (error) { return JSON.stringify({error:String(error)}); }
        """, in: nil, contentWorld: .page)
        return try #require(value as? String)
    }

    private static func decodeReply(_ value: String) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }
}
