import Foundation
import OpenClawKit
import Testing
import WebKit
@testable import OpenClaw

/// WebKit fixtures are compiled locally and executed only in the disposable macOS runner.
@Suite(.serialized, .testWaitLimit)
@MainActor
struct NativeConversationBridgeTests {
    @Test func `Dashboard handoff removes exactly the document mount`() throws {
        let mounted = try #require(URL(string: "https://gateway.invalid/control/"))
        let root = try #require(URL(string: "https://gateway.invalid/"))
        #expect(ControlUIDocumentHost.appPath(fromDocumentPath: "/control/settings", baseURL: mounted) == "/settings")
        #expect(ControlUIDocumentHost
            .appPath(fromDocumentPath: "/control/control/settings", baseURL: mounted) == "/control/settings")
        #expect(ControlUIDocumentHost.appPath(fromDocumentPath: "/settings", baseURL: root) == "/settings")
        #expect(ControlUIDocumentHost.appPath(fromDocumentPath: "/outside/settings", baseURL: mounted) == nil)
        #expect(ControlUIDocumentHost.appPath(fromDocumentPath: "//other.invalid/settings", baseURL: root) == nil)
    }

    @Test func `conversation titlebar is available at startup only on the trusted mount`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: Self.html, contentSecurityPolicy: "default-src 'self' 'unsafe-inline'")
        defer { server.stop() }
        let document = Self.document(server: server, handler: NativeConversationMessageHandler())
        defer { document.webView.stopLoading() }
        for path in ["/control/chat/main", "/outside"] {
            document.load(server.url(path))
            try await TestWait.state("conversation page \(path)") {
                let current = try? await document.webView.evaluateJavaScript(
                    "window.fixtureChrome ? location.pathname : null")
                return current as? String == path
            }
            let chrome = try #require(
                try await document.webView.evaluateJavaScript("window.fixtureChrome") as? [String: Any])
            #expect(chrome["height"] as? String == (path == "/outside" ? "" : "52px"))
            #expect(chrome["drag"] as? Bool == true)
            #expect(chrome["browser"] as? Bool == false)
            #expect(chrome["dashboard"] as? Bool == false)
        }
    }

    @Test func `only the current main document can publish conversation state`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: Self.html, contentSecurityPolicy: "default-src 'self' 'unsafe-inline'")
        defer { server.stop() }
        let handler = NativeConversationMessageHandler()
        let document = Self.document(server: server, handler: handler)
        let bridge = NativeConversationBridge(document: document)
        handler.owner = bridge
        defer { bridge.close() }
        bridge.load(server.url("/control/chat/main"))
        try await TestWait.observed("current conversation document") { bridge.currentDocumentId != nil }
        let oldID = try #require(bridge.currentDocumentId)
        let accepted = try await Self.post("{type:'state', ...fixtureState(1, 'First')}", in: document.webView)
        #expect(accepted["ok"] as? Bool == true)
        #expect(bridge.state?.title == "First")
        let stale = try await Self.post("{type:'state', ...fixtureState(1, 'Stale')}", in: document.webView)
        #expect(stale["ok"] as? Bool == false)
        #expect(bridge.state?.title == "First")
        let forged = try await Self.post(
            "{type:'ready', surface:'conversation', documentId:'retired', capabilities:[]}",
            in: document.webView)
        #expect(forged["ok"] as? Bool == false)
        #expect(bridge.currentDocumentId == oldID)

        _ = try await document.webView.callAsyncJavaScript("""
        return await new Promise(resolve => {
          window.receiveFrameReply = resolve;
          const frame = document.createElement('iframe');
          frame.srcdoc = `<script>window.webkit.messageHandlers.openclawConversation.postMessage({
            contract:1, documentId:parent.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__.documentId,
            type:'state', ...parent.fixtureState(2, 'Subframe')
          }).then(parent.receiveFrameReply)</script>`;
          document.body.append(frame);
        });
        """, in: nil, contentWorld: .page)
        #expect(bridge.state?.title == "First")

        bridge.load(server.url("/control/chat/main"))
        try await TestWait.observed("replacement conversation document") {
            bridge.currentDocumentId != nil && bridge.currentDocumentId != oldID
        }
        let oldLiteral = try String(decoding: JSONEncoder().encode(oldID), as: UTF8.self)
        let retired = try await Self.post(
            "{type:'state', ...fixtureState(99, 'Retired'), documentId:\(oldLiteral)}", in: document.webView)
        #expect(retired["ok"] as? Bool == false)
        #expect(bridge.state == nil)
        _ = try await document.webView.evaluateJavaScript("history.replaceState({}, '', '/outside')")
        let outside = try await Self.post("{type:'state', ...fixtureState(1, 'Outside')}", in: document.webView)
        #expect(outside["ok"] as? Bool == false)
        #expect(bridge.state == nil)

        var stopped = false
        let closed = AsyncTestGate()
        bridge.close {
            stopped = true
            closed.open()
        }
        // Initiating navigation is not proof that the old page stopped executing.
        #expect(!stopped)
        await closed.wait()
        try Task.checkCancellation()
        #expect(document.webView.url?.absoluteString == "about:blank")
    }

    @Test func `another web view is refused and command replies resolve once`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: Self.html, contentSecurityPolicy: "default-src 'self' 'unsafe-inline'")
        defer { server.stop() }
        let handler = NativeConversationMessageHandler()
        let document = Self.document(server: server, handler: handler)
        let bridge = NativeConversationBridge(document: document)
        handler.owner = bridge
        defer { bridge.close() }
        bridge.load(server.url("/control/chat/main"))
        try await TestWait.observed("current conversation document") { bridge.currentDocumentId != nil }
        let id = bridge.currentDocumentId
        let other = Self.document(server: server, handler: handler)
        defer { other.webView.stopLoading() }
        other.load(server.url("/control/chat/main"))
        try await TestWait.state("other web view refusal") {
            await (try? other.webView.evaluateJavaScript("window.fixtureReadyReply?.ok === false")) as? Bool == true
        }
        #expect(bridge.currentDocumentId == id)
        let result = await bridge.request(.focusComposer)
        #expect(result.ok)
        let count = try await document.webView.evaluateJavaScript("window.commandCount") as? Int
        #expect(count == 1)
    }

    @Test func `sidebar extensions require capability and retire with their document`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: Self.html, contentSecurityPolicy: "default-src 'self' 'unsafe-inline'")
        defer { server.stop() }
        let handler = NativeConversationMessageHandler()
        let document = Self.document(server: server, handler: handler)
        let bridge = NativeConversationBridge(document: document)
        handler.owner = bridge
        defer { bridge.close() }
        let context = NativeConversationContext(agentId: "main", sessionKey: "agent:main:other")
        let snapshot = """
        {type:'session-facts', revision:1, sessions:[
          {agentId:'main',sessionKey:'agent:main:other',hasComposerDraft:true,outboxAttentionCount:2}
        ]}
        """
        bridge.load(server.url("/control/chat/main"))
        try await TestWait.observed("featureless conversation document") { bridge.currentDocumentId != nil }
        #expect(await bridge.request(.openSessionActions(context)).error == "unsupported")
        #expect(try await Self.post(snapshot, in: document.webView)["ok"] as? Bool == false)
        #expect(bridge.sessionFacts == nil)

        bridge.load(server.url("/control/chat/main?features=1"))
        try await TestWait.observed("sidebar-capable conversation document") { bridge.currentDocumentId != nil }
        let documentID = try #require(bridge.currentDocumentId)
        #expect(bridge.capabilities.contains("session-facts-v1"))
        #expect(try await Self.post(snapshot, in: document.webView)["ok"] as? Bool == true)
        #expect(bridge.sessionFacts?.sessions?.first?.context == context)
        #expect(bridge.sessionFacts?.sessions?.first?.outboxAttentionCount == 2)
        #expect(try await Self.post(snapshot, in: document.webView)["error"] as? String == "stale-state")
        #expect(try await Self.post("""
        {type:'session-facts', revision:2, sessions:Array.from({length:20},(_,i)=>({
          agentId:'main',sessionKey:String(i).padEnd(4096,'x'),hasComposerDraft:false,outboxAttentionCount:0
        }))}
        """, in: document.webView)["ok"] as? Bool == false)
        #expect(bridge.sessionFacts?.revision == 1)
        #expect(try await Self.post("""
        {type:'session-facts', revision:2, sessions:Array.from({length:15},(_,i)=>({
          agentId:'main',sessionKey:`agent:main:${i}:`+'/'.repeat(4000),
          hasComposerDraft:true,outboxAttentionCount:1
        }))}
        """, in: document.webView)["ok"] as? Bool == true)
        #expect(bridge.sessionFacts?.revision == 2)
        #expect(bridge.sessionFacts?.sessions?.count == 15)
        #expect(try await Self.post(
            "{type:'session-facts',revision:3,sessions:null}", in: document.webView)["ok"] as? Bool == true)
        #expect(bridge.sessionFacts?.sessions == nil)
        #expect(try await Self.post(
            "{type:'ready',surface:'conversation',capabilities:[]}", in: document.webView)["ok"] as? Bool == true)
        #expect(await bridge.request(.openSessionActions(context)).ok)
        let command = try #require(
            try await document.webView.evaluateJavaScript("window.lastCommand") as? [String: Any])
        #expect(command["type"] as? String == "open-session-actions")
        #expect((command["payload"] as? [String: String]) == ["agentId": "main", "sessionKey": context.sessionKey])

        bridge.load(server.url("/control/chat/main"))
        #expect(bridge.sessionFacts == nil)
        #expect(bridge.capabilities.isEmpty)
        try await TestWait.observed("replacement featureless conversation document") { bridge.currentDocumentId != nil }
        let oldLiteral = try String(decoding: JSONEncoder().encode(documentID), as: UTF8.self)
        #expect(try await Self.post(
            "{...\(snapshot),documentId:\(oldLiteral)}", in: document.webView)["error"] as? String == "stale-document")
        #expect(await bridge.request(.openSessionActions(context)).error == "unsupported")
    }

    private static func document(
        server: DashboardHTTPFixture,
        handler: NativeConversationMessageHandler) -> ControlUIDocumentHost
    {
        let url = server.url("/control/")
        return ControlUIDocumentHost(
            url: url, auth: .init(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent())
        { controller in
            controller.addScriptMessageHandler(
                handler,
                contentWorld: .page,
                name: NativeConversationContract.handlerName)
            controller.addUserScript(WKUserScript(
                source: ControlUIDocumentHost.scopedDashboardScript(
                    NativeConversationContract.hostScript,
                    url: url),
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
    }

    private static func post(_ expression: String, in webView: WKWebView) async throws -> [String: Any] {
        let result = try await webView.callAsyncJavaScript(
            "return await fixturePost(\(expression));",
            in: nil,
            contentWorld: .page)
        return try #require(result as? [String: Any])
    }

    private static let html = """
    <!doctype html><html><head><script>
    window.fixtureChrome = {
      height: getComputedStyle(document.documentElement).getPropertyValue('--openclaw-native-titlebar-height').trim(),
      drag: !!window.webkit.messageHandlers.openclawWindowDrag,
      browser: !!window.webkit.messageHandlers.openclawBrowser,
      dashboard: !!window.__OPENCLAW_NATIVE_WEB_CHROME__
    };
    </script></head><body><script>
    Object.defineProperty(window, '__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__', {
      value: {contract:1, documentId:crypto.randomUUID()}
    });
    window.fixturePost = body => window.webkit.messageHandlers.openclawConversation.postMessage({
      contract:1, documentId:window.__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__.documentId, ...body
    });
    window.fixtureState = (revision, title) => ({revision, title, context:{agentId:'main',sessionKey:'agent:main:thread'},
      run:{active:false}, connection:'connected'});
    window.commandCount = 0;
    window.addEventListener('openclaw:native-conversation-command', event => {
      window.commandCount++;
      window.lastCommand = event.detail;
      const result = {type:'command-result', requestId:event.detail.requestId, ok:true};
      fixturePost(result); fixturePost(result);
    });
    fixturePost({type:'ready',surface:'conversation',capabilities:location.search.includes('features=1')
      ? ['session-facts-v1','session-actions-v1'] : []}).then(reply => window.fixtureReadyReply = reply);
    </script></body></html>
    """
}
