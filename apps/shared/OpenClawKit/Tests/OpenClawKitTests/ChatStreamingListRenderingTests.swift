import SwiftUI
import Testing
@testable import OpenClawChatUI

struct ChatStreamingListRenderingTests {
    @Test @MainActor func `reader anchors distinguish repeated block prefixes through finalization`() throws {
        let first = "Deployment checks passed for the staging environment. Region: us-east-1."
        let second = "Deployment checks passed for the staging environment. Region: eu-west-1."
        let text = "# " + first + "\n\n# " + second
        let live = ChatMarkdownRenderSnapshot(text: text, isComplete: false)
        let final = ChatMarkdownRenderSnapshot(text: text, isComplete: true)
        try #require(live.blocks.count == 2)
        try #require(final.blocks.count == 2)
        let firstKey = try #require(ChatMarkdownRenderer.readerBlockKey(live.blocks[0], index: 0))
        let secondKey = try #require(ChatMarkdownRenderer.readerBlockKey(live.blocks[1], index: 1))
        #expect(firstKey != secondKey)
        #expect(firstKey == ChatMarkdownRenderer.readerBlockKey(final.blocks[0], index: 0))
        #expect(secondKey == ChatMarkdownRenderer.readerBlockKey(final.blocks[1], index: 1))
        let repeated = ChatMarkdownRenderSnapshot(text: "# " + first + "\n\n# " + first, isComplete: true)
        try #require(repeated.blocks.count == 2)
        #expect(ChatMarkdownRenderer.readerBlockKey(repeated.blocks[0], index: 0) !=
            ChatMarkdownRenderer.readerBlockKey(repeated.blocks[1], index: 1))
    }

    @Test @MainActor func `streaming completion state reaches nested list items`() throws {
        let source = "1. first\n   - child\n2. last"
        let final = ChatMarkdownRenderSnapshot(text: source, isComplete: true)
        let streaming = ChatMarkdownRenderSnapshot(text: source, isComplete: false, preparesReveal: true)
        guard case let .list(list) = try #require(final.blocks.first),
              case let .list(nested) = try #require(list.items.first?.content.last)
        else {
            Issue.record("Expected nested list")
            return
        }
        let renderer = ChatMarkdownRenderer(
            snapshot: streaming, context: .assistant, variant: .standard,
            typography: .thinking, textColor: .primary)
        let view = renderer.listView(list)
        #expect(view.isStreaming)
        #expect(view.nestedListView(nested).isStreaming)
        #expect(view.typography == .thinking)
        #expect(view.nestedListView(nested).typography == .thinking)
        let finishedRenderer = ChatMarkdownRenderer(
            snapshot: final, context: .assistant, variant: .standard, textColor: .primary)
        #expect(!finishedRenderer.listView(list).isStreaming)
    }

    @Test func `item reveal preserves parsed source and thinking typography`() {
        let source = "Literal <final>word</final> and **bold**"
        let text = ChatStreamingAssistantText(markdown: source, kind: .thinking)
        #expect(text.sourceText == source)
        #expect(text.segments.count == 1)
        #expect(text.segments.first?.text == source)
        #expect(text.segments.first?.kind == .thinking)
    }
}
