import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMarkdownRendererTests {
    @Test(arguments: [false, true]) @MainActor
    func `paragraph before a list retains its break in stored and streaming messages`(isComplete: Bool) throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: """
            I read the file. It contains the workspace instructions.

            Key points:
            - Keep answers short.
            - Prefer **plain words**.

            ```mermaid
            graph TD
              A[Read file] --> B{Useful?}
              B -- yes --> C[Summarize]
              B -- no --> D[Ask]
            ```
            """,
            isComplete: isComplete,
            preparesReveal: !isComplete)
        guard case let .prose(prose) = try #require(snapshot.blocks.first),
              case let .code(code) = try #require(snapshot.blocks.last)
        else {
            Issue.record("expected prose before the diagram")
            return
        }
        let intro = "I read the file. It contains the workspace instructions.\n\nKey points:"
        #expect(String(prose.attributed.characters).hasPrefix(intro))
        #expect(code.language == "mermaid")
        #expect(code.isComplete)
        if isComplete {
            #expect(snapshot.blocks.count == 3)
            guard case let .list(list) = snapshot.blocks[1] else {
                Issue.record("expected a separate list")
                return
            }
            #expect(list.items.count == 2)
        } else {
            #expect(prose.plainText.hasPrefix(intro))
            #expect((String(prose.prefix.characters) + prose.tail.map { String($0.attributed.characters) }.joined())
                == prose.plainText)
        }
    }

    @Test(arguments: [false, true]) @MainActor
    func `paragraph separation preserves inline styles links and soft breaks`(preparesReveal: Bool) throws {
        let prose = ChatMarkdownProse(
            markdown: "First **bold** [docs][d].\nNext line.\n\nSecond *paragraph*.\n\n[d]: https://example.com",
            isComplete: true,
            preparesReveal: preparesReveal)
        #expect(String(prose.attributed.characters) == "First bold docs.\nNext line.\n\nSecond paragraph.")
        let bold = try #require(prose.attributed.range(of: "bold"))
        #expect(prose.attributed[bold].inlinePresentationIntent?.contains(.stronglyEmphasized) == true)
        let docs = try #require(prose.attributed.range(of: "docs"))
        #expect(prose.attributed[docs].link == URL(string: "https://example.com"))
        let paragraph = try #require(prose.attributed.range(of: "paragraph"))
        #expect(prose.attributed[paragraph].inlinePresentationIntent?.contains(.emphasized) == true)
    }

    @Test @MainActor func `structural transitions retain prose paragraphs on both sides`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: "First.\n\nSecond.\n- Item\n\nAfter list.\n\n```text\nCode\n```\n\n# Heading\n\nLast.",
            isComplete: true)
        try #require(snapshot.blocks.count == 6)
        guard case let .prose(before) = snapshot.blocks[0],
              case .list = snapshot.blocks[1],
              case let .prose(afterList) = snapshot.blocks[2],
              case .code = snapshot.blocks[3],
              case .heading = snapshot.blocks[4],
              case let .prose(afterHeading) = snapshot.blocks[5]
        else {
            Issue.record("expected prose, list, prose, code, heading, prose")
            return
        }
        #expect(String(before.attributed.characters) == "First.\n\nSecond.")
        #expect(String(afterList.attributed.characters) == "After list.")
        #expect(String(afterHeading.attributed.characters) == "Last.")
    }

    @Test @MainActor func `streaming reveal prepares only the last prose before a trailing heading`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: """
            Earlier **bold** [docs](https://example.com).

            ```text
            divider
            ```

            Latest *words*

            # End
            """,
            isComplete: false,
            preparesReveal: true)
        try #require(snapshot.blocks.count == 4)
        #expect(snapshot.lastProseIndex == 2)
        guard case let .prose(earlier) = snapshot.blocks[0],
              case let .code(code) = snapshot.blocks[1],
              case let .prose(latest) = snapshot.blocks[2],
              case let .heading(level, heading) = snapshot.blocks[3]
        else {
            Issue.record("expected prose, code, prose, heading")
            return
        }

        #expect(String(earlier.attributed.characters) == "Earlier bold docs.")
        let bold = try #require(earlier.attributed.range(of: "bold"))
        #expect(earlier.attributed[bold].inlinePresentationIntent?.contains(.stronglyEmphasized) == true)
        let docs = try #require(earlier.attributed.range(of: "docs"))
        #expect(earlier.attributed[docs].link == URL(string: "https://example.com"))
        #expect(earlier.plainText.isEmpty)
        #expect(earlier.prefix.characters.isEmpty)
        #expect(earlier.tail.isEmpty)
        #expect(earlier.inlineContent == nil)

        #expect(code.language == "text")
        #expect(code.code == "divider")
        #expect(code.isComplete)
        #expect(String(latest.attributed.characters) == "Latest words")
        let words = try #require(latest.attributed.range(of: "words"))
        #expect(latest.attributed[words].inlinePresentationIntent?.contains(.emphasized) == true)
        #expect(latest.plainText == "Latest words")
        #expect(latest.prefix.characters.isEmpty)
        #expect(latest.tail.map { String($0.attributed.characters) }.joined() == "Latest words")
        #expect(latest.tail.compactMap(\.wordRange) == [0..<6, 7..<12])
        #expect(level == 1)
        #expect(String(heading.attributed.characters) == "End")
        #expect(heading.plainText.isEmpty)
        #expect(heading.tail.isEmpty)
    }

    @Test @MainActor func `completed snapshots with reveal keep every prose on the attributed math path`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: #"""
            Before \(x^2\)

            ```text
            divider
            ```

            After \(y^2\)
            """#,
            isComplete: true,
            preparesReveal: true)
        try #require(snapshot.blocks.count == 3)
        for (index, text) in [(0, "Before (x^2)"), (2, "After (y^2)")] {
            guard case let .prose(prose) = snapshot.blocks[index] else {
                Issue.record("expected completed prose")
                return
            }
            #expect(String(prose.attributed.characters) == text)
            #expect(prose.plainText == text)
            #expect(prose.inlineContent == nil)
            #expect(prose.inlineMathLatex.isEmpty)
            #expect(prose.tail.map { String($0.attributed.characters) }.joined() == text)
        }
    }

    @Test @MainActor func `streaming disclosure body stays directly renderable`() throws {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: """
            <details>
            <summary>More detail</summary>

            I'm here to help with questions, projects, and practical tasks.

            - Clear answers
            - Thoughtful assistance

            ```bash
            echo "Hello"
            ```

            </details>
            """,
            isComplete: false,
            preparesReveal: true)
        guard case let .disclosure(disclosure) = try #require(snapshot.blocks.first) else {
            Issue.record("expected rendered disclosure")
            return
        }

        #expect(String(disclosure.summary.attributed.characters) == "More detail")
        #expect(disclosure.blocks.count == 2)

        guard case let .prose(prose) = disclosure.blocks[0] else {
            Issue.record("expected renderable disclosure prose")
            return
        }
        let proseText = String(prose.attributed.characters)
        #expect(proseText.contains("I'm here to help with questions, projects, and practical tasks."))
        #expect(proseText.contains("Clear answers"))
        #expect(proseText.contains("Thoughtful assistance"))
        #expect(prose.plainText.isEmpty)
        #expect(prose.prefix.characters.isEmpty)
        #expect(prose.tail.isEmpty)

        guard case let .code(code) = disclosure.blocks[1] else {
            Issue.record("expected rendered disclosure code block")
            return
        }
        #expect(code.language == "bash")
        #expect(code.code == "echo \"Hello\"")
    }
}
