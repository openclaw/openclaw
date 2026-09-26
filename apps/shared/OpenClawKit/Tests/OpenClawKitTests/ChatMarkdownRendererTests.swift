import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMarkdownRendererTests {
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
