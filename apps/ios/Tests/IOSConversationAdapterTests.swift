import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing
import UIKit
import WebKit
@testable import OpenClaw

@MainActor
struct IOSConversationAdapterTests {
    @Test(
        .enabled(
            if: ProcessInfo.processInfo.environment["OPENCLAW_IOS_PRODUCTION_CONVERSATION_URL"] != nil,
            "Requires the isolated production Gateway and shipped web assets"),
        .timeLimit(.minutes(1)))
    func `production private entry restores canonical chat before native ready and state`() async throws {
        let environment = ProcessInfo.processInfo.environment
        let root = try #require(environment["OPENCLAW_IOS_PRODUCTION_CONVERSATION_URL"].flatMap(URL.init(string:)))
        try #require(root.host == "127.0.0.1" && root.scheme == "http")
        let token = try #require(environment["OPENCLAW_IOS_PRODUCTION_CONVERSATION_TOKEN"])
        let entry = try #require(NativeConversationRoute.documentURL(
            sessionKey: "agent:main:main", agentID: "main", draft: nil, baseURL: root))
        let fixture = try await ConversationFixture.startProduction(root: root, entry: entry, token: token)
        defer { fixture.stop() }
        // No injected ready/state messages or document binding: the shipped app
        // must perform its protected-entry bootstrap and native handshake itself.
        #expect(fixture.webView.url?.path == root.appendingPathComponent("chat/main").path)
        var failed = false
        fixture.bridge.onFailure = { failed = true }
        try await fixture.wait { fixture.bridge.ready && fixture.bridge.state?.connection == .connected || failed }
        try #require(fixture.bridge.ready, "Production ready was rejected after protected entry restored /chat")
        #expect(!failed)
        #expect(fixture.bridge.state?.context.sessionKey == "agent:main:main")
        #expect(fixture.bridge.state?.connection == .connected)
        try await TestWait.state("production composer mount") {
            try await fixture.webView.evaluateJavaScript(
                "Array.from(document.querySelectorAll('openclaw-chat-pane')).some(p => p.active && p.composerReady)")
                as? Bool == true
        }
        #expect(await fixture.bridge.request(.focusComposer))
    }

    @Test(.timeLimit(.minutes(1)), arguments: ["/control/chat/main", "/chat/main", "/control-other/chat/main"])
    func `canonical chat remains bounded by the authenticated mount`(path: String) async throws {
        let fixture = try await ConversationFixture.start(mount: "control")
        defer { fixture.stop() }
        _ = try await fixture.webView.callAsyncJavaScript(
            "history.replaceState(null, '', path);", arguments: ["path": path], in: nil, contentWorld: .page)
        let withinMount = path == "/control/chat/main"
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}") == withinMount)
        #expect(fixture.bridge.ready == withinMount)
    }

    @Test(.timeLimit(.minutes(1)))
    func `bridge adopts only current documents and monotonic state`() async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        #expect(try await fixture.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_EMBED__.platform") as? String == "ios")
        #expect(try await fixture.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_EMBED__.surface") as? String == "conversation")
        #expect(try await fixture
            .post("{type:'ready',surface:'conversation',capabilities:['session-facts-v1']}") == true)
        #expect(fixture.bridge.ready)
        let state = "type:'state',context:{agentId:'main',sessionKey:'agent:main:fixture'}," +
            "title:'Fixture',run:{active:true},connection:'connected'"
        #expect(try await fixture.post("{\(state),revision:2}") == true)
        #expect(try await fixture.post("{\(state),revision:1}") == false)
        #expect(fixture.bridge.state?.revision == 2)
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}") == true)
        #expect(fixture.bridge.state?.revision == 2)
        #expect(try await fixture.post("{type:'session-facts',revision:1,sessions:[]}") == true)
        #expect(fixture.bridge.facts?.sessions == [])
        #expect(try await fixture.post("{\(state),revision:3}", document: "retired") == false)
        fixture.bridge.isCurrent = { false }
        #expect(try await fixture.post("{\(state),revision:3}") == false)
        #expect(fixture.bridge.state?.revision == 2)
    }

    @Test(.timeLimit(.minutes(1)))
    func `command replies and blank commit retire the executable owner`() async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}") == true)
        _ = try await fixture.webView.evaluateJavaScript("""
        window.addEventListener('openclaw:native-conversation-command', async event => {
          if (event.detail.type === 'focus-composer') {
            await window.webkit.messageHandlers.openclawConversation.postMessage({
              contract:1, documentId:'fixture', type:'command-result',
              requestId:event.detail.requestId, ok:true
            });
          }
        });
        """)
        #expect(await fixture.bridge.request(.focusComposer))
        _ = try await fixture.webView.evaluateJavaScript("""
        window.commandSeen = new Promise(resolve => window.addEventListener(
          'openclaw:native-conversation-command', () => resolve(true), {once:true}));
        void 0;
        """)
        let pending = Task { await fixture.bridge.request(.presentation(.init(visible: false, active: false))) }
        #expect(try await fixture.webView.callAsyncJavaScript(
            "return await window.commandSeen;", arguments: [:], in: nil, contentWorld: .page) as? Bool == true)
        var shutDown = false
        fixture.bridge.close { shutDown = true }
        #expect(fixture.bridge.isClosing)
        try await fixture.wait { shutDown }
        #expect(await !(pending.value))
        #expect(!fixture.bridge.ready)
        #expect(fixture.bridge.documentID == nil)
        #expect(fixture.bridge.webView == nil)
        #expect(await !(fixture.bridge.request(.focusComposer)))
    }

    @Test(.timeLimit(.minutes(1)))
    func `subframes cannot adopt the conversation document`() async throws {
        let fixture = try await ConversationFixture.start()
        defer { fixture.stop() }
        let adopted = try await fixture.webView.callAsyncJavaScript(
            """
            const frame = document.createElement('iframe');
            const loaded = new Promise(resolve => frame.onload = resolve);
            frame.src = location.href;
            document.body.appendChild(frame);
            await loaded;
            const child = frame.contentWindow;
            child.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__ = {documentId:'child'};
            const reply = await child.webkit.messageHandlers.openclawConversation.postMessage({
              contract:1, documentId:'child', type:'ready', surface:'conversation', capabilities:[]
            });
            frame.remove();
            return reply.ok;
            """,
            arguments: [:],
            in: nil,
            contentWorld: .page)
        #expect(adopted as? Bool == false)
        #expect(!fixture.bridge.ready)
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}"))
    }

    @Test(.timeLimit(.minutes(1)))
    func `revoked access preserves pending web storage`() async throws {
        let fixture = try await ConversationFixture.start(access: true)
        defer { fixture.stop() }
        #expect(try await fixture.post("{type:'ready',surface:'conversation',capabilities:[]}"))
        _ = try await fixture.webView.callAsyncJavaScript(
            """
            const request = indexedDB.open('conversation-fixture', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('pending');
            const db = await new Promise((resolve, reject) => {
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            await new Promise((resolve, reject) => {
              const tx = db.transaction('pending', 'readwrite');
              tx.objectStore('pending').put({draft:'unsent words', outbox:['queued message']}, 'state');
              tx.oncomplete = resolve;
              tx.onerror = () => reject(tx.error);
            });
            db.close();
            return true;
            """,
            arguments: [:],
            in: nil,
            contentWorld: .page)
        var retired = false
        fixture.bridge.onFailure = { retired = true }
        fixture.admission.current = false
        fixture.coordinator.retireAccess(in: fixture.webView)
        #expect(fixture.bridge.isClosing)
        try await fixture.wait { retired }
        #expect(fixture.webView.url?.absoluteString == "about:blank")
        #expect(fixture.bridge.webView == nil)
        let reopened = try await fixture.reopen()
        defer { reopened.stop() }
        let pending = try await reopened.webView.callAsyncJavaScript(
            """
            const request = indexedDB.open('conversation-fixture', 1);
            const db = await new Promise((resolve, reject) => {
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            const value = await new Promise((resolve, reject) => {
              const read = db.transaction('pending').objectStore('pending').get('state');
              read.onsuccess = () => resolve(read.result);
              read.onerror = () => reject(read.error);
            });
            db.close();
            return value.draft + '|' + value.outbox.join(',');
            """,
            arguments: [:],
            in: nil,
            contentWorld: .page)
        #expect(pending as? String == "unsent words|queued message")
    }

    @Test(.timeLimit(.minutes(1)))
    func `gateway storage survives owner replacement and Forget leaves other gateways intact`() async throws {
        let gatewayID = "web-storage-" + UUID().uuidString
        let otherID = gatewayID + "-other"
        let fixture = try await ConversationFixture.start(
            store: WKWebsiteDataStore(forIdentifier: IOSConversationController.storageID(gatewayID: gatewayID)))
        defer { fixture.stop() }
        var failure: (any Error)?
        do {
            _ = try await fixture.webView.evaluateJavaScript("localStorage.setItem('composer', 'Kept draft')")
            let replacement = try await fixture.reopen(store: WKWebsiteDataStore(
                forIdentifier: IOSConversationController.storageID(gatewayID: gatewayID)))
            defer { replacement.stop() }
            #expect(try await replacement.webView.evaluateJavaScript(
                "localStorage.getItem('composer')") as? String == "Kept draft")
            let other = try await fixture.reopen(store: WKWebsiteDataStore(
                forIdentifier: IOSConversationController.storageID(gatewayID: otherID)))
            defer { other.stop() }
            #expect(try await other.webView.evaluateJavaScript("localStorage.getItem('composer')") is NSNull)
            _ = try await other.webView.evaluateJavaScript("localStorage.setItem('composer', 'Other draft')")
            await IOSConversationController.removeStorage(gatewayID: gatewayID)
            #expect(try await replacement.webView.evaluateJavaScript("localStorage.getItem('composer')") is NSNull)
            #expect(try await other.webView.evaluateJavaScript(
                "localStorage.getItem('composer')") as? String == "Other draft")
        } catch { failure = error }
        await IOSConversationController.removeStorage(gatewayID: gatewayID)
        await IOSConversationController.removeStorage(gatewayID: otherID)
        if let failure {
            throw failure
        }
    }

    @Test func `offline hydration retains the native draft and only installs the I pad adapter`() async throws {
        let appModel = NodeAppModel()
        let gatewayID = "conversation-adapter-test-" + UUID().uuidString
        appModel.connectedGatewayID = gatewayID
        let owner = appModel.chatPresentation
        defer {
            owner.conversation?.close()
            owner.viewModel?.detachTransport()
            appModel.voiceWake.stop()
        }
        owner.sync(appModel: appModel)
        let model = try #require(owner.viewModel)
        model.input = "Pending offline words"
        #expect(owner.conversation == nil)
        appModel.activeGatewayConnectConfig = try GatewayConnectConfig(
            url: #require(URL(string: "wss://gateway.invalid/control")),
            stableID: gatewayID,
            tls: nil,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Fixture",
                allowStoredDeviceAuth: false,
                deviceAuthGatewayID: gatewayID))
        owner.sync(appModel: appModel)
        #expect(owner.viewModel === model)
        #expect(model.input == "Pending offline words")
        #expect((owner.conversation != nil) == (UIDevice.current.userInterfaceIdiom == .pad))
        #expect(owner.conversation?.bridge == nil)
        #expect(!model.usesWebConversation)
        owner.conversation?.close()
        model.detachTransport()
        _ = await appModel.purgeChatTranscriptCache(gatewayID: gatewayID)
        await IOSConversationController.removeStorage(gatewayID: gatewayID)
    }

    @Test func `dashboard handoff retains the mount and rejects escapes`() throws {
        let root = try #require(URL(string: "https://gateway.invalid/control/"))
        func route(_ path: String, search: String = "?draft=C%2B%2B") throws -> NativeConversationDashboardRoute {
            try JSONDecoder().decode(
                NativeConversationDashboardRoute.self,
                from: JSONSerialization.data(withJSONObject: ["path": path, "search": search]))
        }
        #expect(try IOSConversationView.dashboardURL(route("/control/settings"), baseURL: root)?.absoluteString ==
            "https://gateway.invalid/control/settings?draft=C%2B%2B")
        for path in [
            "/settings",
            "/control-other/settings",
            "//foreign.invalid",
            "/control/../outside",
            "/control/%2e%2e/outside",
            "/control/%5cforeign",
            "/control/settings#fragment",
        ] {
            #expect(try IOSConversationView.dashboardURL(route(path), baseURL: root) == nil)
        }
        #expect(try IOSConversationView
            .dashboardURL(route("/control/settings", search: "?q=%GG"), baseURL: root) == nil)
    }

    @Test func `web ownership blocks native dispatch and is released for the same scope`() async throws {
        let ownership = OpenClawChatSendOwnership()
        let scope = OpenClawChatSendOwnership.Scope(sessionKey: "agent:main:fixture", agentID: "main")
        let owner = UUID()
        #expect(ownership.beginWeb(scope, owner: owner))
        defer { ownership.endWeb(scope, owner: owner) }
        let transport = IOSGatewayChatTransport(
            gateway: GatewayNodeSession(),
            globalAgentId: "main",
            conversationOwnership: ownership)
        do {
            _ = try await transport.sendMessage(
                sessionKey: "agent:main:fixture",
                agentID: nil,
                message: "fixture",
                thinking: "off",
                idempotencyKey: "fixture",
                attachments: [],
                ifCurrentRoute: nil)
            Issue.record("Web ownership must prevent native dispatch")
        } catch OpenClawChatSendOwnershipError.webOwned {
            // Rejected before touching the unconnected fixture Gateway.
        }
        #expect(!ownership.beginNative(scope))
        ownership.endWeb(scope, owner: owner)
        #expect(ownership.beginNative(scope))
        ownership.endNative(scope)
    }
}

@MainActor
private final class ConversationFixture: NSObject, WKNavigationDelegate {
    let server: SettingsHubHTTPFixture?
    let gatewayURL: URL
    let webView: WKWebView
    let bridge: IOSConversationBridge
    let coordinator: AuthenticatedControlUIWebViewCoordinator
    let admission = ConversationAdmission()
    private var loaded: CheckedContinuation<Void, any Error>?

    private init(
        server: SettingsHubHTTPFixture?,
        url: URL,
        gatewayURL: URL? = nil,
        store: WKWebsiteDataStore,
        cookie: HTTPCookie?,
        authScript: String? = nil)
    {
        self.server = server
        self.gatewayURL = gatewayURL ?? url
        self.bridge = IOSConversationBridge(url: url, gatewayURL: gatewayURL ?? url)
        self.bridge.isCurrent = { true }
        let admission = self.admission
        self.coordinator = AuthenticatedControlUIWebViewCoordinator(
            url: url,
            tls: nil,
            authScript: authScript,
            conversation: self.bridge,
            accessCookie: cookie,
            accessAdmissionIsCurrent: { admission.current })
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        configuration.userContentController.addScriptMessageHandler(
            self.bridge, contentWorld: .page, name: NativeConversationContract.handlerName)
        self.coordinator.installUserScripts(in: configuration.userContentController)
        self.webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        self.coordinator.attachNativeAuthDocument(to: self.webView)
        self.webView.navigationDelegate = self
    }

    static func start(
        access: Bool = false, store: WKWebsiteDataStore = .nonPersistent(), mount: String? = nil) async throws
        -> ConversationFixture
    {
        let server = try SettingsHubHTTPFixture(body: "<html><body>Conversation fixture</body></html>")
        let serverURL = try await server.start()
        let gatewayURL = mount.map { serverURL.deletingLastPathComponent().appendingPathComponent($0) } ?? serverURL
        let url = mount == nil ? serverURL : gatewayURL.appendingPathComponent("__openclaw__/session-entry")
        let cookie = access ? HTTPCookie(properties: [
            .name: "CF_Authorization", .value: "fixture", .originURL: url, .path: "/",
            .secure: "TRUE", .expires: Date().addingTimeInterval(3600),
            HTTPCookiePropertyKey("HttpOnly"): "TRUE",
        ]) : nil
        let fixture = ConversationFixture(
            server: server, url: url, gatewayURL: gatewayURL, store: store, cookie: cookie)
        return try await fixture.load(url)
    }

    static func startProduction(root: URL, entry: URL, token: String) async throws -> ConversationFixture {
        let config = GatewayConnectConfig(
            url: root,
            stableID: "production-boot-" + UUID().uuidString,
            tls: nil,
            token: token,
            bootstrapToken: nil,
            password: nil,
            nodeOptions: GatewayConnectOptions(
                role: "operator",
                scopes: ["operator.admin"],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "ios",
                clientMode: "node",
                clientDisplayName: "Isolated production boot",
                allowStoredDeviceAuth: false))
        let script = AuthenticatedControlUI.authUserScript(
            config: config, pageURL: entry, storedOperatorToken: nil, usesNativeNavigationChrome: true)
        let fixture = ConversationFixture(
            server: nil, url: entry, gatewayURL: root, store: .nonPersistent(), cookie: nil, authScript: script)
        // The real chat pane defers its composer until it has a viewport.
        // Protocol-only fixtures use zero bounds; production boot must not.
        fixture.webView.frame = CGRect(x: 0, y: 0, width: 1180, height: 820)
        return try await fixture.load(entry, seedDocument: false)
    }

    func reopen(store: WKWebsiteDataStore? = nil) async throws -> ConversationFixture {
        let fixture = ConversationFixture(
            server: server,
            url: bridge.url,
            gatewayURL: self.gatewayURL,
            store: store ?? self.webView.configuration.websiteDataStore,
            cookie: nil)
        return try await fixture.load(self.bridge.url)
    }

    private func load(_ url: URL, seedDocument: Bool = true) async throws -> ConversationFixture {
        let fixture = self
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    fixture.loaded = continuation
                    fixture.webView.load(URLRequest(url: url))
                }
            } onCancel: {
                Task { @MainActor in
                    fixture.loaded?.resume(throwing: CancellationError())
                    fixture.loaded = nil
                    fixture.stop()
                }
            }
            if seedDocument {
                _ = try await fixture.webView.evaluateJavaScript(
                    "window.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__ = {documentId:'fixture'}; void 0;")
            }
            return fixture
        } catch { fixture.stop()
            throw error
        }
    }

    func post(_ fields: String, document: String = "fixture") async throws -> Bool {
        try await self.webView.callAsyncJavaScript(
            """
            const reply = await window.webkit.messageHandlers.openclawConversation.postMessage({
              contract:1, documentId:document, ...\(fields)
            });
            return reply.ok;
            """,
            arguments: ["document": document],
            in: nil,
            contentWorld: .page) as? Bool == true
    }

    func wait(_ condition: () -> Bool) async throws {
        while !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func stop() {
        self.bridge.retire()
        self.webView.stopLoading()
        self.webView.navigationDelegate = nil
        self.webView.configuration.userContentController.removeScriptMessageHandler(
            forName: NativeConversationContract.handlerName, contentWorld: .page)
        self.server?.stop()
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        self.coordinator.webView(webView, decidePolicyFor: action, decisionHandler: decisionHandler)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor response: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        self.coordinator.webView(webView, decidePolicyFor: response, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        self.coordinator.webView(webView, didStartProvisionalNavigation: navigation)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        self.coordinator.webView(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.coordinator.webView(webView, didFinish: navigation)
        self.loaded?.resume()
        self.loaded = nil
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: any Error) {
        self.loaded?.resume(throwing: error)
        self.loaded = nil
    }
}

@MainActor
private final class ConversationAdmission {
    var current = true
}
