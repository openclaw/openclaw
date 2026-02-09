import AppKit
import EasyHubChatUI
import Foundation
import Testing
@testable import EasyHub

@Suite(.serialized)
@MainActor
struct WebChatSwiftUISmokeTests {
    private struct TestTransport: EasyHubChatTransport, Sendable {
        func requestHistory(sessionKey: String) async throws -> EasyHubChatHistoryPayload {
            let json = """
            {"sessionKey":"\(sessionKey)","sessionId":null,"messages":[],"thinkingLevel":"off"}
            """
            return try JSONDecoder().decode(EasyHubChatHistoryPayload.self, from: Data(json.utf8))
        }

        func sendMessage(
            sessionKey _: String,
            message _: String,
            thinking _: String,
            idempotencyKey _: String,
            attachments _: [EasyHubChatAttachmentPayload]) async throws -> EasyHubChatSendResponse
        {
            let json = """
            {"runId":"\(UUID().uuidString)","status":"ok"}
            """
            return try JSONDecoder().decode(EasyHubChatSendResponse.self, from: Data(json.utf8))
        }

        func requestHealth(timeoutMs _: Int) async throws -> Bool { true }

        func events() -> AsyncStream<EasyHubChatTransportEvent> {
            AsyncStream { continuation in
                continuation.finish()
            }
        }

        func setActiveSessionKey(_: String) async throws {}
    }

    @Test func windowControllerShowAndClose() {
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .window,
            transport: TestTransport())
        controller.show()
        controller.close()
    }

    @Test func panelControllerPresentAndClose() {
        let anchor = { NSRect(x: 200, y: 400, width: 40, height: 40) }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: "main",
            presentation: .panel(anchorProvider: anchor),
            transport: TestTransport())
        controller.presentAnchored(anchorProvider: anchor)
        controller.close()
    }
}
