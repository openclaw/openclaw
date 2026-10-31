import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatWorkChunksTests {
    private struct Fixture: Decodable {
        let markdownEnvelopes: [MarkdownEnvelope]
        struct MarkdownEnvelope: Decodable {
            let name: String
            let text: [String]
            let textType: String?
            let workBetweenText: Bool
            let expectedParts: Int
        }
    }

    @Test func `shared Markdown envelope context`() throws {
        let url = try #require(Bundle.module.url(
            forResource: "chat-work-chunks", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        for item in fixture.markdownEnvelopes {
            let work = OpenClawChatMessageContent(type: "thinking", thinking: "Recorded work")
            var content: [OpenClawChatMessageContent] = []
            for (index, text) in item.text.enumerated() {
                if item.workBetweenText, index == 1 { content.append(work) }
                content.append(.init(type: item.textType ?? "text", text: text))
            }
            if !item.workBetweenText { content.append(work) }
            let source = OpenClawChatMessage(role: "assistant", content: content, timestamp: nil)
            let parts = source.workPresentationParts
            #expect(parts.count == item.expectedParts, "\(item.name)")
            let textCounts = parts.map { part in
                part.content.filter { ChatMessageVisibleText.isVisibleContentType($0.type, role: source.role) }.count
            }.filter { $0 > 0 }
            #expect(textCounts == (item.expectedParts == 3 ? [1, 1] : [item.text.count]), "\(item.name)")
            #expect(parts.allSatisfy { $0.id == source.id })
        }
    }

    @Test func `paragraph separator stays in its text envelope`() {
        let source = OpenClawChatMessage(role: "assistant", content: [
            .init(type: "text", text: "First paragraph"),
            .init(type: "text", text: "\n"),
            .init(type: "text", text: "Second paragraph"),
            .init(type: "thinking", thinking: "Recorded work"),
        ], timestamp: nil)
        let parts = source.workPresentationParts
        #expect(parts == [source])
        #expect(parts.map { ChatMessageVisibleText.displayText(in: $0, includeThinking: false) } == [
            ChatMessageVisibleText.displayText(in: source, includeThinking: false),
        ])
    }

    @Test(arguments: [false, true])
    func `fenced code keeps one renderer context`(workBetweenText: Bool) {
        let work = OpenClawChatMessageContent(type: "thinking", thinking: "Recorded work")
        var content: [OpenClawChatMessageContent] = [.init(type: "text", text: "```js\nconst a = 1;")]
        if workBetweenText { content.append(work) }
        content.append(.init(type: "text", text: "const b = 2;\n```"))
        if !workBetweenText { content.append(work) }
        let source = OpenClawChatMessage(role: "assistant", content: content, timestamp: nil)
        let blocks = source.workPresentationParts.flatMap { part in
            ChatMarkdownBlockSegmenter.segments(
                markdown: part.content.filter { $0.type == "text" }.compactMap(\.text).joined(separator: "\n"),
                isComplete: true)
        }
        let code = blocks.compactMap { block -> String? in
            if case let .code(value) = block { return value.code }
            return nil
        }
        #expect(code.count == 1)
        #expect(code.first?.contains("const a = 1;\nconst b = 2;") == true)
        #expect(blocks.count == 1)
    }

    @Test func `mixed envelope keeps text and source identity`() throws {
        let source = try JSONDecoder().decode(OpenClawChatMessage.self, from: Data(#"""
        {"role":"assistant","phase":"final_answer","usage":{"input":10,"output":5},"content":[
          {"type":"thinking","thinking":"Private reasoning"},
          {"type":"text","text":"First finding."},
          {"type":"toolCall","id":"read","name":"read"},
          {"type":"tool_result","id":"read","text":"File contents"},
          {"type":"text","text":"Second finding."},
          {"type":"toolCall","id":"check","name":"check"},
          {"type":"tool_result","id":"check","text":"Checked"},
          {"type":"text","text":"Final answer."}
        ]}
        """#.utf8))
        let rows = ChatTranscriptRow.collapseCompletedWork([.message(source)], runWorking: false)
        let visible = rows.compactMap { row -> OpenClawChatMessage? in
            if case let .message(message) = row { return message }
            return nil
        }
        let work = rows.compactMap { row -> ChatTranscriptRow.CompletedWork? in
            if case let .completedWork(work) = row { return work }
            return nil
        }
        #expect(visible.map { ChatMessageVisibleText.visibleText(in: $0) } == [
            "First finding.", "Second finding.", "Final answer.",
        ])
        try #require(work.count == 3)
        #expect(work[0].messages[0].content[0].type == "thinking")
        #expect(work[1].messages[0].content.map(\.type) == ["toolCall", "tool_result"])
        #expect(visible.allSatisfy { $0.id == source.id })
        #expect(Set(rows.map(\.id)).count == rows.count)
        #expect(rows.map(\.id) == ChatTranscriptRow.collapseCompletedWork(
            [.message(source)], runWorking: false).map(\.id))
        #expect(visible.filter(\.presentationOwnsFooter).map(\.presentationID) == [visible[2].presentationID])
        #expect(work.allSatisfy { $0.durationMilliseconds == nil })
        #expect(source.content.count == 8)
        #expect(source.workPresentationParts.compactMap {
            ChatMessageUsagePresentation.make(message: $0, contextWindowTokens: nil)
        }.count == 1)
        let group = ChatAssistantRunGroup.build(
            rows, liveRunID: nil, hasLiveContent: false, searchActive: false)
        #expect(group.last?.answerID == visible.last?.presentationID)
    }

    @Test(arguments: [false, true], [false, true])
    func `split text keeps envelope reasoning private`(workBetweenText: Bool, leadingProse: Bool) throws {
        let opening = (leadingProse ? "Before" : "") + "<think>hidden start"
        let work = OpenClawChatMessageContent(type: "thinking", thinking: "Typed work")
        var content: [OpenClawChatMessageContent] = [.init(type: "text", text: opening)]
        if workBetweenText { content.append(work) }
        let visibleIndex = content.count
        content.append(.init(type: "text", text: "SECRET</think>Visible"))
        content.append(work)
        let source = OpenClawChatMessage(role: "assistant", content: content, timestamp: nil)
        #expect(ChatMessageVisibleText.visibleText(in: source) == (leadingProse ? "Before\n\nVisible" : "Visible"))

        let parts = source.workPresentationParts
        #expect(parts.count == 1)
        let retained = try #require(parts.first)
        let visible = ChatMessageVisibleText.visibleText(in: retained)
        #expect(visible == (leadingProse ? "Before\n\nVisible" : "Visible"))
        #expect(!visible.contains("SECRET"))
        #expect(!visible.contains("hidden start"))
        // The same original envelope can still show inline reasoning when enabled.
        let expanded = AssistantTextParser.segments(from:
            ChatMessageVisibleText.displayText(in: retained, includeThinking: true))
        #expect(expanded.contains { $0.kind == .thinking && $0.text.contains("hidden start") })
        #expect(expanded.contains { $0.text.contains("SECRET") })
        #expect(retained.id == source.id)
        #expect(retained.presentationBlockIndex == nil)
        #expect(retained.content[visibleIndex].text == "SECRET</think>Visible")
    }

    @Test func `empty text does not split work and projection does not serialize`() throws {
        let source = OpenClawChatMessage(role: "assistant", content: [
            .init(type: "text", text: "Narrative"),
            .init(type: "toolCall", id: "call", name: "read"),
            .init(type: "text", text: "   "),
            .init(type: "tool_result", text: "Done", id: "call"),
        ], timestamp: nil)
        let parts = source.workPresentationParts
        #expect(parts.count == 2)
        #expect(parts[1].content.map(\.type) == ["toolCall", "tool_result"])
        let roundTrip = try JSONDecoder().decode(OpenClawChatMessage.self, from: JSONEncoder().encode(parts[0]))
        #expect(roundTrip.presentationBlockIndex == nil)
        #expect(roundTrip.presentationOwnsFooter)
    }

    @Test(arguments: [false, true])
    func `separated recorded result keeps call outcome without duplicating result`(failed: Bool) {
        let source = OpenClawChatMessage(role: "assistant", content: [
            .init(type: "toolCall", id: "call", name: "read"),
            .init(type: "text", text: "A finding between call and result"),
            .init(type: "tool_result", text: "Recorded outcome", id: "call", isError: failed),
            .init(type: "text", text: "Answer"),
        ], timestamp: nil)
        let parts = source.workPresentationParts
        let items = parts.flatMap { message in
            ChatToolActivity.items(
                calls: message.content.filter(\.isToolCall),
                results: message.content.filter(\.isToolResult),
                recordedResults: message.presentationRecordedToolResults)
        }
        #expect(items.count == 2)
        #expect(items[0].state == (failed ? .failed : .finished))
        #expect(items[0].resultText == nil)
        #expect(items[1].resultText == "Recorded outcome")
    }

    @Test func `unfinished source cannot steal answer actions after splitting`() {
        let user = OpenClawChatMessage(role: "user", content: [], timestamp: 0, transcriptRunID: "run")
        let answer = OpenClawChatMessage(role: "assistant", content: [
            .init(type: "text", text: "Completed answer"),
        ], timestamp: 1, transcriptRunID: "run", phase: "final_answer")
        let unfinished = OpenClawChatMessage(role: "assistant", content: [
            .init(type: "text", text: "An unfinished update"),
            .init(type: "toolCall", id: "call", name: "read"),
        ], timestamp: 2, transcriptRunID: "run")
        let rows = ChatTranscriptRow.collapseCompletedWork(
            [user, answer, unfinished].map(ChatTranscriptRow.message), runWorking: false)
        let groups = ChatAssistantRunGroup.build(rows, liveRunID: nil, hasLiveContent: false, searchActive: false)
        #expect(groups.last?.answerID == answer.id)
        #expect(unfinished.workPresentationParts.allSatisfy { !$0.isCompletedReply })
    }

    @Test func `tool only error keeps its tail`() {
        let source = OpenClawChatMessage(role: "assistant", content: [
            .init(type: "thinking", thinking: "Hidden"),
            .init(type: "toolCall", id: "call", name: "read"),
        ], timestamp: nil, stopReason: "error", errorMessage: "Read failed")
        #expect(source.workPresentationParts == [source])
        #expect(ChatMessageVisibleText.visibleText(in: source).contains("Read failed"))
    }
}
