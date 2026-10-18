import OpenClawProtocol
import Testing
@testable import OpenClawKit

struct GatewayLiveTextProjectionTests {
    private func chat(_ fields: [String: AnyCodable], runID: String = "run") -> EventFrame {
        var payload = fields
        payload["runId"] = AnyCodable(runID)
        payload["sessionKey"] = AnyCodable("main")
        payload["state"] = payload["state"] ?? AnyCodable("delta")
        return EventFrame(type: "event", event: "chat", payload: AnyCodable(payload))
    }

    private func assistant(_ data: [String: AnyCodable], runID: String = "run") -> EventFrame {
        EventFrame(type: "event", event: "agent", payload: AnyCodable([
            "runId": AnyCodable(runID),
            "sessionKey": AnyCodable("main"),
            "stream": AnyCodable("assistant"),
            "data": AnyCodable(data),
        ]))
    }

    private func message(_ text: String) -> AnyCodable {
        AnyCodable(["role": "assistant", "content": [["type": "text", "text": text]]])
    }

    private func chatText(_ frame: EventFrame?) -> String? {
        frame?.payload?.dictionaryValue?["message"]?.dictionaryValue?["content"]?
            .arrayValue?.first?.dictionaryValue?["text"]?.stringValue
    }

    private func assistantText(_ frame: EventFrame?) -> String? {
        frame?.payload?.dictionaryValue?["data"]?.dictionaryValue?["text"]?.stringValue
    }

    @Test func `snapshots include the accompanying delta and preserve stream whitespace`() {
        var projection = GatewayLiveTextProjection()
        #expect(self.chatText(projection.project(self.chat([
            "message": self.message(" hello "), "deltaText": AnyCodable("hello "),
        ]))) == " hello ")
        #expect(self.chatText(projection.project(self.chat([
            "deltaText": AnyCodable(" world\n"),
        ]))) == " hello  world\n")
        #expect(self.chatText(projection.project(self.chat([
            "message": self.message("rewritten "), "deltaText": AnyCodable("rewritten "),
            "replace": AnyCodable(true),
        ]))) == "rewritten ")
        #expect(self.chatText(projection.project(self.chat([
            "replace": AnyCodable(true), "deltaText": AnyCodable(""),
        ]))) == "")
        #expect(self.chatText(projection.project(self.chat(["deltaText": AnyCodable("after")]))) == "after")
    }

    @Test func `append preserves snapshot canvas media metadata and envelope ownership`() throws {
        var projection = GatewayLiveTextProjection()
        let canvas = AnyCodable(["type": "canvas", "url": "https://example.invalid/canvas"])
        let image = AnyCodable(["type": "image", "mimeType": "image/png", "data": "synthetic"])
        let snapshot = AnyCodable([
            "role": AnyCodable("assistant"), "timestamp": AnyCodable(123),
            "content": AnyCodable([AnyCodable(["type": "text", "text": "prefix"]), canvas, image]),
        ])
        _ = projection.project(self.chat(["message": snapshot]))
        let append = EventFrame(
            type: "event", event: "chat",
            payload: self.chat(["deltaText": AnyCodable(" suffix")]).payload,
            seq: 7, stateversion: StateVersion(presence: 1, health: 2), recipientprofileid: "profile")
        let result = projection.project(append)
        let projected = try #require(result)
        let message = try #require(projected.payload?.dictionaryValue?["message"]?.dictionaryValue)
        #expect(self.chatText(projected) == "prefix suffix")
        #expect(message["content"]?.arrayValue?.dropFirst().map(\.self) == [canvas, image])
        #expect(message["timestamp"]?.intValue == 123)
        #expect(projected.seq == 7)
        #expect(projected.stateversion?.presence == 1)
        #expect(projected.stateversion?.health == 2)
        #expect(projected.recipientprofileid == "profile")

        let updatedCanvas = AnyCodable(["type": "canvas", "url": "https://example.invalid/revised"])
        _ = projection.project(self.chat(["message": AnyCodable([
            "role": AnyCodable("assistant"),
            "content": AnyCodable([AnyCodable(["type": "text", "text": "revised"]), updatedCanvas]),
        ])]))
        let latest = projection.project(self.chat(["deltaText": AnyCodable(" tail")]))
        #expect(self.chatText(latest) == "revised tail")
        #expect(latest?.payload?.dictionaryValue?["message"]?.dictionaryValue?["content"]?
            .arrayValue?.last == updatedCanvas)
    }

    @Test func `chat and assistant baselines stay independent across runs and items`() {
        var projection = GatewayLiveTextProjection()
        _ = projection.project(self.chat(["message": self.message("display ")]))
        _ = projection.project(self.assistant(["text": AnyCodable("item "), "itemId": AnyCodable("one")]))
        #expect(self.assistantText(projection.project(self.assistant([
            "delta": AnyCodable("one"), "itemId": AnyCodable("one"),
        ]))) == "item one")
        #expect(self.chatText(projection.project(self.chat(["deltaText": AnyCodable("answer")]))) == "display answer")
        #expect(projection.project(self.chat(["deltaText": AnyCodable("other suffix")], runID: "other")) == nil)
        #expect(projection.project(self.assistant([
            "delta": AnyCodable("unknown item"), "itemId": AnyCodable("two"),
        ])) == nil)
        _ = projection.project(self.assistant([
            "text": AnyCodable("second"), "delta": AnyCodable("second"), "itemId": AnyCodable("two"),
        ]))
        #expect(self.assistantText(projection.project(self.assistant([
            "delta": AnyCodable(" item"), "itemId": AnyCodable("two"),
        ]))) == "second item")
        #expect(self.assistantText(projection.project(self.assistant([
            "delta": AnyCodable(""), "replace": AnyCodable(true), "itemId": AnyCodable("two"),
        ]))) == "")
    }

    @Test(arguments: ["final", "aborted", "error"])
    func `terminal events retire baselines and retain terminal messages`(state: String) {
        var projection = GatewayLiveTextProjection()
        _ = projection.project(self.chat(["message": self.message("partial")]))
        _ = projection.project(self.assistant(["text": AnyCodable("partial")]))
        let terminal = self.chat(["state": AnyCodable(state), "message": self.message("settled")])
        #expect(self.chatText(projection.project(terminal)) == "settled")
        #expect(projection.project(self.chat(["deltaText": AnyCodable("late")])) == nil)
        #expect(projection.project(self.assistant(["delta": AnyCodable("late")])) == nil)
    }

    @Test func `tool barriers preserve assistant state and disconnect discards all baselines`() {
        var projection = GatewayLiveTextProjection()
        _ = projection.project(self.chat(["message": self.message("before")]))
        _ = projection.project(self.assistant(["text": AnyCodable("before")]))
        let tool = EventFrame(type: "event", event: "agent", payload: AnyCodable([
            "runId": "run", "sessionKey": "main", "stream": "tool", "data": ["phase": "start"],
        ]))
        #expect(projection.project(tool)?.payload == tool.payload)
        #expect(self.assistantText(projection.project(self.assistant(["delta": AnyCodable(" tool")]))) == "before tool")
        projection.reset()
        #expect(projection.project(self.chat(["deltaText": AnyCodable("after reconnect")])) == nil)
        #expect(projection.project(self.assistant(["delta": AnyCodable("after reconnect")])) == nil)
        #expect(self
            .chatText(projection.project(self.chat(["message": self.message("fresh baseline")]))) == "fresh baseline")
    }
}
