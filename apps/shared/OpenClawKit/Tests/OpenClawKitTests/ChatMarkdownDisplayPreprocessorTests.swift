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

        #expect(
            prepared == """
            alpha  
            beta  
            gamma
            """)
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
        let markdown = """
        alpha  
        beta\\
        gamma
        """

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

        #expect(
            prepared == """
            ```swift
            alpha
            beta
            ```
            after  
            next
            """)
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

        #expect(
            prepared == """
            ```text
            ``` not a close
            still code
            ```
            after  
            next
            """)
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

        #expect(
            prepared == """
            Use foo | bar  
            then continue
            """)
    }

    private func renderedCharacters(_ markdown: String) throws -> String {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let attributed = try AttributedString(markdown: markdown, options: options)
        return String(attributed.characters)
    }
}
