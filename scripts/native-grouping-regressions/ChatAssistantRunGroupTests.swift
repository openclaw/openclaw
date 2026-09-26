import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("Assistant run presentation")
struct ChatAssistantRunGroupTests {
    @Test
    func `one frame survives narration tools and completed work`() throws {
        let user = Self.message("user", at: 1)
        let narration = Self.message("assistant", at: 2, phase: "commentary")
        let tool = Self.tool("read", at: 3)
        let next = Self.message("assistant", at: 4, phase: "commentary")
        let rows = ChatTranscriptRow.build(from: [user, narration, next])
        let live = ChatAssistantRunGroup.build(
            rows, tools: [tool], liveRunID: "run", hasLiveContent: true, searchActive: false)
        #expect(live.count == 2)
        let frame = try #require(live.last)
        #expect(frame.parts.map(\.id) == ["row:\(narration.id)", "tool:read", "row:\(next.id)"])
        #expect(frame.includesLive)
        #expect(frame.answerID == nil)

        let answer = Self.message("assistant", at: 5, phase: "final_answer")
        let completed = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: [user, narration, next, answer]), runWorking: false)
        let final = ChatAssistantRunGroup.build(
            completed, liveRunID: nil, hasLiveContent: false, searchActive: false)
        #expect(final.count == 2)
        #expect(final.last?.id == frame.id)
        #expect(final.last?.answerID == answer.id)
        #expect(final.last?.includesLive == false)
    }

    @Test(arguments: ["user", "assistant"])
    func `input boundaries split repeated run IDs`(role: String) {
        let user = Self.message("user", at: 1)
        let first = Self.message("assistant", at: 2, phase: "commentary")
        let boundary = Self.message(role, at: 3, boundary: true, phase: "commentary")
        let next = Self.message("assistant", at: 4, phase: "commentary")
        let groups = ChatAssistantRunGroup.build(
            ChatTranscriptRow.build(from: [user, first, boundary, next]),
            liveRunID: "run", hasLiveContent: true, searchActive: false)
        let frames = groups.filter { $0.runID != nil }
        #expect(frames.count == 2)
        #expect(frames[0].id != frames[1].id)
        #expect(frames[1].parts.count == 1)
        #expect(groups.contains { $0.runID == nil && $0.parts.first?.boundaryID == boundary.id })
        #expect(frames[1].includesLive)
    }

    @Test
    func `unknown and different runs cannot merge across intervening output`() {
        let user = Self.message("user", at: 1)
        let first = Self.message("assistant", at: 2)
        let unknown = Self.message("assistant", at: 3, run: nil)
        let other = Self.message("assistant", at: 4, run: "other")
        let last = Self.message("assistant", at: 5)
        let rows = ChatTranscriptRow.build(from: [user, first, unknown, other, last])
        let groups = ChatAssistantRunGroup.build(
            rows, liveRunID: nil, hasLiveContent: true, searchActive: false)
        #expect(groups.count == 6)
        #expect(groups[1].id != groups[4].id)
        #expect(groups.last?.runID == nil)
        #expect(groups.last?.parts.isEmpty == true)

        let search = ChatAssistantRunGroup.build(
            rows, liveRunID: "run", hasLiveContent: true, searchActive: true)
        #expect(search.allSatisfy { $0.runID == nil })
        #expect(search.flatMap(\.parts).count == rows.count)
    }

    @Test
    func `tool completion does not reorder work and history removes its live duplicate`() {
        let user = Self.message("user", at: 1)
        let narration = Self.message("assistant", at: 2, phase: "commentary")
        var first = Self.tool("first", at: 3)
        first.isComplete = true
        let next = Self.tool("next", at: 4)
        let rows = ChatTranscriptRow.build(from: [user, narration])
        let live = ChatAssistantRunGroup.build(
            rows, tools: [next, first], liveRunID: "run", hasLiveContent: true, searchActive: false)
        #expect(live.last?.parts.map(\.id) == ["row:\(narration.id)", "tool:first", "tool:next"])

        let call = OpenClawChatMessage(
            role: "assistant",
            content: [.init(
                type: "toolCall", text: nil, mimeType: nil, fileName: nil,
                content: nil, id: "first", name: "read")],
            timestamp: 3, transcriptRunID: "run")
        let persisted = ChatAssistantRunGroup.build(
            rows + [.message(call)], tools: [next, first],
            liveRunID: "run", hasLiveContent: true, searchActive: false)
        #expect(persisted.last?.id == live.last?.id)
        #expect(persisted.last?.parts.map(\.id) == ["row:\(narration.id)", "row:\(call.id)", "tool:next"])
    }

    @Test
    func `recorded call keeps live status until its result takes over`() {
        let call = OpenClawChatMessageContent(
            type: "toolCall", text: nil, mimeType: nil, fileName: nil,
            content: nil, id: "read", name: "read", arguments: .init(["path": "Layout.swift"]))
        let live = Self.tool("read", at: 2)
        let running = ChatToolActivity.items(calls: [call], results: [], liveTools: [live])
        #expect(running.count == 1)
        #expect(running.first?.isPending == true)
        #expect(running.first?.arguments?.dictionaryValue?["path"]?.stringValue == "Layout.swift")
        let result = OpenClawChatMessageContent(
            type: "tool_result", text: "Read failed", mimeType: nil, fileName: nil,
            content: nil, id: "read", name: "read", isError: true)
        let finished = ChatToolActivity.items(calls: [call], results: [result], liveTools: [live])
        #expect(finished.count == 1)
        #expect(finished.first?.isPending == false)
        #expect(finished.first?.isError == true)
        #expect(finished.first?.resultText == "Read failed")
    }

    @Test(arguments: ["same", "other", "boundary"])
    func `recorded tool results merge across narration only within their turn and run`(scope: String) throws {
        let user = Self.message("user", at: 1)
        let call = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "toolCall", text: nil, mimeType: nil, fileName: nil,
                           content: nil, id: "read", name: "read")],
            timestamp: 2, transcriptRunID: "run")
        let narration = Self.message("assistant", at: 3, phase: "commentary")
        let result = OpenClawChatMessage(
            role: "toolResult",
            content: [.init(type: "text", text: "Read complete", mimeType: nil, fileName: nil, content: nil)],
            timestamp: 4, transcriptRunID: scope == "other" ? "other" : "run",
            toolCallId: "read", toolName: "read", turnBoundary: scope == "boundary")
        let rows = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: [user, call, narration, result]))
        #expect(rows.count == (scope == "same" ? 3 : 4))
        guard case let .message(recordedCall) = rows[1] else {
            Issue.record("Recorded tool call must remain at its original position")
            return
        }
        #expect(recordedCall.content.filter(\.isToolResult).count == (scope == "same" ? 1 : 0))
        #expect(rows[2].id == narration.id)
    }

    private static func message(
        _ role: String,
        at timestamp: Double,
        run: String? = "run",
        boundary: Bool? = nil,
        phase: String? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: role,
            content: [.init(type: "text", text: "Visible content", mimeType: nil, fileName: nil, content: nil)],
            timestamp: timestamp, transcriptRunID: run, phase: phase, turnBoundary: boundary)
    }

    private static func tool(_ id: String, at timestamp: Double) -> OpenClawChatPendingToolCall {
        OpenClawChatPendingToolCall(
            toolCallId: id, name: "read", args: nil, startedAt: timestamp,
            isError: nil, diffStat: nil, runID: "run")
    }
}
