import Testing
@testable import OpenClawChatUI

@Suite("ChatProgressCardMarkdown")
struct ChatProgressCardMarkdownTests {
    @Test func `a progress tag becomes a bar and leaves the text`() {
        let parsed = ChatProgressCardMarkdown("""
        <progress aria-label="PRs reviewed · 12/30" value="12" max="30"></progress>

        **Now:** reading the diff.
        """)
        #expect(parsed.bars == [.init(label: "PRs reviewed · 12/30", value: 12, total: 30)])
        #expect(parsed.text == "**Now:** reading the diff.")
    }

    @Test func `values are kept inside the bar and text without a tag is untouched`() {
        let over = ChatProgressCardMarkdown("<PROGRESS value='9' max='4'>")
        #expect(over.bars == [.init(label: nil, value: 4, total: 4)])
        #expect(over.text.isEmpty)

        let plain = ChatProgressCardMarkdown("Step 2 of 5: progress is slow")
        #expect(plain.bars.isEmpty && plain.text == "Step 2 of 5: progress is slow")
    }

    @Test func `multiple bars preserve their labels and remaining Markdown`() {
        let parsed = ChatProgressCardMarkdown("""
        # Review
        <progress aria-label="First > second" value="1" max="2"></progress>
        <progress aria-label='Other' value='2' max='3'></progress>
        **Next:** ship.
        """)
        #expect(parsed.bars == [
            .init(label: "First > second", value: 1, total: 2),
            .init(label: "Other", value: 2, total: 3),
        ])
        #expect(parsed.text == "# Review\n\n\n**Next:** ship.")
    }

    @Test func `invalid numbers default to a finite empty bar`() {
        for tag in [
            "<progress value='nan' max='inf'></progress>",
            "<progress value='-2' max='0'></progress>",
            "<progress aria-label='  ' value='bad' max='-5'></progress>",
        ] {
            let parsed = ChatProgressCardMarkdown(tag)
            #expect(parsed.bars == [.init(label: nil, value: 0, total: 1)])
            #expect(parsed.text.isEmpty)
        }
    }

    @Test func `code examples and similarly named tags stay literal`() {
        for text in [
            "`<progress value='1' max='2'></progress>`",
            "```html\n<progress value='1' max='2'></progress>\n```",
            "~~~html\n<progress value='1' max='2'></progress>\n~~~",
            "    <progress value='1' max='2'></progress>",
            "<progress-bar value='1' max='2'></progress-bar>",
            #"\<progress value='1' max='2'></progress>"#,
            "<!-- <progress value='1' max='2'></progress> -->",
            "<pre><progress value='1' max='2'></progress></pre>",
            "<div>\n<progress value='1' max='2'></progress>\n</div>",
            "<script><progress value='1' max='2'></progress></script>",
            "Note <script><progress value='1' max='2'></progress></script>",
            "Note <textarea><progress value='1' max='2'></progress></textarea>",
            "Note <style><progress value='1' max='2'></progress></style>",
            "Note <pre><progress value='1' max='2'></progress></pre>",
            "<span title=\"<progress value='1' max='2'></progress>\">example</span>",
        ] {
            let parsed = ChatProgressCardMarkdown(text)
            #expect(parsed.bars.isEmpty)
            #expect(parsed.text == text)
        }
    }

    @Test func `link destinations titles and image descriptions stay literal`() {
        for text in [
            "[guide](<progress>)",
            "[guide][p]\n\n[p]: <progress>",
            #"[guide](https://example.test "About <progress>")"#,
            "![<progress>](https://example.test/status.png)",
        ] {
            let parsed = ChatProgressCardMarkdown(text)
            #expect(parsed.bars.isEmpty)
            #expect(parsed.text == text)

            let withBar = ChatProgressCardMarkdown(text + "\n\n<progress value=3 max=5></progress>")
            #expect(withBar.bars == [.init(label: nil, value: 3, total: 5)])
            #expect(withBar.text == text)
        }
    }

    @Test func `CR and CRLF line endings keep code spans literal and bars working`() {
        // The Markdown parser ends lines at CR as well as LF; saved cards can carry either.
        for separator in ["\n", "\r", "\r\n"] {
            let exact = "First\(separator)`example`"
            let exactParsed = ChatProgressCardMarkdown(exact)
            #expect(exactParsed.bars.isEmpty)
            #expect(exactParsed.text == exact)
            let literal = "First\(separator)`<progress value='1' max='2'></progress>`"
            let literalParsed = ChatProgressCardMarkdown(literal)
            #expect(literalParsed.bars.isEmpty)
            #expect(literalParsed.text == literal)

            let fenced = "First\(separator)```html\n<progress value='1' max='2'></progress>\n```"
            let fencedParsed = ChatProgressCardMarkdown(fenced)
            #expect(fencedParsed.bars.isEmpty)
            #expect(fencedParsed.text == fenced)

            let card = "First\(separator)<progress value='3' max='5'></progress>\(separator)Done"
            let cardParsed = ChatProgressCardMarkdown(card)
            #expect(cardParsed.bars == [.init(label: nil, value: 3, total: 5)])
            #expect(cardParsed.text == "First\(separator)\(separator)Done")
        }
    }

    @Test func `a NUL byte does not shift code protection`() {
        // The Markdown parser reads a NUL byte as the three-byte replacement character, so
        // protection must map back onto the original bytes instead of shifted offsets.
        let protected = "\u{0}`<progress value='1' max='2'></progress>`"
        let protectedParsed = ChatProgressCardMarkdown(protected)
        #expect(protectedParsed.bars.isEmpty)
        #expect(protectedParsed.text == protected)

        let realBar = "\u{0}`x`<progress value='3' max='5'></progress>"
        let realBarParsed = ChatProgressCardMarkdown(realBar)
        #expect(realBarParsed.bars == [.init(label: nil, value: 3, total: 5)])
        #expect(realBarParsed.text == "\u{0}`x`")
    }

    @Test func `unreliable HTML source positions preserve the whole card`() {
        for html in ["<progress value=3 max=5></progress>", "<em>x</em>"] {
            for suffix in ["", " trailing prose"] {
                let text = "> note\ncontinued \(html)\(suffix)"
                let parsed = ChatProgressCardMarkdown(text)
                #expect(parsed.bars.isEmpty)
                #expect(parsed.text == text)
            }
        }
        let quoted = ChatProgressCardMarkdown("> note\n> continued <progress value=3 max=5></progress>")
        #expect(quoted.bars == [.init(label: nil, value: 3, total: 5)])
        #expect(quoted.text == "> note\n> continued ")
    }

    @Test func `numeric attributes are parsed outside labels and may be unquoted`() {
        let example = ChatProgressCardMarkdown("<progress aria-label=\"Example value='9' max='10'\"></progress>")
        #expect(example.bars == [.init(label: "Example value='9' max='10'", value: nil, total: 1)])
        let bare = ChatProgressCardMarkdown("<progress value=3 max=5></progress>")
        #expect(bare.bars == [.init(label: nil, value: 3, total: 5)])
    }

    @Test func `removing a bar preserves neighboring code indentation`() {
        for code in ["let code = 1", "</progress>"] {
            let parsed = ChatProgressCardMarkdown("<progress value=3 max=5>\n\n    \(code)\n")
            #expect(parsed.bars == [.init(label: nil, value: 3, total: 5)])
            #expect(parsed.text == "    \(code)")
        }
    }

    @Test func `literal raw tag openers do not hide a later real bar`() {
        for example in [
            "Example: `<pre>`",
            "Example: `<span title='x'`",
            "Example: `<progress value='1'`",
            "```html\n<script>\n```",
            #"Example: \<textarea>"#,
            "<span title='<pre>'>example</span>",
        ] {
            let parsed = ChatProgressCardMarkdown(example + "\n\n<progress value=3 max=5></progress>")
            #expect(parsed.bars == [.init(label: nil, value: 3, total: 5)])
            #expect(parsed.text == example)
        }
    }

    @Test func `raw tag text in a progress label cannot hide a later bar`() {
        for label in ["<pre>", "<script>", "<span title='x'>"] {
            let parsed = ChatProgressCardMarkdown(
                "<progress aria-label=\"\(label)\" value=1 max=2></progress>\n\n"
                    + "<progress value=3 max=5></progress>")
            #expect(parsed.bars == [
                .init(label: label, value: 1, total: 2),
                .init(label: nil, value: 3, total: 5),
            ])
            #expect(parsed.text.isEmpty)
        }
    }

    @Test func `labels decode entities without interpreting Markdown punctuation`() {
        let parsed =
            ChatProgressCardMarkdown("<progress aria-label='Build &amp; *test* &#183; 3/5' value=3 max=5></progress>")
        #expect(parsed.bars == [.init(label: "Build & *test* · 3/5", value: 3, total: 5)])
    }
}
