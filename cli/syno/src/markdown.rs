use pulldown_cmark::{Options, Parser, html};

/// Convert Markdown text to HTML string.
pub fn md_to_html(markdown: &str) -> String {
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS;
    let parser = Parser::new_ext(markdown, options);
    let mut html_output = String::new();
    html::push_html(&mut html_output, parser);
    html_output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basic_conversion() {
        let md = "# Hello\n\nworld **bold**";
        let html = md_to_html(md);
        assert!(html.contains("<h1>Hello</h1>"));
        assert!(html.contains("<strong>bold</strong>"));
    }

    #[test]
    fn table_conversion() {
        let md = "| A | B |\n|---|---|\n| 1 | 2 |";
        let html = md_to_html(md);
        assert!(html.contains("<table>"));
    }
}
