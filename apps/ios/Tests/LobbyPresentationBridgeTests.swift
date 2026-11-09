import Foundation
import Testing
import UIKit
import WebKit
@testable import OpenClaw

@MainActor
@Suite(.serialized)
struct LobbyPresentationBridgeTests {
    @Test func `component prompts admit only conversational text and the exact dashboard route`() throws {
        let expected = try #require(URL(string: "https://gateway.example:18996/focus/dashboard/main/~key/lobby-a"))
        #expect(LobbyPromptBridge.matches(expected, expected: expected))
        for value in [
            "https://gateway.example:18996/focus/dashboard/main/~key/lobby-b",
            "https://gateway.example:18997/focus/dashboard/main/~key/lobby-a",
            "https://other.example:18996/focus/dashboard/main/~key/lobby-a",
            "http://gateway.example:18996/focus/dashboard/main/~key/lobby-a",
        ] {
            #expect(!LobbyPromptBridge.matches(URL(string: value), expected: expected))
        }
        #expect(LobbyPromptBridge.text(["text": "  Compare these plans  "]) == "Compare these plans")
        for text in ["", "  ", "/new", " !exec", String(repeating: "a", count: 4001)] {
            #expect(LobbyPromptBridge.text(["text": text]) == nil)
        }
        #expect(LobbyPromptBridge.text(["text": 42]) == nil)
    }

    @Test func `native prompt bridge acknowledges custody and rejects an embedded frame`() async throws {
        let url = try #require(URL(string: "https://gateway.example.test/focus/dashboard/main/~key/lobby-a"))
        var received: [String] = []
        var selected: [LobbyComponentSelection?] = []
        let bridge = LobbyPromptBridge(url: url) { text in received.append(text)
            return true
        }
        let configuration = WKWebViewConfiguration()
        bridge.onSelection = { selected.append($0) }
        configuration.userContentController.addScriptMessageHandler(
            bridge,
            contentWorld: .page,
            name: LobbyPromptBridge.name)
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), configuration: configuration)
        bridge.webView = webView
        let window = UIWindow(frame: webView.frame)
        let controller = UIViewController()
        controller.view = webView
        window.rootViewController = controller
        window.isHidden = false
        defer {
            window.isHidden = true
            bridge.webView = nil
            configuration.userContentController.removeScriptMessageHandler(
                forName: LobbyPromptBridge.name,
                contentWorld: .page)
        }
        webView.loadHTMLString(
            "<main>Prompt fixture</main><iframe srcdoc='<p>Untrusted component</p>'></iframe>",
            baseURL: url)
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while webView.isLoading, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(!webView.isLoading)
        let accepted = try await webView.callAsyncJavaScript(
            "return await window.webkit.messageHandlers.openclawLobbyPrompt.postMessage({text:'Compare plans'});",
            arguments: [:], in: nil, contentWorld: .page)
        #expect(accepted as? Bool == true)
        #expect(received == ["Compare plans"])
        let selection = try await webView.callAsyncJavaScript(
            "return await window.webkit.messageHandlers.openclawLobbyPrompt.postMessage({kind:'selection',name:'plan',instanceId:'current-frame'});",
            arguments: [:], in: nil, contentWorld: .page)
        #expect(selection as? Bool == true)
        #expect(selected == [LobbyComponentSelection(name: "plan", instanceID: "current-frame")])
        let invalidSelection = try await webView.callAsyncJavaScript(
            "return await window.webkit.messageHandlers.openclawLobbyPrompt.postMessage({kind:'selection',name:'plan'});",
            arguments: [:], in: nil, contentWorld: .page)
        #expect(invalidSelection as? Bool == false)
        let rejected = try await webView.callAsyncJavaScript(
            "return await document.querySelector('iframe').contentWindow.webkit.messageHandlers.openclawLobbyPrompt.postMessage({text:'From frame'});",
            arguments: [:], in: nil, contentWorld: .page)
        #expect(rejected as? Bool == false)
        #expect(received == ["Compare plans"])
    }

    @Test func `Lobby confines pinch to components without disabling other dashboards`() async throws {
        let url = try #require(URL(string: "https://gateway.example.test/dashboard/main/~key/lobby?presentation=lobby"))
        for isLobby in [false, true] {
            let coordinator = AuthenticatedControlUIWebViewCoordinator(url: url, tls: nil, isLobby: isLobby)
            let configuration = WKWebViewConfiguration()
            configuration.ignoresViewportScaleLimits = false
            coordinator.installUserScripts(in: configuration.userContentController)
            let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 600), configuration: configuration)
            coordinator.attachNativeAuthDocument(to: webView)
            webView.navigationDelegate = coordinator
            webView.loadHTMLString(
                """
                <meta name="viewport" content="width=device-width,initial-scale=1,minimum-scale=0.25,maximum-scale=5,viewport-fit=cover">
                <main>Component fixture</main>
                """, baseURL: url)
            let deadline = ContinuousClock.now.advanced(by: .seconds(5))
            while webView.isLoading, ContinuousClock.now < deadline {
                try await Task.sleep(for: .milliseconds(10))
            }
            #expect(!webView.isLoading)
            let viewport = try #require(try await webView.evaluateJavaScript(
                "document.querySelector('meta[name=viewport]').content") as? String)
            #expect(viewport.contains("viewport-fit=cover"))
            #expect(viewport.contains(isLobby ? "maximum-scale=1" : "maximum-scale=5"))
            #expect(viewport.contains("user-scalable=no") == isLobby)
            #expect(webView.scrollView.bouncesZoom == !isLobby)
            // The loaded document, not a transient recognizer flag, defines the page's zoom range.
            if isLobby {
                let layoutDeadline = ContinuousClock.now.advanced(by: .seconds(5))
                while webView.scrollView.minimumZoomScale != webView.scrollView.maximumZoomScale,
                      ContinuousClock.now < layoutDeadline
                {
                    try await Task.sleep(for: .milliseconds(10))
                }
                #expect(webView.scrollView.minimumZoomScale == webView.scrollView.maximumZoomScale)
            } else {
                #expect(webView.scrollView.maximumZoomScale > webView.scrollView.minimumZoomScale)
            }
        }
    }
}
