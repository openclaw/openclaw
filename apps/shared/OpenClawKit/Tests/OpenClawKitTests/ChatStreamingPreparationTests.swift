import Combine
import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatStreamingPreparationTests {
    @Test @MainActor func `mounted preparation preserves reveal through deltas and replaces source`() throws {
        let source = "<think>Consider **carefully**.</think>First words"
        let text = ChatStreamingAssistantText(sourceText: source, includesThinking: true)
        let preparation = ChatStreamingAssistantTextBody.Preparation(
            text: text, defaultDisclosureSummary: "Details", now: 0)
        #expect(preparation.snapshot.segments.count == 2)
        #expect(preparation.revealLocation?.segmentIndex == 1)
        #expect(preparation.revealState.text == "First words")
        let firstDeadline = try #require(preparation.revealState.words.first?.deadline)
        var publications = 0
        let observation = preparation.$snapshot.dropFirst().sink { _ in publications += 1 }
        defer { observation.cancel() }

        preparation.update(text: text, defaultDisclosureSummary: "Details", reduceMotion: false, now: 0.01)
        #expect(publications == 0)
        #expect(preparation.revealState.words.first?.deadline == firstDeadline)

        preparation.update(
            text: ChatStreamingAssistantText(sourceText: source + " continue", includesThinking: true),
            defaultDisclosureSummary: "Details", reduceMotion: false, now: 0.02)
        #expect(publications == 1)
        #expect(preparation.snapshot.segments[0].kind == .thinking)
        #expect(preparation.revealState.text == "First words continue")
        #expect(preparation.revealState.words.first?.deadline == firstDeadline)

        preparation.update(
            text: ChatStreamingAssistantText(sourceText: source + " continue", includesThinking: false),
            defaultDisclosureSummary: "Details", reduceMotion: true, now: 0.03)
        #expect(preparation.snapshot.segments.count == 1)
        #expect(preparation.snapshot.segments[0].kind == .response)
        #expect(preparation.revealLocation?.segmentIndex == 0)
        #expect(preparation.pendingUntil == nil)

        preparation.update(
            text: ChatStreamingAssistantText(markdown: "Replacement 👋🏽", kind: .thinking),
            defaultDisclosureSummary: "Details", reduceMotion: false, now: 0.04)
        #expect(preparation.snapshot.segments.count == 1)
        #expect(preparation.snapshot.segments[0].kind == .thinking)
        #expect(preparation.revealState.text == "Replacement 👋🏽")
        #expect(preparation.revealState.words.isEmpty)
        #expect(preparation.pendingUntil == nil)
    }

    @Test @MainActor func `reused blocks invalidate reveal role completion and localized summaries`() throws {
        let source = "First **words**\n\n```text\ndivider\n```"
        let initial = ChatMarkdownRenderSnapshot(text: source, isComplete: false, preparesReveal: true)
        let appended = ChatMarkdownRenderSnapshot(
            text: source + "\n\nLast words", isComplete: false, preparesReveal: true, reusing: initial)
        guard case let .prose(first) = try #require(appended.blocks.first),
              case let .prose(last) = try #require(appended.blocks.last)
        else {
            Issue.record("expected prose around the fence")
            return
        }
        #expect(first.plainText.isEmpty)
        #expect(first.tail.isEmpty)
        #expect(String(first.attributed.characters) == "First words")
        #expect(last.plainText == "Last words")
        #expect(last.tail.compactMap(\.wordRange) == [0..<4, 5..<10])

        let unclosed = "```swift\nlet value = 1"
        let live = ChatMarkdownRenderSnapshot(text: unclosed, isComplete: false, preparesReveal: true)
        let complete = ChatMarkdownRenderSnapshot(text: unclosed, isComplete: true, reusing: live)
        guard case let .code(code) = try #require(complete.blocks.first) else {
            Issue.record("expected completed code")
            return
        }
        #expect(code.isComplete)
        #expect(code.code == "let value = 1")

        let disclosure = "<details>\n\nBody\n\n</details>"
        let preparation = ChatStreamingAssistantTextBody.Preparation(
            text: ChatStreamingAssistantText(sourceText: disclosure, includesThinking: false),
            defaultDisclosureSummary: "Details", now: 0)
        preparation.update(
            text: ChatStreamingAssistantText(sourceText: disclosure, includesThinking: false),
            defaultDisclosureSummary: "Détails", reduceMotion: false, now: 1)
        guard case let .disclosure(rendered) = try #require(preparation.snapshot.segments.first?.markdown.blocks.first)
        else {
            Issue.record("expected disclosure")
            return
        }
        #expect(String(rendered.summary.attributed.characters) == "Détails")
    }

    @Test @MainActor func `changed source reparses references headings tables and list structure`() throws {
        let reference = "Read [docs][d].\n\n# Next"
        let initial = ChatMarkdownRenderSnapshot(text: reference, isComplete: false, preparesReveal: true)
        let resolved = ChatMarkdownRenderSnapshot(
            text: reference + "\n\n[d]: https://example.com/docs", isComplete: false,
            preparesReveal: true, reusing: initial)
        guard case let .prose(prose) = try #require(resolved.blocks.first) else {
            Issue.record("reference context must remain together")
            return
        }
        #expect(resolved.blocks.count == 1)
        let link = try #require(prose.attributed.range(of: "docs"))
        #expect(prose.attributed[link].link == URL(string: "https://example.com/docs"))

        let title = ChatMarkdownRenderSnapshot(text: "Title", isComplete: false, preparesReveal: true)
        let heading = ChatMarkdownRenderSnapshot(
            text: "Title\n===", isComplete: false, preparesReveal: true, reusing: title)
        guard case let .heading(level, headingProse) = try #require(heading.blocks.first) else {
            Issue.record("expected Setext heading")
            return
        }
        #expect(level == 1)
        #expect(String(headingProse.attributed.characters) == "Title")
        #expect(heading.lastProseIndex == nil)

        let header = ChatMarkdownRenderSnapshot(text: "| Item |", isComplete: false, preparesReveal: true)
        let table = ChatMarkdownRenderSnapshot(
            text: "| Item |\n| --- |\n| Value |", isComplete: false, preparesReveal: true, reusing: header)
        guard case let .table(renderedTable) = try #require(table.blocks.first) else {
            Issue.record("expected table")
            return
        }
        #expect(renderedTable.header == ["Item"])
        #expect(renderedTable.rows == [["Value"]])

        #if os(iOS)
        let list = ChatMarkdownRenderSnapshot(text: "- First", isComplete: false, preparesReveal: true)
        let nested = ChatMarkdownRenderSnapshot(
            text: "- First\n  - Child\n- Last", isComplete: false, preparesReveal: true, reusing: list)
        guard case let .list(renderedList) = try #require(nested.blocks.first),
              case let .list(child) = try #require(renderedList.items.first?.content.last)
        else {
            Issue.record("expected nested streamed list")
            return
        }
        #expect(renderedList.items.count == 2)
        #expect(child.items.first?.content == [.markdown("Child")])
        #endif
    }
}
