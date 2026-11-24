import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatInlineNarrationRegressionTests {
    @Test func `completed narration folds with its work into one disclosure above the answer`() {
        let first = Self.message("Reading the file.", phase: "commentary")
        let second = Self.message("Running the check.", phase: "commentary")
        let answer = Self.message("All checks passed.", phase: "final_answer")
        let read = Self.work("read")
        let exec = Self.work("exec")
        let source = [first, read, second, exec, answer]
        let rows = Self.project(source)
        #expect(rows.compactMap { row -> String? in
            if case let .message(message) = row { return ChatMessageVisibleText.visibleText(in: message) }
            return nil
        } == ["All checks passed."])
        #expect(rows.compactMap { row -> [UUID]? in
            if case let .completedWork(work) = row { return work.messages.map(\.id) }
            return nil
        } == [[first.id, read.id, second.id, exec.id]])
    }

    @Test func `prepending work keeps disclosure identity`() {
        let answer = Self.message("Done.", phase: "final_answer")
        let work = Self.work("read")
        let before = Self.project([work, answer])
        let after = Self.project([Self.work("older"), work, answer])
        #expect(before.compactMap(Self.workID) == after.compactMap(Self.workID))
    }

    private static func project(_ messages: [OpenClawChatMessage]) -> [ChatTranscriptRow] {
        ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: messages)), runWorking: false)
    }

    private static func workID(_ row: ChatTranscriptRow) -> UUID? {
        if case let .completedWork(work) = row { return work.id }
        return nil
    }

    private static func message(_ text: String, phase: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant",
            content: [.init(type: "text", text: text)],
            timestamp: nil,
            phase: phase)
    }

    private static func work(_ id: String) -> OpenClawChatMessage {
        OpenClawChatMessage(role: "assistant", content: [
            .init(type: "toolCall", id: id, name: "read"),
            .init(type: "tool_result", text: "Recorded result", id: id),
        ], timestamp: nil)
    }
}
