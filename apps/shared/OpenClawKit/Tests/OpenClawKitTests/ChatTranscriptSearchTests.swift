#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatTranscriptSearchTests {
    @Test func `find searches message text without exposing reasoning or tool payloads`() {
        let user = self.message("Find the café", role: "user")
        let assistant = self.message("<think>hidden needle</think>\nThe CAFÉ is open")
        let tool = self.message("café tool payload", role: "toolResult")
        let rows = ChatTranscriptRow.build(from: [user, assistant, tool])

        #expect(ChatTranscriptSearchResults(rows: rows, query: " cafe ").messageIDs == [user.id, assistant.id])
        #expect(ChatTranscriptSearchResults(rows: rows, query: "hidden needle").messageIDs.isEmpty)
        #expect(ChatTranscriptSearchResults(rows: rows, query: "tool payload").messageIDs.isEmpty)
        #expect(ChatTranscriptSearchResults(rows: rows, query: " \n ").messageIDs.isEmpty)
    }

    @Test func `find wraps in both directions and recovers when the selected message disappears`() {
        let first = self.message("match one", role: "user")
        let second = self.message("match two")
        let third = self.message("match three")
        let results = ChatTranscriptSearchResults(
            rows: [.message(first), .message(second), .message(third)], query: "match")

        #expect(results.selection(after: nil) == first.id)
        #expect(results.selection(after: first.id) == second.id)
        #expect(results.selection(after: second.id) == third.id)
        #expect(results.selection(after: third.id) == first.id)
        #expect(results.selection(after: first.id, backwards: true) == third.id)
        #expect(results.selection(after: second.id, backwards: true) == first.id)
        let refreshed = ChatTranscriptSearchResults(rows: [.message(first)], query: "match")
        #expect(refreshed.selection(after: second.id) == first.id)
        #expect(refreshed.selection(after: first.id) == first.id)
        #expect(ChatTranscriptSearchResults(rows: [], query: "match").selection(after: first.id) == nil)
    }

    @Test func `find matches visible phrases across emphasis and keeps literal code searchable`() {
        let user = self.message("A **red** fox", role: "user")
        let assistant = self.message("A _réd_ fox")
        let plain = self.message("a red fox")
        let code = self.message("A `**red**` fox")
        let rows = [user, assistant, plain, code].map(ChatTranscriptRow.message)

        let phrase = ChatTranscriptSearchResults(rows: rows, query: "red fox")
        #expect(phrase.messageIDs == [user.id, assistant.id, plain.id])
        #expect(ChatTranscriptSearchResults(rows: rows, query: "**red**").messageIDs == [user.id, code.id])
    }

    @Test func `find matches phrases across inline code and link labels within one paragraph`() {
        let code = self.message("Pick ripe `pears` today.", role: "user")
        let link = self.message("Pick ripe [pears](#fruit) today.")
        let separate = self.message("Pick ripe\n\n`pears` today.")
        let rows = [code, link, separate].map(ChatTranscriptRow.message)

        #expect(ChatTranscriptSearchResults(rows: rows, query: "ripe pears").messageIDs == [code.id, link.id])
        #expect(ChatTranscriptSearchResults(rows: rows, query: "`pears`").messageIDs == [code.id, separate.id])
        #expect(ChatTranscriptSearchResults(rows: rows, query: "[pears](#fruit)").messageIDs == [link.id])
    }

    @Test(arguments: [
        ("A ~~red~~ fox", "red fox"),
        ("Use \\#1 today", "Use #1 today"),
        ("Tea &amp; pears", "Tea & pears"),
    ])
    func `find matches rendered strikethrough escapes and entities`(source: String, phrase: String) {
        let formatted = self.message(source)
        let plain = self.message(phrase, role: "user")
        let rows = [formatted, plain].map(ChatTranscriptRow.message)

        #expect(ChatTranscriptSearchResults(rows: rows, query: phrase).messageIDs == [formatted.id, plain.id])
        #expect(ChatTranscriptSearchResults(rows: rows, query: source).messageIDs == [formatted.id])
    }

    private func message(_ text: String, role: String = "assistant") -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: role,
            content: [OpenClawChatMessageContent(
                type: "text", text: text, mimeType: nil, fileName: nil, content: nil)],
            timestamp: 1)
    }
}
#endif
