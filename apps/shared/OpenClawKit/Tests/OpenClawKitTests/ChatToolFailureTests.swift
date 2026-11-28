import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite("Chat tool failures")
struct ChatToolFailureTests {
    /// The shape `chat.history` returned for the turn in Victor's photo (2026-11-24): every call went
    /// through `dispatch_action`, so each failure is an envelope call, its nested row and the envelope's result.
    static func dispatchedFailure(
        _ id: String,
        tool: String,
        args: String,
        error: String,
        run: String = "run-1") -> String
    {
        """
        {"role":"assistant","stopReason":"toolUse","__openclaw":{"id":"\(id)-call","runId":"\(run)"},"content":[
          {"type":"toolCall","id":"\(id)","name":"dispatch_action","arguments":{"id":"\(tool)","args":\(args)}}]},
        {"role":"custom","customType":"openclaw.nested-tool.v1","display":true,
         "__openclaw":{"id":"\(id)-nested","runId":"\(run)"},"content":[
          {"type":"toolCall","id":"tool_call:\(id):\(tool):1","name":"\(tool)","arguments":\(args),
           "parentToolCallId":"\(id)"},
          {"type":"toolResult","toolCallId":"tool_call:\(id):\(tool):1","toolName":"\(tool)",
           "parentToolCallId":"\(id)","isError":true,"content":[{"type":"text","text":"\(error)"}]}]},
        {"role":"toolResult","__openclaw":{"id":"\(id)-result","runId":"\(run)"},"toolCallId":"\(id)",
         "toolName":"dispatch_action","isError":true,
         "content":[{"type":"text","text":"{\\"status\\":\\"error\\",\\"tool\\":\\"dispatch_action\\"}"}]}
        """
    }

    static func decode(_ rows: [String]) throws -> [OpenClawChatMessage] {
        let decoded = try JSONDecoder().decode(
            [OpenClawChatMessage].self, from: Data("[\(rows.joined(separator: ","))]".utf8))
        return decoded.flatMap(\.ingestedMessages)
    }

    static func presented(_ messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        ChatTranscriptRow.retiringDispatchEnvelopes(in: ChatTranscriptRow.mergeToolResults(in: messages))
    }

    @Test func `a dispatched failure is one row, drawn from its nested call`() throws {
        let messages = try Self.decode([
            #"{"role":"user","content":[{"type":"text","text":"Hand off the fixes."}],"__openclaw":{"id":"u"}}"#,
            Self.dispatchedFailure(
                "toolu_a",
                tool: "sessions_spawn",
                args: #"{"label":"Reply images"}"#,
                error: "Requester provenance requires trusted in-process Gateway dispatch."),
        ])
        let items = Self.presented(messages).flatMap { ChatToolActivity.items(message: $0) }.filter(\.isVisible)
        #if os(iOS)
        #expect(items.map(\.id) == ["tool_call:toolu_a:sessions_spawn:1"])
        #expect(items.first?.isError == true)
        #expect(items.first?.sessionLaunch?.label == "Reply images")
        #else
        // macOS leaves the nested carrier uninterpreted and keeps the envelope it always showed.
        #expect(items.map(\.id) == ["toolu_a"])
        #endif
    }

    @Test func `an envelope message keeps its other calls and a non-dispatcher parent keeps its row`() throws {
        var rows = [Self.dispatchedFailure(
            "toolu_b",
            tool: "sessions_send",
            args: #"{"sessionKey":"agent:main:subagent:x"}"#,
            error: "Followup completion requires in-process caller custody.")]
        // The same assistant message also ran a plain command.
        rows[0] = rows[0].replacingOccurrences(
            of: #"{"type":"toolCall","id":"toolu_b""#,
            with: #"{"type":"toolCall","id":"plain","name":"exec","arguments":{"command":"ls"}},"#
                + #"{"type":"toolCall","id":"toolu_b""#)
        // A code-mode exec that recorded a child keeps its own row: its outcome is its own.
        rows.append("""
        {"role":"assistant","__openclaw":{"id":"exec-call","runId":"run-1"},"content":[
          {"type":"toolCall","id":"exec-parent","name":"exec","arguments":{"code":"await read()"}}]},
        {"role":"custom","customType":"openclaw.nested-tool.v1","display":true,
         "__openclaw":{"id":"exec-nested","runId":"run-1"},"content":[
          {"type":"toolCall","id":"tool_call:exec-parent:read:2","name":"read","arguments":{"path":"a"},
           "parentToolCallId":"exec-parent"}]}
        """)
        let ids = try Self.presented(Self.decode(rows)).flatMap { ChatToolActivity.items(message: $0) }.map(\.id)
        #if os(iOS)
        #expect(ids == ["plain", "tool_call:toolu_b:sessions_send:1", "exec-parent", "tool_call:exec-parent:read:2"])
        #else
        #expect(!ids.contains("tool_call:toolu_b:sessions_send:1"))
        #endif
    }

    @Test func `a live envelope stays retired once its nested call is recorded`() throws {
        let messages = try Self.presented(Self.decode([
            #"{"role":"user","content":[{"type":"text","text":"Go."}],"__openclaw":{"id":"u"}}"#,
            Self.dispatchedFailure(
                "toolu_c",
                tool: "sessions_send",
                args: #"{"sessionKey":"agent:main:subagent:x"}"#,
                error: "Nope."),
        ]))
        var live = OpenClawChatPendingToolCall(
            toolCallId: "toolu_c", name: "dispatch_action", args: nil, startedAt: 5, isError: nil, diffStat: nil)
        live.runID = "run-1"
        live.isComplete = true
        let groups = ChatAssistantRunGroup.build(
            ChatTranscriptRow.build(from: messages),
            tools: [live],
            liveRunID: nil,
            hasLiveContent: false,
            searchActive: false)
        let liveParts = groups.flatMap(\.parts).filter {
            if case .tool = $0 {
                true
            } else {
                false
            }
        }
        #expect(liveParts.isEmpty)
    }

    // MARK: Grouping

    static func failed(_ id: String, _ tool: String, _ args: [String: AnyCodable], reason: String = "No")
        -> ChatToolActivityItem
    {
        self.item(id, tool, AnyCodable(args), result: reason, state: .failed)
    }

    static func item(
        _ id: String,
        _ tool: String,
        _ args: AnyCodable?,
        result: String,
        state: ChatToolActivityItem.State) -> ChatToolActivityItem
    {
        ChatToolActivityItem(
            id: id,
            name: tool,
            arguments: args,
            details: nil,
            resultText: result,
            state: state,
            liveDiffStat: nil)
    }

    static func send(_ id: String, to key: String) -> ChatToolActivityItem {
        self.failed(id, "sessions_send", ["sessionKey": AnyCodable(key), "message": AnyCodable("Go")])
    }

    @Test func `repeats of one tool on one chat join the first row; other chats and tools stay apart`() {
        let ok = Self.item(
            "status",
            "session_status",
            AnyCodable([String: AnyCodable]()),
            result: "ok",
            state: .finished)
        let span = [
            Self.send("a1", to: "agent:main:subagent:a"),
            Self.send("b1", to: "agent:main:subagent:b"),
            Self.failed("s1", "sessions_spawn", ["label": AnyCodable("Reply images")]),
            Self.failed("s2", "sessions_spawn", ["label": AnyCodable("Image viewer")]),
            ok,
            Self.send("a2", to: "agent:main:subagent:a"),
            Self.send("b2", to: "agent:main:subagent:b"),
            Self.send("b3", to: "agent:main:subagent:b"),
        ]
        let repeats = ChatToolRepeats.project(spans: [span])
        #expect(repeats.attempts["a1"]?.map(\.id) == ["a1", "a2"])
        #expect(repeats.attempts["b1"]?.map(\.id) == ["b1", "b2", "b3"])
        // Two launches of different subagents are different targets; a success never groups.
        #expect(repeats.attempts.keys.sorted() == ["a1", "b1"])
        #expect(repeats.absorbed == ["a2", "b2", "b3"])
    }

    @Test func `a new span starts over, and a success between failures does not group them`() {
        let first = Self.send("a1", to: "agent:main:subagent:a")
        let later = Self.send("a2", to: "agent:main:subagent:a")
        #expect(ChatToolRepeats.project(spans: [[first], [later]]).absorbed.isEmpty)
        let sent = Self.item("a-ok", "sessions_send", first.arguments, result: "ok", state: .finished)
        let repeats = ChatToolRepeats.project(spans: [[first, sent, later]])
        #expect(repeats.attempts["a1"]?.map(\.id) == ["a1", "a2"])
        #expect(!repeats.absorbed.contains("a-ok"))
        // Positional IDs recur across rows; they are never grouped.
        #expect(ChatToolRepeats.project(spans: [[Self.send("call-0", to: "k"), Self.send("call-1", to: "k")]])
            .absorbed.isEmpty)
    }

    @Test func `the agent's text between calls ends a span in the transcript`() throws {
        func failedSend(_ id: String) -> String {
            """
            {"role":"assistant","stopReason":"toolUse","__openclaw":{"id":"\(id)-m","runId":"r"},"content":[
              {"type":"toolCall","id":"\(id)","name":"sessions_send",
               "arguments":{"sessionKey":"agent:main:subagent:a"}},
              {"type":"toolResult","id":"\(id)","toolName":"sessions_send","isError":true,
               "content":[{"type":"text","text":"Nope."}]}]}
            """
        }
        let narration = #"{"role":"assistant","__openclaw":{"id":"n","runId":"r"},"#
            + #""content":[{"type":"text","text":"Trying the other chat."}]}"#
        let joined = try ChatToolRepeats.project(Self.presented(Self.decode([failedSend("x1"), failedSend("x2")])))
        #expect(joined.attempts["x1"]?.count == 2)
        let apart = try ChatToolRepeats.project(
            Self.presented(Self.decode([failedSend("x1"), narration, failedSend("x2")])))
        #expect(apart.absorbed.isEmpty)
    }

    // MARK: Naming

    @Test func `a chat is named by the session list, never by its key`() {
        var named = OpenClawChatSessionEntry(key: "agent:main:subagent:fbb338be-1179-4c73-8ba2-f6d51f128067")
        named.label = "Toasts board"
        let unnamed = OpenClawChatSessionEntry(key: "agent:main:subagent:4f1e2c90-0000-4000-8000-3d67980d6702")
        let names = ChatSessionNames(sessions: [named, unnamed])
        #expect(names.name(for: "agent:main:subagent:fbb338be-1179-4c73-8ba2-f6d51f128067") == "Toasts board")
        #expect(names.name(for: unnamed.key) == nil)

        let item = Self.send("a1", to: named.key)
        #expect(item.addressedSessionKey == named.key)
        #if os(iOS)
        #expect(item.rowTitle(chatName: "Toasts board") == "Send message to Toasts board")
        #expect(item.rowTitle(chatName: nil) == "Send message")
        #endif
    }

    @Test func `a failure opens to the receipt's own error, not its JSON`() {
        let receipt = #"{"status":"error","#
            + #""error":"Requester provenance requires trusted in-process Gateway dispatch.","#
            + #""childSessionKey":"agent:main:subagent:x"}"#
        let launch = Self.failed("s1", "sessions_spawn", ["label": AnyCodable("Reply images")], reason: receipt)
        #expect(launch.failureReason == "Requester provenance requires trusted in-process Gateway dispatch.")
        #expect(Self.send("a1", to: "k").failureReason == "No")
    }

    @Test func `a failed launch says it failed once; repeats keep their count`() {
        let launch = Self.failed("s1", "sessions_spawn", ["label": AnyCodable("Reply images")])
        #expect(launch.sessionLaunch?.phase == .failed)
        #if os(iOS)
        #expect(launch.trailingStatus(attempts: 1) == nil, "The verb already says it failed")
        #else
        #expect(launch.trailingStatus(attempts: 1) == "Failed")
        #endif
        #expect(launch.trailingStatus(attempts: 2) == "2 failed")
        #expect(Self.send("a1", to: "k").trailingStatus(attempts: 1) == "Failed")
    }
}
