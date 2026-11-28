import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
struct CommandStretchTests {
    @Test(arguments: CommandStretchFixture.allCases, [false, true])
    func `consecutive commands`(shape: CommandStretchFixture, finished: Bool) async throws {
        let run = LocalFixtureChatStore.toolRunID
        let model = OpenClawChatViewModel(
            sessionKey: "main",
            transport: LocalFixtureChatTransport(fixture: .appScreenshots))
        defer { model.detachTransport() }
        let wire = try shape.history(finished: finished)
        let history = await OpenClawChatViewModel.decodeMessages(wire)
        model.replaceMessages(history)
        if !finished {
            model.adoptRun(runId: run, bufferedText: "")
            try model.handleTransportEvent(.agent(shape.liveEvent()))
        }
        let transcript = ChatTranscriptPresentation.project(
            model.transcriptMessages,
            model: model,
            includesTools: true,
            searchActive: false,
            collapsesWork: true,
            streamingTextRunID: nil,
            isMessageVisible: { _, _ in true })
        let groups = transcript.rows.compactMap { row -> ChatTranscriptRow.CompletedWork? in
            if case let .completedWork(work) = row { return work }
            return nil
        }
        let items: [ChatToolActivityItem]
        if finished {
            let group = try #require(groups.first)
            #expect(groups.count == 1)
            #expect(transcript.rows.count == 3)
            #expect(transcript.rows.last?.workMessage?.rawText == "The sample config is missing.")
            items = transcript.toolItems(in: group.messages, live: [])
        } else {
            // The working indicator is the only operation row. Its one-tap inspector owns the whole stretch.
            #expect(transcript.rows.count == 1)
            #expect(transcript.rows.first?.startsTurn == true)
            items = transcript.toolItems(for: run, live: model.toolActivities)
            #expect(items.last?.isPending == true)
        }
        let ids: [String]
        let failed: String
        switch shape {
        case .claude:
            ids = (0..<8).map { "toolu_sample_\($0)" }
            failed = ids[5]
        case .openAI:
            ids = [
                "call_sample_0|fc_0",
                "tool_call:sample-0:skills_read:1",
                "tool_call:sample-0:exec:2",
                "call_sample_1|fc_1",
                "tool_call:sample-1:exec:1",
                "call_sample_2|fc_2",
                "tool_call:sample-2:exec:1",
                "tool_call:sample-2:exec:2",
            ]
            failed = ids[6]
        case .resumed:
            ids = (0..<4).flatMap { ["call_sample_\($0)|fc_\($0)", "tool_call:sample-\($0):exec:1"] }
            failed = ids[5]
        }
        #expect(items.map(\.id) == ids)
        #expect(items.filter(\.isError).map(\.id) == [failed])
    }
}
