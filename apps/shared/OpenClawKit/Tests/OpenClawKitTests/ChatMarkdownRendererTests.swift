import Foundation
import Testing
@testable import OpenClawChatUI

@Suite("ChatMarkdownRenderer")
struct ChatMarkdownRendererTests {
    // Regression for issue #98028: assistant responses on iOS were rendered
    // as a single line because Foundation's CommonMark parser collapses solo
    // newlines into spaces. The renderer now promotes intra-paragraph
    // newlines into CommonMark hard breaks before parsing.

    @Test func `preserves single newlines between assistant lines`() {
        let parsed = ChatMarkdownRenderer.parsedMarkdown("hello\nworld")
        let characters = String(parsed.characters)
        #expect(characters.contains("\n"))
        #expect(characters == "hello\nworld")
    }

    @Test func `preserves multiple solo newlines across lines`() {
        let parsed = ChatMarkdownRenderer.parsedMarkdown("Line 1\nLine 2\nLine 3")
        #expect(String(parsed.characters) == "Line 1\nLine 2\nLine 3")
    }

    @Test func `injects hard breaks for intra-paragraph newlines`() {
        let prepared = ChatMarkdownRenderer.preserveSoftLineBreaks(in: "hello\nworld")
        #expect(prepared == "hello  \nworld")
    }

    @Test func `keeps blank line paragraph separators`() {
        let prepared = ChatMarkdownRenderer.preserveSoftLineBreaks(in: "Para1\n\nPara2")
        #expect(prepared == "Para1\n\nPara2")
    }

    @Test func `leaves fenced code blocks untouched`() {
        let input = "before\n```\nlet x = 1\nlet y = 2\n```\nafter"
        let prepared = ChatMarkdownRenderer.preserveSoftLineBreaks(in: input)
        // `before` and `after` flank the fence and pick up hard breaks because
        // each is adjacent to a non-blank line, but lines inside the fence
        // stay verbatim so code keeps its layout.
        #expect(prepared == "before  \n```\nlet x = 1\nlet y = 2\n```\nafter")
    }

    @Test func `does not double-break already hard-broken lines`() {
        let input = "Already hard  \nbreak"
        let prepared = ChatMarkdownRenderer.preserveSoftLineBreaks(in: input)
        #expect(prepared == "Already hard  \nbreak")
    }

    @Test func `leaves backslash hard breaks alone`() {
        let input = "Above\\\nBelow"
        let prepared = ChatMarkdownRenderer.preserveSoftLineBreaks(in: input)
        #expect(prepared == "Above\\\nBelow")
    }

    @Test func `passes through single-line and empty inputs`() {
        #expect(ChatMarkdownRenderer.preserveSoftLineBreaks(in: "") == "")
        #expect(ChatMarkdownRenderer.preserveSoftLineBreaks(in: "solo") == "solo")
    }

    @Test func `keeps unordered list semantics intact`() {
        let prepared = ChatMarkdownRenderer.preserveSoftLineBreaks(in: "- one\n- two")
        // Trailing spaces on a list-item content line do not disturb the
        // CommonMark list parser; the second line still begins a list item.
        let parsed = ChatMarkdownRenderer.parsedMarkdown("- one\n- two")
        var sawListItem = false
        for run in parsed.runs {
            if let intent = run.presentationIntent, "\(intent)".contains("listItem") {
                sawListItem = true
                break
            }
        }
        #expect(sawListItem)
        #expect(prepared == "- one  \n- two")
    }

    @Test func `keeps header followed by paragraph as header`() {
        let parsed = ChatMarkdownRenderer.parsedMarkdown("# Heading\nBody")
        var sawHeader = false
        for run in parsed.runs {
            if let intent = run.presentationIntent, "\(intent)".contains("header") {
                sawHeader = true
                break
            }
        }
        #expect(sawHeader)
    }
}
