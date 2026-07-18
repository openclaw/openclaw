import AppKit
import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct WebChatSwiftUISmokeTests {
    private struct TestTransport: OpenClawChatTransport {
        func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
            let json = """
            {"sessionKey":"\(sessionKey)","sessionId":null,"messages":[],"thinkingLevel":"off"}
            """
            return try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: Data(json.utf8))
        }

        func sendMessage(
            sessionKey _: String,
            message _: String,
            thinking _: String,
            idempotencyKey _: String,
            attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
        {
            let json = """
            {"runId":"\(UUID().uuidString)","status":"ok"}
            """
            return try JSONDecoder().decode(OpenClawChatSendResponse.self, from: Data(json.utf8))
        }

        func requestHealth(timeoutMs _: Int) async throws -> Bool {
            true
        }

        func events() -> AsyncStream<OpenClawChatTransportEvent> {
            AsyncStream { continuation in
                continuation.finish()
            }
        }

        func setActiveSessionKey(_: String) async throws {}
    }

    @Test func `window controller merges titlebar and keeps toolbar controls`() throws {
        let traceKey = OpenClawChatWindowShell.assistantTraceDefaultsKey
        let previousTraceValue = UserDefaults.standard.object(forKey: traceKey)
        UserDefaults.standard.removeObject(forKey: traceKey)
        defer {
            if let previousTraceValue {
                UserDefaults.standard.set(previousTraceValue, forKey: traceKey)
            } else {
                UserDefaults.standard.removeObject(forKey: traceKey)
            }
        }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .window,
            transport: TestTransport())
        let window = try #require(controller._testWindow)
        let capabilities = try #require(controller._testChatCapabilities)

        #expect(window.styleMask.contains(.fullSizeContentView))
        #expect(window.titleVisibility == .hidden)
        #expect(window.titlebarAppearsTransparent)
        #expect(window.toolbarStyle == .unified)
        #expect(window.titlebarSeparatorStyle == .none)
        #expect(window.isMovableByWindowBackground)
        #expect(controller._testSceneBridgingOptions?.contains(.toolbars) == true)
        #expect(controller._testSceneBridgingOptions?.contains(.title) == false)
        #expect(capabilities.hasTalkControl)
        #expect(capabilities.hasSpeech)
        #expect(capabilities.hasVoiceNoteControl)
        #expect(capabilities.showsAssistantTrace)

        controller.show()
        #expect(window.titleVisibility == .hidden)
        #expect(window.toolbar != nil)
        controller.close()
    }

    @Test func `panel controller present and close`() {
        let anchor = { NSRect(x: 200, y: 400, width: 40, height: 40) }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .panel(anchorProvider: anchor),
            transport: TestTransport())
        controller.presentAnchored(anchorProvider: anchor)
        controller.close()
    }

    @Test func `controller explicit agent wins and nil falls back to cached default`() throws {
        let cachedIdentity = try #require(OpenClawChatSessionRoutingIdentity(
            scope: "global",
            mainSessionKey: "main",
            defaultAgentID: "main"))
        let explicit = WebChatSwiftUIWindowController(
            sessionKey: "global",
            agentID: " Work ",
            presentation: .window,
            cachedRoutingIdentity: cachedIdentity,
            store: nil)
        let fallback = WebChatSwiftUIWindowController(
            sessionKey: "global",
            agentID: nil,
            presentation: .window,
            cachedRoutingIdentity: cachedIdentity,
            store: nil)

        #expect(explicit._testActiveAgentID == "work")
        #expect(fallback._testActiveAgentID == "main")
        explicit.close()
        fallback.close()
    }

    @Test func `max and Ultra thinking preferences survive reopen`() throws {
        let suiteName = "WebChatSwiftUISmokeTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        for level in ["max", "ultra"] {
            defaults.set(level, forKey: "openclaw.webchat.thinkingLevel")
            #expect(WebChatSwiftUIWindowController.persistedThinkingLevel(defaults: defaults) == level)
        }
    }
}
