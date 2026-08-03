import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatEventTextTests {
    @Test func `decodes v3 and v4 chat delta payloads`() throws {
        let payloads = [
            #"{"runId":"run-v3","sessionKey":"main","state":"delta","message":{"role":"assistant","content":[{"type":"text","text":"v3 reply"}]}}"#,
            #"{"runId":"run-v4","sessionKey":"main","state":"delta","deltaText":"reply","message":{"role":"assistant","content":[{"type":"text","text":"v4 reply"}]}}"#,
        ]

        let decoded = try payloads.map { payload in
            try JSONDecoder().decode(OpenClawChatEventPayload.self, from: Data(payload.utf8))
        }

        #expect(
            decoded.map { OpenClawChatEventText.assistantText(from: $0) } ==
                ["v3 reply", "v4 reply"])
    }

    @Test func `extracts assistant text from final chat event message`() {
        let event = OpenClawChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "final",
            message: AnyCodable([
                "role": "assistant",
                "content": [
                    ["type": "text", "text": "hello"],
                    ["type": "text", "text": "world"],
                ],
            ]),
            errorMessage: nil)

        #expect(OpenClawChatEventText.assistantText(from: event) == "hello\nworld")
    }

    @Test func `ignores user messages`() {
        let event = OpenClawChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "delta",
            message: AnyCodable([
                "role": "user",
                "content": [["type": "text", "text": "ignore me"]],
            ]),
            errorMessage: nil)

        #expect(OpenClawChatEventText.assistantText(from: event) == nil)
    }

    @Test func `extracts plain string content`() {
        let event = OpenClawChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "final",
            message: AnyCodable([
                "role": "assistant",
                "content": "plain reply",
            ]),
            errorMessage: nil)

        #expect(OpenClawChatEventText.assistantText(from: event) == "plain reply")
    }

    @Test func `ignores non text assistant content blocks`() {
        let event = OpenClawChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "delta",
            message: AnyCodable([
                "role": "assistant",
                "content": [
                    ["type": "thinking", "text": "hidden reasoning"],
                    ["type": "text", "text": "visible reply"],
                    ["type": "toolCall", "text": "tool details"],
                    ["type": "image", "text": "image caption"],
                ],
            ]),
            errorMessage: nil)

        #expect(OpenClawChatEventText.assistantText(from: event) == "visible reply")
    }

    @Test func `keeps legacy untyped assistant content blocks`() {
        let event = OpenClawChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "final",
            message: AnyCodable([
                "role": "assistant",
                "content": [
                    ["text": "legacy reply"],
                    ["type": "", "text": "another legacy reply"],
                ],
            ]),
            errorMessage: nil)

        #expect(OpenClawChatEventText.assistantText(from: event) == "legacy reply\nanother legacy reply")
    }

    @Test func `non text assistant content alone produces no reply`() {
        let event = OpenClawChatEventPayload(
            runId: "run-1",
            sessionKey: "main",
            state: "delta",
            message: AnyCodable([
                "role": "assistant",
                "content": [["type": "toolCall", "text": "tool details"]],
            ]),
            errorMessage: nil)

        #expect(OpenClawChatEventText.assistantText(from: event) == nil)
    }
}
