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
                "toolu_a", tool: "sessions_spawn", args: #"{"label":"Reply images"}"#,
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
            "toolu_b", tool: "sessions_send", args: #"{"sessionKey":"agent:main:subagent:x"}"#,
            error: "Followup completion requires in-process caller custody.")]
        // The same assistant message also ran a plain command.
        rows[0] = rows[0].replacingOccurrences(
            of: #"{"type":"toolCall","id":"toolu_b""#,
            with: #"{"type":"toolCall","id":"plain","name":"exec","arguments":{"command":"ls"}},{"type":"toolCall","id":"toolu_b""#)
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
                "toolu_c", tool: "sessions_send", args: #"{"sessionKey":"agent:main:subagent:x"}"#,
                error: "Nope."),
        ]))
        var live = OpenClawChatPendingToolCall(
            toolCallId: "toolu_c", name: "dispatch_action", args: nil, startedAt: 5, isError: nil, diffStat: nil)
        live.runID = "run-1"
        live.isComplete = true
        let groups = ChatAssistantRunGroup.build(
            ChatTranscriptRow.build(from: messages), tools: [live], liveRunID: nil, hasLiveContent: false,
            searchActive: false)
        let liveParts = groups.flatMap(\.parts).filter { if case .tool = $0 { true } else { false } }
        #expect(liveParts.isEmpty)
    }
}
