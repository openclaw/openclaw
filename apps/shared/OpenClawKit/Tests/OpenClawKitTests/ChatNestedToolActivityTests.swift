import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatNestedToolActivityTests {
    private static func raw(_ json: String) throws -> AnyCodable {
        try JSONDecoder().decode(AnyCodable.self, from: Data(json.utf8))
    }

    private static let activity = #"""
    {"role":"custom","customType":"openclaw.nested-tool.v1","timestamp":3,
     "__openclaw":{"id":"nested","runId":"run"},"content":[
      {"type":"toolCall","id":"nested-call","runId":"run","name":"read",
       "arguments":{"path":"README.md"},"parentToolCallId":"outer"},
      {"type":"toolResult","toolCallId":"nested-call","name":"read",
       "content":[{"type":"text","text":"Recorded nested output"}],"isError":true}
    ]}
    """#

    @Test func `nested audit history renders one recorded call and error`() async throws {
        let messages = try await OpenClawChatViewModel.decodeMessages([Self.raw(Self.activity)])
        let message = try #require(messages.first)
        let items = ChatToolActivity.items(message: message)
        #expect(items.count == 1)
        let item = try #require(items.first)
        #expect(item.id == "nested-call")
        #expect(item.name == "read")
        #expect(item.arguments?.dictionaryValue?["path"]?.stringValue == "README.md")
        #expect(item.resultText == "Recorded nested output")
        #expect(item.isError)
        #expect(item.isVisible)
        #expect(message.role == "custom")

        let cached = try JSONEncoder().encode(message)
        let restored = try JSONDecoder().decode(OpenClawChatMessage.self, from: cached)
        let restoredItems = ChatToolActivity.items(message: restored)
        #expect(restoredItems.count == 1)
        let restoredItem = try #require(restoredItems.first)
        #expect(restoredItem.id == "nested-call")
        #expect(restoredItem.resultText == "Recorded nested output")
        #expect(restoredItem.isError)
    }

    @Test func `live nested activity is ingested and deduplicated before rendering`() throws {
        let vm = OpenClawChatViewModel(sessionKey: "main", transport: TestChatTransport(historyResponses: []))
        defer { vm.detachTransport() }
        let message = try GatewayPayloadDecoding.decode(Self.raw(Self.activity), as: OpenClawChatMessage.self)
        for _ in 0..<2 {
            vm.handleTransportEvent(.sessionMessage(.init(
                sessionKey: "main", message: message, messageId: "nested", messageSeq: nil)))
        }
        #expect(vm.messages.count == 1)
        let received = try #require(vm.messages.first)
        let item = try #require(ChatToolActivity.items(message: received).first)
        #expect(item.id == "nested-call")
        #expect(item.resultText == "Recorded nested output")
        #expect(item.isError)
    }

    @Test func `nested activity groups and folds without hiding commentary or the answer`() async throws {
        let input = try Self.raw(#"""
        {"role":"user","timestamp":1,"__openclaw":{"id":"input","runId":"run"},"content":"Read the file"}
        """#)
        let commentary = try Self.raw(#"""
        {"role":"assistant","phase":"commentary","timestamp":2,
         "__openclaw":{"id":"commentary","runId":"run"},"content":"Checking the file now."}
        """#)
        let answer = try Self.raw(#"""
        {"role":"assistant","phase":"final_answer","timestamp":4,"stopReason":"stop",
         "__openclaw":{"id":"answer","runId":"run"},"content":"The file was checked."}
        """#)
        let messages = try await OpenClawChatViewModel.decodeMessages([
            input,
            commentary,
            Self.raw(Self.activity),
            answer,
        ])
        let rows = ChatTranscriptRow.build(from: messages)
        let active = ChatAssistantRunGroup.build(
            rows, liveRunID: "run", hasLiveContent: false, searchActive: false)
        #expect(active.count == 2)
        #expect(active.last?.runID == "run")
        #expect(active.last?.parts.count == 3)

        // Completed nested work joins the same disclosure as ordinary tool calls.
        let successful = try Self.raw(Self.activity.replacingOccurrences(
            of: #""isError":true"#,
            with: #""isError":false"#))
        let completed = await OpenClawChatViewModel.decodeMessages([input, commentary, successful, answer])
        let folded = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: completed), runWorking: false)
        try #require(folded.count == 4)
        guard case let .completedWork(work) = folded[2] else {
            Issue.record("Expected nested work to fold between narration and answer")
            return
        }
        #expect(work.messages.count == 1)
        let foldedMessage = try #require(work.messages.first)
        #expect(ChatToolActivity.items(message: foldedMessage).first?.resultText == "Recorded nested output")
        guard case let .message(narration) = folded[1], case let .message(final) = folded[3] else {
            Issue.record("Visible narration and answer must remain outside the work disclosure")
            return
        }
        #expect(ChatMessageVisibleText.visibleText(in: narration) == "Checking the file now.")
        #expect(ChatMessageVisibleText.visibleText(in: final) == "The file was checked.")

        let failedTail = try Self.raw(Self.activity.replacingOccurrences(
            of: #""timestamp":3"#,
            with: #""timestamp":5"#))
        let withFailure = await OpenClawChatViewModel.decodeMessages([input, commentary, answer, failedTail])
        let unresolved = ChatTranscriptRow.collapseCompletedWork(
            ChatTranscriptRow.build(from: withFailure), runWorking: false)
        guard case let .message(failure) = unresolved.last else {
            Issue.record("A failed nested tail must remain exposed after the answer")
            return
        }
        let failedItem = try #require(ChatToolActivity.items(message: failure).first)
        #expect(failedItem.resultText == "Recorded nested output")
        #expect(failedItem.isError)
    }

    @Test func `unrelated custom records are not reclassified as tool activity`() async throws {
        let unrelated = try Self.raw(Self.activity.replacingOccurrences(
            of: "openclaw.nested-tool.v1", with: "unrelated-extension"))
        let message = try #require(await OpenClawChatViewModel.decodeMessages([unrelated]).first)
        #expect(ChatToolActivity.items(message: message).isEmpty)
    }
}
