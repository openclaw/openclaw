import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite("ChatToolActivity")
struct ChatToolActivityTests {
    @Test func `prepared unknown outcome does not become finished from raw result presence`() {
        var item = ChatToolActivityItem(
            id: "call", name: "read", arguments: nil, details: nil,
            resultText: "result", state: .finished, liveDiffStat: nil)
        item.activity = OpenClawAgentActivityItem(
            itemId: "tool:call", toolCallId: "call", kind: "tool", phase: "end",
            title: "Read — outcome unknown", name: "read", status: nil,
            hideFromChannelProgress: nil, suppressChannelProgress: nil)
        #expect(item.displayState == .unavailable)
        #expect(!item.isPending)
        #expect(item.resultText == "result")
        item.activity = OpenClawAgentActivityItem(
            itemId: "tool:call", toolCallId: "call", kind: "tool", phase: "end",
            title: "Read", name: "read", status: "blocked",
            hideFromChannelProgress: nil, suppressChannelProgress: nil)
        #expect(item.displayState == .blocked)
        #expect(!item.isError)
        #expect(!item.isPending)
    }

    @Test func `pairs call and result by ID`() {
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "exec")],
            results: [self.content(type: "toolResult", text: "done", id: "call-1", name: "exec")])

        #expect(items == [ChatToolActivityItem(
            id: "call-1",
            name: "exec",
            arguments: nil,
            details: nil,
            resultText: "done",
            state: .finished,
            liveDiffStat: nil)])
    }

    @Test func `appends orphan result`() {
        let items = ChatToolActivity.items(
            calls: [],
            results: [self.content(type: "toolResult", text: "orphaned", name: "read")])

        #expect(items == [ChatToolActivityItem(
            id: "result-0",
            name: "read",
            arguments: nil,
            details: nil,
            resultText: "orphaned",
            state: .finished,
            liveDiffStat: nil)])
    }

    @Test func `preserves call order`() {
        let items = ChatToolActivity.items(
            calls: [
                self.content(type: "toolCall", id: "call-1", name: "read"),
                self.content(type: "toolCall", id: "call-2", name: "write"),
            ],
            results: [
                self.content(type: "toolResult", text: "second", id: "call-2", name: "write"),
                self.content(type: "toolResult", text: "first", id: "call-1", name: "read"),
            ])

        #expect(items.map(\.id) == ["call-1", "call-2"])
        #expect(items.map(\.resultText) == ["first", "second"])
    }

    @Test func `does not report an unanswered call as finished`() {
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", name: "search")],
            results: [])

        #expect(items == [ChatToolActivityItem(
            id: "call-0",
            name: "search",
            arguments: nil,
            details: nil,
            resultText: nil,
            state: .unavailable,
            liveDiffStat: nil)])
    }

    @Test func `an empty successful result still confirms completion`() {
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "exec")],
            results: [self.content(type: "toolResult", id: "call-1", name: "exec")])

        #expect(items.first?.state == .finished)
    }

    @Test func `threads paired result details`() {
        let details = AnyCodable(["diff": AnyCodable("+1 added")])
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "edit")],
            results: [self.content(
                type: "toolResult",
                text: "done",
                id: "call-1",
                name: "edit",
                details: details)])

        #expect(items.first?.details == details)
    }

    @Test func `threads paired and orphan result errors`() {
        let paired = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "edit")],
            results: [self.content(
                type: "toolResult",
                text: "failed",
                id: "call-1",
                name: "edit",
                isError: true)])
        let orphan = ChatToolActivity.items(
            calls: [],
            results: [self.content(type: "toolResult", text: "failed", isError: true)])

        #expect(paired.first?.isError == true)
        #expect(orphan.first?.isError == true)
    }

    private func content(
        type: String,
        text: String? = nil,
        id: String? = nil,
        name: String? = nil,
        details: AnyCodable? = nil,
        isError: Bool? = nil) -> OpenClawChatMessageContent
    {
        OpenClawChatMessageContent(
            type: type,
            text: text,
            mimeType: nil,
            fileName: nil,
            content: nil,
            id: id,
            name: name,
            details: details,
            isError: isError)
    }
}
