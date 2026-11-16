import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatAssistantListCellTests {
    @Test func `trimming input changes grouping without replacing surviving cells`() throws {
        let user = OpenClawChatMessage(
            role: "user",
            content: [.init(type: "text", text: "Request")],
            timestamp: 1,
            transcriptRunID: "run")
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Answer")],
            timestamp: 2,
            transcriptRunID: "run",
            phase: "final_answer")
        func cells(_ messages: [OpenClawChatMessage]) -> [ChatAssistantListCell] {
            ChatAssistantListCell.cells(ChatAssistantRunGroup.build(
                ChatTranscriptRow.build(from: messages),
                liveRunID: nil,
                hasLiveContent: false,
                searchActive: false)[...])
        }
        let before = try #require(cells([user, answer]).last)
        let after = try #require(cells([answer]).first)
        #expect(before.group.id != after.group.id)
        #expect(before.id == after.id)
        #expect(after.id == .row(answer.id))
    }

    @Test func `work and answer keep separate cells but join their chrome`() {
        let work = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Working")],
            timestamp: 1,
            transcriptRunID: "run",
            phase: "commentary")
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Answer")],
            timestamp: 2,
            transcriptRunID: "run",
            phase: "final_answer")
        let group = ChatAssistantRunGroup(
            id: .run("run", UUID(), 0),
            runID: "run",
            parts: [.row(.message(work)), .row(.message(answer))])
        let cells = ChatAssistantListCell.cells([group][...])
        #expect(cells.count == 2)
        #expect(cells[0].id != cells[1].id)
        #expect(!cells[0].joinsAbove && cells[0].joinsBelow)
        #expect(cells[1].joinsAbove && !cells[1].joinsBelow)
    }

    @Test func `collapsed rollup removes hidden segment cells and their chrome`() {
        let turn = UUID()
        let owner = ChatTranscriptRow.CompletedWork(
            anchorID: UUID(),
            messages: [],
            durationMilliseconds: nil,
            rollupID: turn,
            rollupMessages: [])
        let hidden = ChatTranscriptRow.CompletedWork(
            anchorID: UUID(), messages: [], durationMilliseconds: nil, rollupID: turn)
        let answer = OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: "Answer")],
            timestamp: 2,
            transcriptRunID: "run",
            phase: "final_answer")
        let group = ChatAssistantRunGroup(
            id: .run("run", UUID(), 0),
            runID: "run",
            parts: [.row(.completedWork(owner)), .row(.completedWork(hidden)), .row(.message(answer))])
        let collapsed = ChatAssistantListCell.cells([group][...])
        #expect(collapsed.map(\.id) == [.row(owner.id), .row(answer.id)])
        #expect(collapsed[0].joinsBelow && collapsed[1].joinsAbove)
        let expanded = ChatAssistantListCell.cells([group][...], expandedWorkTurns: [turn])
        #expect(expanded.map(\.id) == [.row(owner.id), .row(hidden.id), .row(answer.id)])
    }
}
