import Foundation
import Testing

@testable import OpenClaw

/// Use the app module's AnyCodable (OpenClawKit.AnyCodable) which has helper extensions.
private typealias AC = OpenClaw.AnyCodable

struct ReplyNotificationObserverTests {
    // MARK: - AnyCodable payload parsing (data path the observer relies on)

    @Test("AnyCodable decodes nested chat final message structure")
    func decodesNestedMessage() throws {
        let json = """
        {
            "runId": "run-123",
            "sessionKey": "main",
            "state": "final",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "Hello world"}]
            }
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode([String: AC].self, from: data)
        let state = payload["state"]?.stringValue
        #expect(state == "final")

        let msgDict = payload["message"]?.dictionaryValue
        let content = msgDict?["content"]?.arrayValue
        let text = content?.first?.dictionaryValue?["text"]?.stringValue
        #expect(text == "Hello world")
    }

    @Test("AnyCodable decodes null message")
    func decodesNullMessage() throws {
        let json = """
        {
            "runId": "run-456",
            "sessionKey": "main",
            "state": "final",
            "message": null
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode([String: AC].self, from: data)
        let state = payload["state"]?.stringValue
        #expect(state == "final")
        #expect(payload["message"]?.value is NSNull)
    }

    @Test("AnyCodable decodes missing message key")
    func decodesMissingMessage() throws {
        let json = """
        {
            "runId": "run-789",
            "sessionKey": "main",
            "state": "final"
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode([String: AC].self, from: data)
        #expect(payload["message"] == nil)
    }

    @Test("AnyCodable decodes non-final state")
    func decodesNonFinalState() throws {
        let json = """
        {
            "runId": "run-000",
            "sessionKey": "main",
            "state": "streaming",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "partial"}]
            }
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode([String: AC].self, from: data)
        let state = payload["state"]?.stringValue
        #expect(state == "streaming")
        #expect(state != "final")
    }

    @Test("AnyCodable decodes empty content array")
    func decodesEmptyContent() throws {
        let json = """
        {
            "state": "final",
            "message": {
                "role": "assistant",
                "content": []
            }
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode([String: AC].self, from: data)
        let msgDict = payload["message"]?.dictionaryValue
        let content = msgDict?["content"]?.arrayValue
        #expect(content?.isEmpty == true)
    }

    @Test("AnyCodable decodes content without text key")
    func decodesContentWithoutText() throws {
        let json = """
        {
            "state": "final",
            "message": {
                "role": "assistant",
                "content": [{"type": "tool_use", "name": "bash"}]
            }
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode([String: AC].self, from: data)
        let msgDict = payload["message"]?.dictionaryValue
        let content = msgDict?["content"]?.arrayValue
        let text = content?.first?.dictionaryValue?["text"]?.stringValue
        #expect(text == nil)
    }

    @Test("foundationValue converts AnyCodable tree to native types")
    func foundationValueConversion() throws {
        let json = """
        {
            "state": "final",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "converted"}]
            }
        }
        """
        let data = json.data(using: .utf8)!
        let payload = try JSONDecoder().decode([String: AC].self, from: data)
        // foundationValue recursively unwraps to native types
        let native = payload["message"]!.foundationValue
        let msgDict = native as? [String: Any]
        let content = msgDict?["content"] as? [[String: Any]]
        let text = content?.first?["text"] as? String
        #expect(text == "converted")
    }

    // MARK: - extractPreview

    @Test("extractPreview returns text for valid message dict")
    @MainActor
    func extractPreviewValid() {
        let msg: [String: Any] = [
            "role": "assistant",
            "content": [["type": "text", "text": "Hello world"]],
        ]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == "Hello world")
    }

    @Test("extractPreview returns nil for nil message")
    @MainActor
    func extractPreviewNil() {
        let result = ReplyNotificationObserver.shared.extractPreview(from: nil)
        #expect(result == nil)
    }

    @Test("extractPreview returns nil for non-dict message")
    @MainActor
    func extractPreviewNonDict() {
        let result = ReplyNotificationObserver.shared.extractPreview(from: "not a dict")
        #expect(result == nil)
    }

    @Test("extractPreview returns nil for dict missing content key")
    @MainActor
    func extractPreviewNoContent() {
        let msg: [String: Any] = ["role": "assistant"]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == nil)
    }

    @Test("extractPreview returns nil for empty content array")
    @MainActor
    func extractPreviewEmptyContent() {
        let msg: [String: Any] = ["content": [[String: Any]]()]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == nil)
    }

    @Test("extractPreview returns nil for content block without text key")
    @MainActor
    func extractPreviewNoTextKey() {
        let msg: [String: Any] = ["content": [["type": "tool_use", "name": "bash"]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == nil)
    }

    @Test("extractPreview returns nil for whitespace-only text")
    @MainActor
    func extractPreviewWhitespace() {
        let msg: [String: Any] = ["content": [["type": "text", "text": "   \n  "]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == nil)
    }

    @Test("extractPreview returns nil for empty text")
    @MainActor
    func extractPreviewEmptyText() {
        let msg: [String: Any] = ["content": [["type": "text", "text": ""]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == nil)
    }

    @Test("extractPreview returns short text unmodified")
    @MainActor
    func extractPreviewShortText() {
        let msg: [String: Any] = ["content": [["type": "text", "text": "Short reply."]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == "Short reply.")
    }

    @Test("extractPreview passes through text at exactly 120 chars")
    @MainActor
    func extractPreviewBoundary120() {
        let text = String(repeating: "A", count: 120)
        let msg: [String: Any] = ["content": [["type": "text", "text": text]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == text)
        #expect(result?.count == 120)
    }

    @Test("extractPreview truncates text at 121 chars to 117 + ellipsis")
    @MainActor
    func extractPreviewBoundary121() {
        let text = String(repeating: "B", count: 121)
        let msg: [String: Any] = ["content": [["type": "text", "text": text]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result != text)
        #expect(result == String(repeating: "B", count: 117) + "\u{2026}")
        #expect(result?.count == 118)
        #expect(result?.hasSuffix("\u{2026}") == true)
    }

    @Test("extractPreview truncates very long text")
    @MainActor
    func extractPreviewLongText() {
        let text = String(repeating: "C", count: 500)
        let msg: [String: Any] = ["content": [["type": "text", "text": text]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result?.count == 118)
        #expect(result?.hasPrefix(String(repeating: "C", count: 117)) == true)
        #expect(result?.hasSuffix("\u{2026}") == true)
    }

    @Test("extractPreview trims leading/trailing whitespace before checking length")
    @MainActor
    func extractPreviewTrimsWhitespace() {
        let inner = String(repeating: "D", count: 50)
        let padded = "   \(inner)   "
        let msg: [String: Any] = ["content": [["type": "text", "text": padded]]]
        let result = ReplyNotificationObserver.shared.extractPreview(from: msg)
        #expect(result == inner)
    }

    // MARK: - Observer lifecycle

    @Test("setPanelVisible accepts boolean values")
    @MainActor
    func setPanelVisibleCallable() {
        ReplyNotificationObserver.shared.setPanelVisible(true)
        ReplyNotificationObserver.shared.setPanelVisible(false)
    }

    @Test("stop is safe to call even when not started")
    @MainActor
    func stopWithoutStart() {
        ReplyNotificationObserver.shared.stop()
    }

    // MARK: - AppState.replyNotificationsEnabled

    @Test("AppState defaults replyNotificationsEnabled to true when no stored value")
    @MainActor
    func appStateReplyNotificationsDefault() async {
        await TestIsolation.withUserDefaultsValues([replyNotificationsEnabledKey: nil]) {
            let state = AppState(preview: true)
            #expect(state.replyNotificationsEnabled == true)
        }
    }

    @Test("AppState reads stored replyNotificationsEnabled value")
    @MainActor
    func appStateReplyNotificationsStored() async {
        await TestIsolation.withUserDefaultsValues([replyNotificationsEnabledKey: false]) {
            let state = AppState(preview: true)
            #expect(state.replyNotificationsEnabled == false)
        }
    }

    @Test("replyNotificationsEnabledKey constant matches expected value")
    func constantKey() {
        #expect(replyNotificationsEnabledKey == "openclaw.replyNotificationsEnabled")
    }

    // MARK: - cleanPreviewForNotification (markdown stripping for notification body)

    @Test("cleanPreviewForNotification strips trailing double asterisks")
    @MainActor
    func cleanPreviewTrailingDoubleAsterisks() {
        let result = ReplyNotificationObserver.cleanPreviewForNotification("Interesting. The observer **")
        #expect(result == "Interesting. The observer")
    }

    @Test("cleanPreviewForNotification strips leading and trailing double asterisks")
    @MainActor
    func cleanPreviewLeadingTrailingBold() {
        let result = ReplyNotificationObserver.cleanPreviewForNotification("**bold**")
        #expect(result == "bold")
    }

    @Test("cleanPreviewForNotification strips single asterisks")
    @MainActor
    func cleanPreviewSingleAsterisks() {
        let result = ReplyNotificationObserver.cleanPreviewForNotification("*italic*")
        #expect(result == "italic")
    }

    @Test("cleanPreviewForNotification strips double underscores")
    @MainActor
    func cleanPreviewDoubleUnderscores() {
        let result = ReplyNotificationObserver.cleanPreviewForNotification("__bold__")
        #expect(result == "bold")
    }

    @Test("cleanPreviewForNotification leaves text without markdown unchanged")
    @MainActor
    func cleanPreviewNoMarkdown() {
        let text = "Dismiss the panel — notification incoming in 3"
        let result = ReplyNotificationObserver.cleanPreviewForNotification(text)
        #expect(result == text)
    }

    @Test("cleanPreviewForNotification trims whitespace")
    @MainActor
    func cleanPreviewTrimsWhitespace() {
        let result = ReplyNotificationObserver.cleanPreviewForNotification("  hello **  ")
        #expect(result == "hello")
    }
}
