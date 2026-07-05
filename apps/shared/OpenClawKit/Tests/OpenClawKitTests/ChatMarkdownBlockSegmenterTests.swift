import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMarkdownBlockSegmenterTests {
    private func segments(_ markdown: String, isComplete: Bool = true) -> [ChatMarkdownBlock] {
        ChatMarkdownBlockSegmenter.segments(markdown: markdown, isComplete: isComplete)
    }

    // MARK: - Prose

    @Test func `plain prose stays one block`() {
        let blocks = self.segments("alpha\nbeta\n\ngamma")
        #expect(blocks == [.prose("alpha\nbeta\n\ngamma")])
    }

    @Test func `whitespace only input yields no blocks`() {
        #expect(self.segments("  \n\n ") == [])
    }

    @Test func `crlf input is normalized`() {
        let blocks = self.segments("alpha\r\n```\r\ncode\r\n```")
        #expect(blocks == [
            .prose("alpha"),
            .code(ChatCodeBlock(language: nil, code: "code", isComplete: true)),
        ])
    }

    // MARK: - Fenced code

    @Test func `fence with language and surrounding prose`() {
        let blocks = self.segments("""
        before
        ```swift
        let x = 1
        ```
        after
        """)
        #expect(blocks == [
            .prose("before"),
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
            .prose("after"),
        ])
    }

    @Test func `info string extras keep only the first word lowercased`() {
        let blocks = self.segments("```Swift title=Example.swift\nlet x = 1\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
        ])
    }

    @Test func `backtick info string containing backtick is not a fence`() {
        // CommonMark: ``` foo`bar ``` is an inline code span, not a fence.
        let blocks = self.segments("``` foo`bar ```")
        #expect(blocks == [.prose("``` foo`bar ```")])
    }

    @Test func `tilde fence keeps nested backtick fences as content`() {
        let blocks = self.segments("""
        ~~~markdown
        ```swift
        let x = 1
        ```
        ~~~
        """)
        #expect(blocks == [
            .code(ChatCodeBlock(
                language: "markdown",
                code: "```swift\nlet x = 1\n```",
                isComplete: true)),
        ])
    }

    @Test func `shorter close run does not close the fence`() {
        let blocks = self.segments("````\n```\ncode\n````")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: "```\ncode", isComplete: true)),
        ])
    }

    @Test func `longer close run closes the fence`() {
        let blocks = self.segments("```\ncode\n`````")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: "code", isComplete: true)),
        ])
    }

    @Test func `close line with trailing text stays content`() {
        let blocks = self.segments("```text\n``` not a close\nstill code\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(
                language: "text",
                code: "``` not a close\nstill code",
                isComplete: true)),
        ])
    }

    @Test func `indented opener dedents content by the same amount`() {
        let blocks = self.segments("  ```\n   code\n  ```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: " code", isComplete: true)),
        ])
    }

    @Test func `four space indent is not a fence`() {
        let markdown = "    ```\n    code"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `unclosed fence in complete message renders as code`() {
        let blocks = self.segments("```swift\nlet x = 1")
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
        ])
    }

    // MARK: - Streaming fallbacks

    @Test func `unclosed fence while streaming stays plain`() {
        let blocks = self.segments("```swift\nlet x = 1", isComplete: false)
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: false)),
        ])
    }

    @Test func `closed fence while streaming is complete`() {
        let blocks = self.segments("```swift\nlet x = 1\n```\nmore", isComplete: false)
        #expect(blocks == [
            .code(ChatCodeBlock(language: "swift", code: "let x = 1", isComplete: true)),
            .prose("more"),
        ])
    }

    @Test func `trailing table while streaming stays prose`() {
        let markdown = "intro\n| a | b |\n| - | - |\n| 1 | 2 |"
        #expect(self.segments(markdown, isComplete: false) == [.prose(markdown)])
    }

    @Test func `trailing table with only trailing newline while streaming stays prose`() {
        // The trailing newline is not a committed blank line: the next delta
        // may still append rows, so the table must not render rich yet.
        let markdown = "| a | b |\n| - | - |\n| 1 | 2 |\n"
        #expect(self.segments(markdown, isComplete: false) == [
            .prose("| a | b |\n| - | - |\n| 1 | 2 |"),
        ])
    }

    @Test func `settled table while streaming renders as table`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| 1 | 2 |\n\nafter", isComplete: false)
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("after"),
        ])
    }

    // MARK: - Tables

    @Test func `table with alignments and body rows`() {
        let blocks = self.segments("""
        | Name | Count | Price |
        | :--- | :---: | ----: |
        | a | 1 | 2.50 |
        | b | 2 | 3.00 |
        """)
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["Name", "Count", "Price"],
                alignments: [.leading, .center, .trailing],
                rows: [["a", "1", "2.50"], ["b", "2", "3.00"]])),
        ])
    }

    @Test func `table without boundary pipes`() {
        let blocks = self.segments("a | b\n--- | ---\n1 | 2")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
        ])
    }

    @Test func `escaped pipe stays a literal cell character`() {
        let blocks = self.segments("| a\\|b | c |\n| - | - |\n| 1 | 2 |")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a|b", "c"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
        ])
    }

    @Test func `short rows pad and long rows truncate to header width`() {
        let blocks = self.segments("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", ""], ["1", "2"]])),
        ])
    }

    @Test func `table body stops at blank line`() {
        let blocks = self.segments("| a |b|\n| - |-|\n| 1 |2|\n\nprose | not a row")
        #expect(blocks == [
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("prose | not a row"),
        ])
    }

    @Test func `header delimiter count mismatch falls back to prose`() {
        let markdown = "| a | b |\n| - | - | - |\n| 1 | 2 |"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `delimiter row without header pipe falls back to prose`() {
        let markdown = "heading\n| - | - |"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `pipes without delimiter row stay prose`() {
        let markdown = "use foo | bar\nthen continue"
        #expect(self.segments(markdown) == [.prose(markdown)])
    }

    @Test func `table header inside paragraph is detected`() {
        let blocks = self.segments("intro line\n| a | b |\n| - | - |\n| 1 | 2 |\n\ndone")
        #expect(blocks == [
            .prose("intro line"),
            .table(ChatMarkdownTable(
                header: ["a", "b"],
                alignments: [.leading, .leading],
                rows: [["1", "2"]])),
            .prose("done"),
        ])
    }

    @Test func `table syntax inside fence stays code`() {
        let blocks = self.segments("```\n| a | b |\n| - | - |\n```")
        #expect(blocks == [
            .code(ChatCodeBlock(language: nil, code: "| a | b |\n| - | - |", isComplete: true)),
        ])
    }
}
