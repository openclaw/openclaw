import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMarkdownDisplayPreprocessorTests {
    @Test func `converts plain chat soft breaks to markdown hard breaks`() throws {
        let markdown = """
        alpha
        beta
        gamma
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == "alpha\u{20}\u{20}\nbeta\u{20}\u{20}\ngamma")
        #expect(try self.renderedCharacters(prepared) == "alpha\nbeta\ngamma")
    }

    @Test func `keeps blank line paragraph boundaries`() {
        let markdown = """
        alpha

        beta
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == markdown)
    }

    @Test func `does not duplicate existing hard breaks`() {
        let markdown = "alpha\u{20}\u{20}\nbeta\\\ngamma"

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == markdown)
    }

    @Test func `preserves fenced code blocks`() {
        let markdown = """
        ```swift
        alpha
        beta
        ```
        after
        next
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == "```swift\nalpha\nbeta\n```\nafter\u{20}\u{20}\nnext")
    }

    @Test func `keeps fence like code content inside active fence`() {
        let markdown = """
        ```text
        ``` not a close
        still code
        ```
        after
        next
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == "```text\n``` not a close\nstill code\n```\nafter\u{20}\u{20}\nnext")
    }

    @Test func `preserves block markdown structure`() {
        let markdown = """
        Intro
        - item one
        - item two

        # Heading
        > quote
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == markdown)
    }

    @Test func `preserves table like markdown rows`() {
        let markdown = """
        A | B
        --- | ---
        1 | 2
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == markdown)
    }

    @Test func `converts plain pipe prose soft breaks`() {
        let markdown = """
        Use foo | bar
        then continue
        """

        let prepared = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)

        #expect(prepared == "Use foo | bar\u{20}\u{20}\nthen continue")
    }

    private func renderedCharacters(_ markdown: String) throws -> String {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let attributed = try AttributedString(markdown: markdown, options: options)
        return String(attributed.characters)
    }
}
