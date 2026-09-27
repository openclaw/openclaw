import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

struct ChatWorkingCommentaryTests {
    private func message(_ json: String) throws -> OpenClawChatMessage {
        try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(json.utf8))
    }

    private func item(runID: String = "active", itemID: String = "latest", text: String,
                      phase: String = "end", ts: Int = 4000, seq: Int = 4) throws -> OpenClawAgentEventPayload
    {
        let json: [String: Any] = [
            "runId": runID, "stream": "item", "seq": seq, "ts": ts,
            "data": ["kind": "preamble", "itemId": itemID, "progressText": text, "phase": phase],
        ]
        return try JSONDecoder().decode(OpenClawAgentEventPayload.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func latestCompletedItemReplacesOnlyItsOwnTranscriptRow() throws {
        let earlier = try self.message(#"{"role":"assistant","timestamp":2000,"__openclaw":{"runId":"active"},"openclawStreamFallback":{"source":"segment","itemId":"earlier","runId":"active"},"content":"Reading files."}"#)
        let mirror = try self.message(#"{"role":"assistant","timestamp":4000,"__openclaw":{"runId":"active"},"openclawStreamFallback":{"source":"segment","itemId":"latest","runId":"active"},"content":"Checking tests."}"#)
        let history = [earlier, mirror]
        let live = try #require(ChatWorkingCommentary.completedItem(self.item(text: "Checking tests.")))
        let selected = try #require(ChatWorkingCommentary.latest(runID: "active", messages: history, live: live))
        #expect(selected.text == "Checking tests.")
        #expect(history.count == 2)
        #expect(selected.transcriptMessage(earlier) == earlier)
        #expect(selected.transcriptMessage(mirror) == nil)
        #expect(ChatWorkingCommentary.latest(runID: "another", messages: history, live: live) == nil)
        // Settlement restores the unchanged canonical row.
        #expect(history.last?.content.first?.text == "Checking tests.")
    }

    @Test func recoveredCommentaryUsesRunScopedHistoryWithoutALiveItem() throws {
        let other = try self.message(#"{"role":"assistant","phase":"commentary","timestamp":9000,"__openclaw":{"runId":"other"},"content":"Other run."}"#)
        let prior = try self.message(#"{"role":"assistant","phase":"commentary","timestamp":2000,"__openclaw":{"runId":"active"},"content":"Reading files."}"#)
        let latest = try self.message(#"{"role":"assistant","phase":"commentary","timestamp":3000,"__openclaw":{"runId":"active"},"content":"Checking tests."}"#)
        let selected = try #require(ChatWorkingCommentary.latest(runID: "active", messages: [other, prior, latest], live: nil))
        #expect(selected.text == "Checking tests.")
        #expect(selected.transcriptMessage(prior) == prior)
        #expect(selected.transcriptMessage(latest) == nil)
    }

    @Test func mixedCommentaryPreservesTheFinalAnswerAndItsIdentity() throws {
        let mixed = try self.message(#"{"role":"assistant","phase":"commentary","timestamp":3000,"__openclaw":{"runId":"active"},"content":[{"type":"text","text":"Checking once more.","textSignature":"{\"v\":1,\"phase\":\"commentary\"}"},{"type":"text","text":"Ready.","textSignature":"{\"v\":1,\"phase\":\"final_answer\"}"}]}"#)
        let selected = try #require(ChatWorkingCommentary.latest(runID: "active", messages: [mixed], live: nil))
        #expect(selected.text == "Checking once more.")
        let displayed = try #require(selected.transcriptMessage(mixed))
        #expect(displayed.id == mixed.id)
        #expect(displayed.content.map(\.text) == ["Ready."])
        #expect(displayed.phase == nil)
        #expect(mixed.content.count == 2)
    }

    @Test func incompleteItemsAndUnrelatedRunsDoNotChangeTheStatus() throws {
        #expect(ChatWorkingCommentary.completedItem(try self.item(text: "Draft", phase: "update")) == nil)
        #expect(ChatWorkingCommentary.completedItem(try self.item(text: "  ")) == nil)
        let live = try #require(ChatWorkingCommentary.completedItem(self.item(text: "Latest.", ts: 4000)))
        let stale = try self.message(#"{"role":"assistant","phase":"commentary","timestamp":3000,"__openclaw":{"runId":"active"},"content":"Older."}"#)
        #expect(ChatWorkingCommentary.latest(runID: "active", messages: [stale], live: live)?.text == "Latest.")
        #expect(ChatWorkingCommentary.latest(runID: "sibling", messages: [stale], live: live) == nil)
    }

    @Test func unphasedAnswerSegmentIsNotPromotedOrRemoved() throws {
        let answer = try self.message(#"{"role":"assistant","timestamp":5000,"__openclaw":{"runId":"active"},"openclawStreamFallback":{"source":"segment","itemId":"answer","runId":"active"},"content":"The result is ready."}"#)
        #expect(ChatWorkingCommentary.latest(runID: "active", messages: [answer], live: nil) == nil)
        let live = try #require(ChatWorkingCommentary.completedItem(self.item(text: "**Checking** tests.")))
        #expect(live.text == "Checking tests.")
        #expect(live.matchesStreamingText("**Checking** tests.\n"))
        let selected = try #require(ChatWorkingCommentary.latest(runID: "active", messages: [answer], live: live))
        #expect(selected.text == "Checking tests.")
        #expect(selected.transcriptMessage(answer) == answer)
    }

    @Test func signedCommentaryDoesNotAuthorizeAnUnphasedFinalWithTheSameSegmentID() throws {
        let commentary = try self.message(#"{"role":"assistant","timestamp":3000,"__openclaw":{"runId":"active"},"openclawStreamFallback":{"source":"segment","itemId":"shared","runId":"active"},"content":[{"type":"text","text":"Checking.","textSignature":"{\"v\":1,\"phase\":\"commentary\"}"}]}"#)
        let answer = try self.message(#"{"role":"assistant","timestamp":4000,"__openclaw":{"runId":"active"},"openclawStreamFallback":{"source":"segment","itemId":"shared","runId":"active"},"content":"Done."}"#)
        let selected = try #require(ChatWorkingCommentary.latest(runID: "active", messages: [commentary, answer], live: nil))
        #expect(selected.text == "Checking.")
        #expect(selected.itemID == nil)
        #expect(selected.transcriptMessage(commentary) == nil)
        #expect(selected.transcriptMessage(answer) == answer)

        let mixed = try self.message(#"{"role":"assistant","phase":"commentary","timestamp":5000,"__openclaw":{"runId":"active"},"content":[{"type":"text","text":"Checking.","textSignature":"{\"v\":1,\"phase\":\"commentary\"}"},{"type":"text","text":"Done."}]}"#)
        let mixedStatus = try #require(ChatWorkingCommentary.latest(runID: "active", messages: [mixed], live: nil))
        #expect(mixedStatus.text == "Checking.")
        #expect(mixedStatus.transcriptMessage(mixed)?.content.map(\.text) == ["Done."])
    }
}
