import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

extension OpenClawChatMessage {
    /// The same row as recorded for a model that answered it.
    func answered(by provider: String, model: String, served: String? = nil) -> Self {
        guard self.role.lowercased() == "assistant" else { return self }
        var copy = self
        copy.provider = provider
        copy.model = model
        copy.responseModel = served
        return copy
    }
}

extension [OpenClawChatMessage] {
    /// Fixtures written for folding read as an OpenAI model's: only those turns fold (web isOpenAIWorkSegment).
    func answeredByOpenAI() -> Self {
        self.map { $0.provider == nil ? $0.answered(by: "openai", model: "gpt-5.6") : $0 }
    }
}

extension [ChatTranscriptRow] {
    func answeredByOpenAI() -> Self {
        self.map { row in
            guard case let .message(message) = row else { return row }
            return .message([message].answeredByOpenAI()[0])
        }
    }
}

/// Victor's rule, one case per row: only a turn an OpenAI model answered folds into "Worked"; every other model's
/// text stays where it was said and its tools read as activity logs (web chat-turn-presentation.ts:186-243).
@Suite("Reply outside Worked")
struct ChatReplyPhaseTests {
    @Test func `openai commentary folds with its tools above the final answer`() {
        let rows = Self.collapse(
            [
                Self.user,
                Self.text("Checking the layout", at: 2, phase: "commentary"),
                Self.call("read", at: 3),
                Self.text("The layout is ready", at: 4, phase: "final_answer"),
            ],
            provider: "openai",
            model: "gpt-5.6")
        #expect(Self.shape(rows) == ["user", "work:2", "The layout is ready"])
    }

    @Test func `openai final answer stays visible when a tool follows it`() {
        let rows = Self.collapse(
            [
                Self.user,
                Self.call("read", at: 2),
                Self.text("Here is the summary", at: 3, phase: "final_answer"),
                Self.call("write", at: 4),
            ],
            provider: "openai",
            model: "gpt-5.6")
        #expect(Self.shape(rows) == ["user", "work:2", "Here is the summary"])
    }

    @Test func `without a phase text before a tool call is the reply`() {
        let rows = Self.collapse(
            [
                Self.user,
                Self.text("Yes, all seven are merged.", at: 2, stop: "toolUse"),
                Self.call("write", at: 3),
                Self.text("Saved the notes.", at: 4),
            ],
            provider: "anthropic",
            model: "claude-opus-5-5")
        #expect(Self.shape(rows) == ["user", "Yes, all seven are merged.", "tool", "Saved the notes."])
    }

    @Test func `without a phase text between tool calls stays between them`() {
        let rows = Self.collapse(
            [
                Self.user,
                Self.call("read", at: 2),
                Self.call("grep", at: 3),
                Self.text("Found it in the header.", at: 4, stop: "toolUse"),
                Self.call("edit", at: 5),
                Self.text("Fixed.", at: 6),
            ],
            provider: "clawrouter",
            model: "anthropic/claude-fable-5-2",
            served: "claude-fable-5-2")
        #expect(Self.shape(rows) == ["user", "activity:2", "Found it in the header.", "tool", "Fixed."])
    }

    @Test func `without a phase text after the last tool call closes the turn without a fold`() {
        let rows = Self.collapse(
            [Self.user, Self.call("read", at: 2), Self.call("grep", at: 3), Self.text("Done.", at: 4)],
            provider: "zai",
            model: "glm-5.3-flash")
        #expect(Self.shape(rows) == ["user", "activity:2", "Done."])
    }

    @Test func `text only never folds`() {
        let rows = Self.collapse(
            [Self.user, Self.text("Hello", at: 2), Self.text("Anything else?", at: 3)],
            provider: "anthropic",
            model: "claude-opus-5-5")
        #expect(Self.shape(rows) == ["user", "Hello", "Anything else?"])
    }

    @Test func `tool calls only read as one activity log`() {
        let rows = Self.collapse(
            [Self.user, Self.call("read", at: 2), Self.call("grep", at: 3)],
            provider: "anthropic",
            model: "claude-opus-5-5")
        #expect(Self.shape(rows) == ["user", "activity:2"])
    }

    @Test func `the served model decides, not the route or the composer`() {
        let routed = OpenClawChatMessage(role: "assistant", content: [], timestamp: 1)
        #expect(routed.answered(by: "clawrouter", model: "openai/gpt-5.6").isRecordedOpenAIModel)
        #expect(routed.answered(by: "clawrouter", model: "openai/gpt-5.6", served: "gpt-5.6-2026-10-01")
            .isRecordedOpenAIModel)
        #expect(!routed.answered(by: "clawrouter", model: "openai/gpt-5.6", served: "claude-opus-5-5")
            .isRecordedOpenAIModel)
        #expect(!routed.answered(by: "clawrouter", model: "openai/gpt-5.6", served: "anthropic/claude-opus-5-5")
            .isRecordedOpenAIModel)
        #expect(routed.answered(by: "openai-codex", model: "gpt-5.6").isRecordedOpenAIModel)
        #expect(!routed.answered(by: "anthropic", model: "claude-opus-5-5").isRecordedOpenAIModel)
        #expect(!routed.isRecordedOpenAIModel, "No recorded model is not OpenAI")
    }

    @Test func `a turn with another model in it does not fold, and host rows are not authors`() {
        let mixed = [
            Self.user,
            Self.text("Checking", at: 2, phase: "commentary").answered(by: "openai", model: "gpt-5.6"),
            Self.call("read", at: 3).answered(by: "anthropic", model: "claude-opus-5-5"),
            Self.text("Done", at: 4, phase: "final_answer").answered(by: "openai", model: "gpt-5.6"),
        ]
        #expect(Self.shape(Self.fold(mixed)) == ["user", "Checking", "tool", "Done"])
        var host = Self.text("Published the change.", at: 5)
        host.provider = "openclaw"
        let withHost = mixed.enumerated()
            .map { $0.offset == 2 ? $0.element.answered(by: "openai", model: "gpt-5.6") : $0.element }
        #expect(Self.shape(Self.fold(withHost + [host])).prefix(2) == ["user", "work:2"])
    }

    // MARK: - Fixtures

    private static let user = OpenClawChatMessage(
        role: "user",
        content: [.init(type: "text", text: "Check it", mimeType: nil, fileName: nil, content: nil)],
        timestamp: 1)

    private static func text(
        _ text: String,
        at time: Double,
        phase: String? = nil,
        stop: String? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: text, mimeType: nil, fileName: nil, content: nil)],
            timestamp: time,
            stopReason: stop,
            phase: phase)
    }

    private static func call(_ name: String, at time: Double) -> OpenClawChatMessage {
        let id = "call-\(Int(time))"
        return OpenClawChatMessage(
            role: "assistant",
            content: [
                .init(type: "toolCall", text: nil, mimeType: nil, fileName: nil, content: nil, id: id, name: name),
                .init(type: "toolResult", text: "ok", mimeType: nil, fileName: nil, content: nil, id: id, name: name),
            ],
            timestamp: time,
            stopReason: "toolUse")
    }

    private static func collapse(
        _ messages: [OpenClawChatMessage], provider: String, model: String,
        served: String? = nil) -> [ChatTranscriptRow]
    {
        self.fold(messages.map { $0.answered(by: provider, model: model, served: served) })
    }

    private static func fold(_ messages: [OpenClawChatMessage]) -> [ChatTranscriptRow] {
        ChatTranscriptRow.collapseCompletedWork(ChatTranscriptRow.build(from: messages), runWorking: false)
    }

    /// Visible text by its words, a tool row as "tool", a fold or activity log by its first row's timestamp.
    private static func shape(_ rows: [ChatTranscriptRow]) -> [String] {
        rows.map { row in
            switch row {
            case let .message(message):
                if message.role == "user" { return "user" }
                let text = message.content.compactMap(\.text).first { $0 != "ok" }
                return text ?? "tool"
            case let .completedWork(work):
                let first = work.messages.first?.timestamp.map { String(Int($0)) } ?? "?"
                return (work.isActivityRun ? "activity:" : "work:") + first
            default:
                return "other"
            }
        }
    }
}
