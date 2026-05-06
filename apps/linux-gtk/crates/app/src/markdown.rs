use pulldown_cmark::{Event, Parser, Tag, TagEnd};

/// Escape the characters that Pango markup interprets (&, <, >, ', ").
/// Pure function — does NOT require GTK init, so unit-testable.
fn pango_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '\'' => out.push_str("&apos;"),
            '"' => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

/// Convert a Markdown string to Pango markup for use in GtkLabel.
/// Handles bold, italic, code, and headings. Falls back to plain text for
/// unsupported elements.
#[allow(dead_code)]
pub fn to_pango(md: &str) -> String {
    let parser = Parser::new(md);
    let mut out = String::with_capacity(md.len());

    for event in parser {
        match event {
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => out.push('\n'),
            Event::Start(Tag::Strong) => out.push_str("<b>"),
            Event::End(TagEnd::Strong) => out.push_str("</b>"),
            Event::Start(Tag::Emphasis) => out.push_str("<i>"),
            Event::End(TagEnd::Emphasis) => out.push_str("</i>"),
            Event::Start(Tag::Heading { level, .. }) => {
                let size = match level {
                    pulldown_cmark::HeadingLevel::H1 => "xx-large",
                    pulldown_cmark::HeadingLevel::H2 => "x-large",
                    pulldown_cmark::HeadingLevel::H3 => "large",
                    _ => "medium",
                };
                out.push_str(&format!("<span size=\"{size}\"><b>"));
            }
            Event::End(TagEnd::Heading(_)) => {
                out.push_str("</b></span>\n");
            }
            Event::Code(text) => {
                out.push_str("<tt>");
                out.push_str(&pango_escape(&text));
                out.push_str("</tt>");
            }
            Event::Text(text) => {
                out.push_str(&pango_escape(&text));
            }
            Event::SoftBreak => out.push('\n'),
            Event::HardBreak => out.push('\n'),
            Event::Start(Tag::CodeBlock(_)) => out.push_str("<tt>"),
            Event::End(TagEnd::CodeBlock) => out.push_str("</tt>\n"),
            Event::Start(Tag::List(_)) => {}
            Event::End(TagEnd::List(_)) => {}
            Event::Start(Tag::Item) => out.push_str(" • "),
            Event::End(TagEnd::Item) => out.push('\n'),
            _ => {}
        }
    }

    // Trim trailing newlines
    while out.ends_with('\n') {
        out.pop();
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_pango_markup_chars() {
        assert_eq!(pango_escape("a & b"), "a &amp; b");
        assert_eq!(pango_escape("<tag>"), "&lt;tag&gt;");
        assert_eq!(pango_escape("\"hi\""), "&quot;hi&quot;");
        assert_eq!(pango_escape("it's"), "it&apos;s");
        assert_eq!(pango_escape("plain"), "plain");
    }

    #[test]
    fn plain_text_passes_through() {
        assert_eq!(to_pango("hello world"), "hello world");
    }

    #[test]
    fn escapes_special_chars_in_text() {
        assert_eq!(to_pango("a < b & c > d"), "a &lt; b &amp; c &gt; d");
    }

    #[test]
    fn bold_becomes_b_tag() {
        assert_eq!(to_pango("**strong**"), "<b>strong</b>");
    }

    #[test]
    fn italic_becomes_i_tag() {
        assert_eq!(to_pango("*em*"), "<i>em</i>");
    }

    #[test]
    fn inline_code_becomes_tt_tag() {
        assert_eq!(to_pango("`code`"), "<tt>code</tt>");
    }

    #[test]
    fn inline_code_escapes_special_chars() {
        assert_eq!(to_pango("`<div>`"), "<tt>&lt;div&gt;</tt>");
    }

    #[test]
    fn headings_produce_sized_spans() {
        let out = to_pango("# Title");
        assert!(out.contains("xx-large"));
        assert!(out.contains("<b>Title</b>"));
    }

    #[test]
    fn h2_uses_x_large() {
        assert!(to_pango("## Sub").contains("x-large"));
    }

    #[test]
    fn list_items_get_bullet_prefix() {
        let out = to_pango("- one\n- two");
        assert!(out.contains(" • one"));
        assert!(out.contains(" • two"));
    }

    #[test]
    fn code_blocks_wrap_in_tt() {
        let out = to_pango("```\nfn main() {}\n```");
        assert!(out.contains("<tt>"));
        assert!(out.contains("</tt>"));
        assert!(out.contains("fn main() {}"));
    }

    #[test]
    fn trailing_newlines_trimmed() {
        let out = to_pango("hello\n\n\n");
        assert!(!out.ends_with('\n'));
    }

    #[test]
    fn mixed_formatting() {
        let out = to_pango("**bold** and *italic* and `code`");
        assert!(out.contains("<b>bold</b>"));
        assert!(out.contains("<i>italic</i>"));
        assert!(out.contains("<tt>code</tt>"));
    }

    #[test]
    fn empty_input_returns_empty() {
        assert_eq!(to_pango(""), "");
    }

    #[test]
    fn raw_html_input_is_stripped() {
        // pulldown-cmark emits Event::Html/InlineHtml for raw HTML, which we
        // deliberately drop in the match. Result: the raw tag AND its text
        // are gone — safest possible handling for untrusted chat content.
        let out = to_pango("<script>alert(1)</script>");
        assert!(!out.contains("<script>"));
        assert!(!out.contains("</script>"));
    }

    #[test]
    fn plain_angle_brackets_in_text_are_escaped() {
        // Bare `<` without a matching `>` is treated as text by markdown,
        // so it reaches Event::Text and goes through pango_escape.
        let out = to_pango("use < here");
        assert!(out.contains("&lt;"));
        assert!(!out.contains("<b>"));
    }
}
