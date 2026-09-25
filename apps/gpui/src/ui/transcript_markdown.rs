use std::collections::HashMap;

use markdown::{ParseOptions, mdast::Node};

/// Use the same parser and options as GPUI's TextView; only actual image/HTML
/// nodes change, so fenced and indented examples retain their original bytes.
pub(super) fn unloaded_images(source: &str) -> String {
    let Ok(tree) = markdown::to_mdast(source, &parse_options()) else {
        return literal_text(source);
    };
    let mut definitions = HashMap::new();
    collect_definitions(&tree, &mut definitions);
    let mut replacements = Vec::new();
    collect_replacements(&tree, &definitions, &mut replacements);
    replacements.sort_by_key(|(start, _, _)| *start);
    let mut result = String::with_capacity(source.len());
    let mut offset = 0;
    for (start, end, replacement) in replacements {
        result.push_str(&source[offset..start]);
        result.push_str(&replacement);
        offset = end;
    }
    result.push_str(&source[offset..]);
    result
}

fn parse_options() -> ParseOptions {
    // gpui-base 0.6.6 text/markdown_ext.rs::parse_options defaults.
    let mut options = ParseOptions::gfm();
    options.constructs.math_text = true;
    options.constructs.math_flow = true;
    options
}

fn collect_definitions<'a>(node: &'a Node, definitions: &mut HashMap<&'a str, &'a str>) {
    if let Node::Definition(definition) = node {
        definitions
            .entry(&definition.identifier)
            .or_insert(&definition.url);
    }
    if let Some(children) = node.children() {
        for child in children {
            collect_definitions(child, definitions);
        }
    }
}

fn collect_replacements(
    node: &Node,
    definitions: &HashMap<&str, &str>,
    replacements: &mut Vec<(usize, usize, String)>,
) {
    let replacement = match node {
        Node::Image(image) => Some(image_link(&image.alt, &image.url)),
        Node::ImageReference(image) => Some(
            definitions
                .get(image.identifier.as_str())
                .map(|url| image_link(&image.alt, url))
                .unwrap_or_else(|| literal_text(&image.alt)),
        ),
        // Raw HTML is a separate GPUI image-producing route, including img
        // nested inside block HTML. Present it literally rather than parse it.
        Node::Html(html) => Some(literal_text(&html.value)),
        _ => None,
    };
    if let Some(replacement) = replacement {
        if let Some(position) = node.position() {
            replacements.push((position.start.offset, position.end.offset, replacement));
        }
    } else if let Some(children) = node.children() {
        for child in children {
            collect_replacements(child, definitions, replacements);
        }
    }
}

fn literal_text(source: &str) -> String {
    let mut escaped = String::with_capacity(source.len());
    for character in source.chars() {
        if character.is_ascii_punctuation() {
            escaped.push('\\');
        }
        escaped.push(character);
    }
    escaped
}

fn image_link(alt: &str, url: &str) -> String {
    let label = if alt.is_empty() { "Image" } else { alt };
    let mut destination = String::with_capacity(url.len());
    for character in url.chars() {
        if character.is_ascii_control() || matches!(character, '<' | '>' | '\\') {
            use std::fmt::Write;
            let _ = write!(destination, "%{:02X}", character as u32);
        } else {
            destination.push(character);
        }
    }
    format!("↗ [{}](<{destination}>)", literal_text(label))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image_routes(node: &Node) -> usize {
        usize::from(matches!(
            node,
            Node::Image(_) | Node::ImageReference(_) | Node::Html(_)
        )) + node
            .children()
            .map(|children| children.iter().map(image_routes).sum::<usize>())
            .unwrap_or_default()
    }

    #[test]
    fn parser_rejects_every_image_route_without_misreading_code_fences() {
        let cases = [
            "    ```\n![x](http://127.0.0.1/path)",
            "```md\n![literal](https://example.test/image)\n~~~\n```\n![outside](https://example.test/outside)",
            "````md\n```\n![literal](https://example.test/image)\n````\n![outside](https://example.test/outside)",
            "![photo](https://example.test/image.png)",
            "!![photo](https://example.test/image.png)",
            "!![reference][image]\n\n[image]: https://example.test/image.png",
            "![reference][image]\n\n[image]: https://example.test/image.png",
            "![shortcut]\n\n[shortcut]: https://example.test/image.png",
            "![![nested](https://example.test/inner)](https://example.test/outer)",
            "![<img src=\"https://example.test/inner\">](https://example.test/outer)",
            "<ImG src=\"https://example.test/image.png\">",
            "<div>\n<img src=\"https://example.test/image.png\">\n![inside HTML](https://example.test/other)\n</div>",
            "> ![quoted](https://example.test/image.png)\n\n- ![list](https://example.test/list)",
            "| Image |\n| --- |\n| ![table](https://example.test/image.png) |",
        ];
        for source in cases {
            let safe = unloaded_images(source);
            let parsed = markdown::to_mdast(&safe, &parse_options()).unwrap();
            assert_eq!(
                image_routes(&parsed),
                0,
                "unsafe image route after projection: {source:?}"
            );
        }
        let code = "```md\n![literal](https://example.test/image)\n```\n\n    ![indented](https://example.test/other)\n\n`![inline](https://example.test/inline)`";
        assert_eq!(unloaded_images(code), code);
        assert_eq!(
            unloaded_images("![Photo](https://example.test/image.png)"),
            "↗ [Photo](<https://example.test/image.png>)"
        );
    }
}
