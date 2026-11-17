import Foundation
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

    @Test func `fallback title for an unseen outcome gives way to the call's own title`() {
        func item(_ title: String, phase: String, status: String?) -> OpenClawAgentActivityItem {
            OpenClawAgentActivityItem(
                itemId: "tool:call", toolCallId: "call", kind: "tool", phase: phase,
                title: title, name: "exec", status: status,
                hideFromChannelProgress: nil, suppressChannelProgress: nil)
        }
        #expect(item("Mcp Openclaw Exec — outcome unknown", phase: "end", status: nil).preparedTitle == nil)
        #expect(item("Exec List pull requests", phase: "start", status: "running").preparedTitle
            == "Exec List pull requests")
        #expect(item("Exec List pull requests", phase: "end", status: "completed").preparedTitle
            == "Exec List pull requests")
    }

    @Test func `prepared skipped outcome stays neutral despite raw result error`() throws {
        let items = ChatToolActivity.items(
            calls: [self.content(type: "toolCall", id: "call-1", name: "read")],
            results: [self.content(
                type: "toolResult",
                text: "Skipped to process an incoming message.",
                id: "call-1",
                name: "read",
                isError: true)],
            activity: [OpenClawAgentActivityItem(
                itemId: "tool:call-1", toolCallId: "call-1", kind: "tool", phase: "end",
                title: "Read", name: "read", status: "skipped",
                hideFromChannelProgress: nil, suppressChannelProgress: nil)])

        let item = try #require(items.first)
        #expect(String(localized: item.displayState.title) == "Skipped")
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

    /// `chat.history` delivers a catalog call twice: as a `dispatch_action` wrapper on the assistant
    /// message (no activity item once its child is shown) and as an `openclaw.nested-tool.v1` custom
    /// message carrying the inner call, its result and its own activity item. Web shows the inner
    /// call; iOS must too, instead of an empty row.
    @Test func `nested catalog call renders as its own visible row`() throws {
        let json = """
        [
          {"role":"assistant","__openclaw":{"id":"m1","runId":"run-1"},"content":[
            {"type":"toolCall","id":"call-exec","name":"exec","arguments":{"command":"ls"}},
            {"type":"toolCall","id":"call-wrap","name":"dispatch_action",
             "arguments":{"id":"sessions_create","args":{"label":"Fixture child"}}}],
           "activity":[{"itemId":"tool:call-exec","toolCallId":"call-exec","kind":"tool","phase":"end",
             "title":"Exec","name":"exec","status":"completed"}]},
          {"role":"custom","customType":"openclaw.nested-tool.v1","display":true,
           "__openclaw":{"id":"m2","runId":"run-1"},"content":[
            {"type":"toolCall","id":"nested:1","name":"sessions_create","parentToolCallId":"call-wrap",
             "arguments":{"label":"Fixture child"}},
            {"type":"toolResult","toolCallId":"nested:1","parentToolCallId":"call-wrap",
             "toolName":"sessions_create","isError":false,"content":[{"type":"text","text":"created"}]}],
           "activity":[{"itemId":"tool:nested:1","toolCallId":"nested:1","kind":"tool","phase":"end",
             "title":"New session","name":"sessions_create","status":"completed"}]},
          {"role":"toolResult","__openclaw":{"id":"m3","runId":"run-1"},"toolCallId":"call-exec",
           "toolName":"exec","isError":false,"content":[{"type":"text","text":"ok"}],
           "activity":[{"itemId":"tool:call-exec","toolCallId":"call-exec","kind":"tool","phase":"end",
             "title":"Exec","name":"exec","status":"completed"}]},
          {"role":"toolResult","__openclaw":{"id":"m4","runId":"run-1"},"toolCallId":"call-wrap",
           "toolName":"dispatch_action","isError":false,"content":[{"type":"text","text":"{}"}],
           "activity":[]}
        ]
        """
        let decoded = try JSONDecoder().decode([OpenClawChatMessage].self, from: Data(json.utf8))
        let messages = ChatTranscriptRow.mergeToolResults(in: decoded.flatMap(\.ingestedMessages))
        let rows = messages.map { (message: $0, items: ChatToolActivity.items(message: $0)) }

        let visible = rows.flatMap(\.items).filter(\.isVisible)
        #expect(visible.map(\.name) == ["exec", "sessions_create"])
        let nested = try #require(visible.last)
        #expect(nested.displayState == .finished)
        #expect(nested.activity?.preparedTitle == "New session")
        #expect(nested.resultText == "created")
        // No message is left that would render as an empty cell.
        #expect(rows.allSatisfy { $0.message.role.lowercased() != "custom" || !$0.items.isEmpty })
        // Both rows stay in the wrapper's run, so one frame and one "Worked" fold hold them.
        #expect(Set(messages.map(\.workRunID)) == ["run-1"])
    }

    @Test @MainActor
    func `launches share a line only while they succeed and a failed launch keeps its own row`() throws {
        let json = #"""
        [
          {"role":"assistant","timestamp":1,"content":[
            {"type":"toolCall","id":"s1","name":"sessions_spawn","arguments":{"label":"Auditor audit","task":"Audit"}},
            {"type":"toolCall","id":"s2","name":"sessions_spawn","arguments":{"task":"Review"}},
            {"type":"toolCall","id":"s3","name":"sessions_spawn","arguments":{"label":"Docs","task":"Write"}}]},
          {"role":"toolResult","toolCallId":"s1","toolName":"sessions_spawn","timestamp":2,
           "content":"{\"status\":\"accepted\",\"childSessionKey\":\"agent:main:subagent:audit\"}"},
          {"role":"toolResult","toolCallId":"s2","toolName":"sessions_spawn","timestamp":3,
           "content":"{\"status\":\"accepted\",\"childSessionKey\":\"agent:main:subagent:review\",\"label\":\"Reviewer\"}"},
          {"role":"toolResult","toolCallId":"s3","toolName":"sessions_spawn","timestamp":4,
           "content":"{\"status\":\"error\",\"error\":\"quota exceeded\"}"}
        ]
        """#
        let decoded = try JSONDecoder().decode([OpenClawChatMessage].self, from: Data(json.utf8))
        let merged = ChatTranscriptRow.mergeToolResults(in: decoded)
        #expect(merged.count == 1)
        let items = try ChatToolActivity.items(message: #require(merged.first))
        try #require(items.count == 3)

        // The two accepted launches share one line; each name opens its own child.
        let runs = ChatToolActivityList.visibleRuns(items)
        #expect(runs == [[0, 1], [2]])
        let launched = runs[0].compactMap { items[$0].sessionLaunch }
        #expect(launched.map(\.childKey) == ["agent:main:subagent:audit", "agent:main:subagent:review"])
        let line = ChatSessionLaunch.title(launched, linksChildren: true)
        #expect(String(line.characters) == "Launched Auditor audit and Reviewer")
        #expect(line.runs.compactMap { $0.link?.absoluteString } ==
            ["\(ChatSessionLaunch.linkScheme):0", "\(ChatSessionLaunch.linkScheme):1"])
        // The refused launch is its own row with its outcome.
        #expect(items[2].sessionLaunch?.phase == .failed)
        #expect(items[2].rowTitle == "Couldn't launch subagent Docs")
        #expect(items[2].isError)

        // Failure first: neither row takes the other's verb.
        let reversed = [items[2], items[0]]
        #expect(ChatToolActivityList.visibleRuns(reversed) == [[0], [1]])
        #expect(reversed.map(\.rowTitle) == ["Couldn't launch subagent Docs", "Launched Auditor audit"])

        let unnamed = ChatSessionLaunch(
            kind: .subagent,
            phase: .succeeded,
            label: nil,
            childKey: "agent:main:subagent:x")
        #expect(String(ChatSessionLaunch.title([unnamed, unnamed], linksChildren: true).characters)
            == "Launched 2 agents")
        let chat = ChatSessionLaunch(kind: .chat, phase: .succeeded, label: nil, childKey: "agent:main:dashboard:x")
        #expect(String(ChatSessionLaunch.title([chat], linksChildren: true).characters) == "Opened child chat")
    }

    @Test func `failed command reads as ran with its exit code`() throws {
        let json = #"""
        [
          {"role":"assistant","timestamp":1,"content":[
            {"type":"toolCall","id":"e1","name":"exec","arguments":{"command":"swift   test\n  --filter Chat"}}]},
          {"role":"toolResult","toolCallId":"e1","toolName":"exec","timestamp":2,"isError":true,
           "details":{"exitCode":2,"status":"failed"},"content":"error: build failed"}
        ]
        """#
        let decoded = try JSONDecoder().decode([OpenClawChatMessage].self, from: Data(json.utf8))
        let merged = try #require(ChatTranscriptRow.mergeToolResults(in: decoded).first)
        let item = try #require(ChatToolActivity.items(message: merged).first)

        #expect(item.displayState == .failed)
        #expect(item.commandVerb == "Ran")
        #expect(item.commandPreview == "swift test --filter Chat")
        #expect(String(localized: item.statusTitle) == "Exit code 2")
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
