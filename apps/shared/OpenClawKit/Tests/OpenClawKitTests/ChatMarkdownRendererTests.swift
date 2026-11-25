import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatMarkdownRendererTests {
    @Test @MainActor func `retained preparation follows completion and late reference definitions`() throws {
        let preparation = ChatMarkdownPreparation()
        let fence = "```swift\nlet value = 1"
        for isComplete in [false, true, false] {
            let snapshot = preparation.snapshot(
                text: fence,
                isComplete: isComplete,
                defaultDisclosureSummary: "Details")
            guard case let .code(code) = try #require(snapshot.blocks.first) else {
                Issue.record("expected code block")
                return
            }
            #expect(code.code == "let value = 1")
            #expect(code.isComplete == isComplete)
        }

        let prefix = "See [guide][g].\n\n# Section"
        for destination in ["https://example.com/first", "https://example.com/second"] {
            let snapshot = preparation.snapshot(
                text: prefix + "\n\n[g]: " + destination,
                isComplete: true,
                defaultDisclosureSummary: "Details")
            guard case let .prose(prose) = try #require(snapshot.blocks.first) else {
                Issue.record("reference document must stay on the complete prose path")
                return
            }
            let guide = try #require(prose.attributed.range(of: "guide"))
            #expect(prose.attributed[guide].link == URL(string: destination))
        }
        let replacement = preparation.snapshot(
            text: "Replacement **message**.",
            isComplete: true,
            defaultDisclosureSummary: "Details")
        guard case let .prose(prose) = try #require(replacement.blocks.first) else {
            Issue.record("expected replacement prose")
            return
        }
        #expect(String(prose.attributed.characters) == "Replacement message.")
    }

    @Test @MainActor func `retained preparation refreshes default summaries and preserves authored summaries`() throws {
        let preparation = ChatMarkdownPreparation()
        let text = """
        <details>

        Body.

        <details>
        <summary>Authored summary</summary>

        Nested body.

        </details>
        </details>
        """
        for summary in ["Details", "More information", "Details"] {
            let snapshot = preparation.snapshot(
                text: text,
                isComplete: true,
                defaultDisclosureSummary: summary)
            guard case let .disclosure(outer) = try #require(snapshot.blocks.first),
                  case let .disclosure(inner) = try #require(outer.blocks.last)
            else {
                Issue.record("expected nested disclosures")
                return
            }
            #expect(String(outer.summary.attributed.characters) == summary)
            #expect(String(inner.summary.attributed.characters) == "Authored summary")
        }
    }

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

    private struct RenderedChip: Equatable {
        let kind: ChatInlineChipKind
        let label: String
        let link: String?
    }

    private struct RenderedProse: Equatable {
        let text: String
        let chips: [RenderedChip]
    }

    /// Prose and heading blocks as a message body renders them: file references resolve only with
    /// file links on, labelled across the whole message.
    @MainActor private func render(_ markdown: String, fileLinks: Bool = true) -> RenderedProse {
        let snapshot = ChatMarkdownRenderSnapshot(text: markdown, isComplete: true)
        let labels = fileLinks ? ChatMarkdownInlineChips.shortestFileLabels(snapshot.filePaths) : nil
        var texts: [String] = []
        var chips: [RenderedChip] = []
        for block in snapshot.blocks {
            let prose: ChatMarkdownProse
            switch block {
            case let .prose(value), let .heading(_, value): prose = value
            default: continue
            }
            let attributed = labels.map { ChatMarkdownInlineChips.resolvingFiles(in: prose.attributed, labels: $0) }
                ?? prose.attributed
            texts.append(String(attributed.characters))
            chips += attributed.runs[ChatInlineChipAttribute.self].compactMap { kind, range in
                kind.map {
                    RenderedChip(
                        kind: $0,
                        label: String(attributed[range].characters),
                        link: attributed[range].runs.first?.link?.absoluteString)
                }
            }
        }
        return RenderedProse(text: texts.joined(separator: "\n"), chips: chips)
    }

    @Test @MainActor func `file references become chips labelled by their shortest unique path`() throws {
        let rendered = self.render("Edit `src/app.ts`, then ui/src/a/index.ts:42 and ui/src/b/index.ts.")
        #expect(rendered.text == "Edit app.ts, then a/index.ts:42 and b/index.ts.")
        #expect(rendered.chips.map(\.kind) == [.file, .file, .file])
        let target = try #require(rendered.chips[1].link.flatMap(URL.init(string:)).flatMap {
            ChatMarkdownInlineChips.fileTarget(from: $0)
        })
        #expect(target == .init(path: "ui/src/a/index.ts", line: 42))
        // An allowlisted bare filename is a file only as a whole code span.
        #expect(self.render("Read `README.md` before README.md").chips.map(\.label) == ["README.md"])
    }

    @Test @MainActor func `file labels are unique across the whole message, not per block`() {
        let snapshot = ChatMarkdownRenderSnapshot(
            text: "Changed:\n\n- ui/src/a/index.ts\n- ui/src/b/index.ts\n\nSee `docs/guide.md`.",
            isComplete: true)
        #expect(ChatMarkdownInlineChips.shortestFileLabels(snapshot.filePaths) == [
            "ui/src/a/index.ts": "a/index.ts",
            "ui/src/b/index.ts": "b/index.ts",
            "docs/guide.md": "guide.md",
        ])
    }

    @Test @MainActor func `file references stay plain text where file links are off`() {
        let source = "Edit `src/app.ts` and ui/src/views/chat.tsx:42."
        let rendered = self.render(source, fileLinks: false)
        #expect(rendered.text == "Edit src/app.ts and ui/src/views/chat.tsx:42.")
        #expect(rendered.chips.isEmpty)
    }

    @Test @MainActor func `version numbers, domains, URLs and repository names are not files`() {
        for source in [
            "Bump 1.1/1.2 and ship openclaw/openclaw.ai today.",
            "See example.com/app.ts and https://example.com/src/app.ts for details.",
            "Plain words like README, main and docs stay text.",
            "`npm run build`",
        ] {
            #expect(self.render(source).chips.isEmpty)
        }
    }

    @Test @MainActor func `GitHub items render their full reference and open the URL as written`() {
        #expect(self.render("Landed https://github.com/openclaw/openclaw/pull/198221/files today.") == RenderedProse(
            text: "Landed openclaw/openclaw#198221 today.",
            chips: [RenderedChip(
                kind: .pullRequest,
                label: "openclaw/openclaw#198221",
                link: "https://github.com/openclaw/openclaw/pull/198221/files")]))
        #expect(self.render("The fix ([#198221](https://github.com/openclaw/openclaw/pull/198221)) is live.").text
            == "The fix (openclaw/openclaw#198221) is live.")
        #expect(self.render("Tracked in openclaw/openclaw#12, and `https://github.com/openclaw/openclaw/issues/9`.")
            == RenderedProse(
                text: "Tracked in openclaw/openclaw#12, and openclaw/openclaw#9.",
                chips: [
                    RenderedChip(
                        kind: .issue,
                        label: "openclaw/openclaw#12",
                        link: "https://github.com/openclaw/openclaw/issues/12"),
                    RenderedChip(
                        kind: .issue,
                        label: "openclaw/openclaw#9",
                        link: "https://github.com/openclaw/openclaw/issues/9"),
                ]))
        #expect(self.render("See openclaw/openclaw PR #34.").chips == [
            RenderedChip(
                kind: .pullRequest,
                label: "openclaw/openclaw#34",
                link: "https://github.com/openclaw/openclaw/pull/34"),
        ])
    }

    @Test @MainActor func `GitHub non-item URLs, unqualified numbers and headings stay plain`() {
        for source in [
            "Read https://github.com/openclaw/openclaw/blob/main/README.md first.",
            "[the repo](https://github.com/openclaw/openclaw/pull/12) and #12 and issue #45",
            "Item 4 of #1234 at v1.2#3 and step#5",
            "# Fixes openclaw/openclaw#12",
        ] {
            #expect(self.render(source).chips.isEmpty)
        }
    }
}
