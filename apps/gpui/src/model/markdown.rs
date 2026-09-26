use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use markdown::{ParseOptions, mdast::Node};
use std::collections::HashMap;

pub const IMAGE_MARKER: &str = "openclaw-markdown-image:";
pub fn image_destination(marker: &str) -> Option<String> {
    String::from_utf8(
        URL_SAFE_NO_PAD
            .decode(marker.strip_prefix(IMAGE_MARKER)?)
            .ok()?,
    )
    .ok()
}
fn image_link(alt: &str, url: &str) -> String {
    format!(
        "[{}](<{IMAGE_MARKER}{}>)",
        literal_text(alt),
        URL_SAFE_NO_PAD.encode(url)
    )
}
pub fn parse_options() -> ParseOptions {
    let mut options = ParseOptions::gfm();
    options.constructs.math_text = true;
    options.constructs.math_flow = true;
    options
}

/// Keep resource decisions in the transcript, never the renderer's implicit URL loader.
/// Raw HTML stays literal, matching the web transcript; only a plain br tag is admitted.
pub fn transcript_source(source: &str) -> String {
    let Ok(tree) = markdown::to_mdast(source, &parse_options()) else {
        return literal_text(source);
    };
    let mut definitions = HashMap::new();
    collect_definitions(&tree, &mut definitions);
    let mut replacements = Vec::new();
    collect_replacements(&tree, source, &definitions, &mut replacements);
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

fn collect_definitions<'a>(node: &'a Node, definitions: &mut HashMap<&'a str, &'a str>) {
    if let Node::Definition(definition) = node {
        definitions
            .entry(&definition.identifier)
            .or_insert(&definition.url);
    }
    for child in node.children().into_iter().flatten() {
        collect_definitions(child, definitions);
    }
}

fn collect_replacements(
    node: &Node,
    source: &str,
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
        Node::Html(html) => Some(if is_line_break_tag(&html.value) {
            "<br>".to_owned()
        } else {
            literal_text(&html.value)
        }),
        // markdown-it's transcript uses breaks:true; CommonMark TextView reflows soft breaks.
        Node::Text(text) if text.value.contains('\n') => node
            .position()
            .map(|pos| source[pos.start.offset..pos.end.offset].replace('\n', "\\\n")),
        _ => None,
    };
    if let (Some(replacement), Some(position)) = (replacement, node.position()) {
        replacements.push((position.start.offset, position.end.offset, replacement));
    } else {
        for child in node.children().into_iter().flatten() {
            collect_replacements(child, source, definitions, replacements);
        }
    }
}

fn is_line_break_tag(source: &str) -> bool {
    let tag = source.trim().to_ascii_lowercase();
    tag.strip_prefix("<br")
        .and_then(|tag| tag.strip_suffix('>'))
        .is_some_and(|tail| matches!(tail.trim(), "" | "/"))
}

pub fn literal_text(source: &str) -> String {
    let mut result = String::with_capacity(source.len());
    for ch in source.chars() {
        if ch.is_ascii_punctuation() {
            result.push('\\');
        }
        result.push(ch);
    }
    result
}

/// mdast TableCell spans include the pipe delimiters; inline-child spans contain only authored content.
pub fn table_cell_source(cell: &Node, source: &str) -> String {
    let Some(children) = cell.children() else {
        return String::new();
    };
    let Some(start) = children
        .first()
        .and_then(Node::position)
        .map(|position| position.start.offset)
    else {
        return String::new();
    };
    let Some(end) = children
        .last()
        .and_then(Node::position)
        .map(|position| position.end.offset)
    else {
        return String::new();
    };
    let mut codes = Vec::new();
    fn collect_code(node: &Node, codes: &mut Vec<(usize, usize, String)>) {
        if let Node::InlineCode(code) = node {
            if let Some(position) = &code.position {
                let fence = "`".repeat(
                    code.value
                        .split(|ch| ch != '`')
                        .map(str::len)
                        .max()
                        .unwrap_or(0)
                        + 1,
                );
                let value = if code.value.chars().all(char::is_whitespace) {
                    code.value.clone()
                } else {
                    format!(" {} ", code.value)
                };
                codes.push((
                    position.start.offset,
                    position.end.offset,
                    format!("{fence}{value}{fence}"),
                ));
            }
        } else {
            for child in node.children().into_iter().flatten() {
                collect_code(child, codes);
            }
        }
    }
    collect_code(cell, &mut codes);
    let mut result = String::new();
    let mut offset = start;
    for (start, end, replacement) in codes {
        result.push_str(&source[offset..start]);
        result.push_str(&replacement);
        offset = end;
    }
    result.push_str(&source[offset..end]);
    result.trim().to_owned()
}

pub fn should_collapse_user(source: &str) -> bool {
    source.encode_utf16().count() > 1200 || source.split('\n').count() > 40
}

pub fn fenced_code(language: &str, source: &str) -> String {
    let longest = source
        .split(|ch| ch != '~')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let fence = "~".repeat(3.max(longest + 1));
    format!("{fence}{language}\n{source}\n{fence}")
}

/// Object members retain source order and duplicates, as the transcript's JSON tree does.
#[derive(Clone, Debug, PartialEq)]
pub enum JsonTree {
    Object(Vec<(String, JsonTree)>),
    Array(Vec<JsonTree>),
    Scalar(serde_json::Value),
}

impl<'de> serde::Deserialize<'de> for JsonTree {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = JsonTree;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON value")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<Self::Value, A::Error> {
                let mut members = Vec::new();
                while let Some(entry) = map.next_entry()? {
                    members.push(entry);
                }
                Ok(JsonTree::Object(members))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: A,
            ) -> Result<Self::Value, A::Error> {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element()? {
                    values.push(value);
                }
                Ok(JsonTree::Array(values))
            }
            fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Self::Value, E> {
                Ok(JsonTree::Scalar(value.into()))
            }
            fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Self::Value, E> {
                Ok(JsonTree::Scalar(value.into()))
            }
            fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Self::Value, E> {
                Ok(JsonTree::Scalar(value.into()))
            }
            fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|value| JsonTree::Scalar(serde_json::Value::Number(value)))
                    .ok_or_else(|| E::custom("non-finite JSON number"))
            }
            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Self::Value, E> {
                Ok(JsonTree::Scalar(value.into()))
            }
            fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Self::Value, E> {
                Ok(JsonTree::Scalar(value.into()))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(JsonTree::Scalar(serde_json::Value::Null))
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

pub fn parse_json_tree(source: &str) -> Option<JsonTree> {
    // Match the web tree's budget. Larger input still renders/copies as complete Raw code.
    if source.encode_utf16().count() > 20_000 {
        return None;
    }
    let tree: JsonTree = serde_json::from_str(source).ok()?;
    if matches!(tree, JsonTree::Scalar(_)) {
        return None;
    }
    let mut nodes = 0;
    fn admitted(tree: &JsonTree, depth: usize, nodes: &mut usize) -> bool {
        *nodes += 1;
        if depth > 64 || *nodes > 4_000 {
            return false;
        }
        match tree {
            JsonTree::Object(members) => members
                .iter()
                .all(|(_, value)| admitted(value, depth + 1, nodes)),
            JsonTree::Array(values) => values.iter().all(|value| admitted(value, depth + 1, nodes)),
            JsonTree::Scalar(_) => true,
        }
    }
    admitted(&tree, 0, &mut nodes).then_some(tree)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transcript_projection_preserves_prose_breaks_and_literal_html_and_code() {
        let source = "> first\n> second\n\n<b>bold</b> and <i>italic</i>\n\n```html\n<img src=\"https://example.test/a.png\">\n```";
        let projected = transcript_source(source);
        let tree = markdown::to_mdast(&projected, &parse_options()).unwrap();
        fn count(node: &Node, predicate: fn(&Node) -> bool) -> usize {
            usize::from(predicate(node))
                + node
                    .children()
                    .into_iter()
                    .flatten()
                    .map(|child| count(child, predicate))
                    .sum::<usize>()
        }
        assert_eq!(count(&tree, |node| matches!(node, Node::Break(_))), 1);
        assert_eq!(count(&tree, |node| matches!(node, Node::Strong(_))), 0);
        assert_eq!(count(&tree, |node| matches!(node, Node::Emphasis(_))), 0);
        assert!(projected.contains("```html\n<img src=\"https://example.test/a.png\">\n```"));
    }
    #[test]
    fn image_routes_never_enter_the_renderers_implicit_loader() {
        fn inspect(node: &Node) {
            assert!(!matches!(node, Node::Image(_) | Node::ImageReference(_)));
            if let Node::Html(html) = node {
                assert!(!html.value.to_ascii_lowercase().contains("img"));
            }
            for child in node.children().into_iter().flatten() {
                inspect(child);
            }
        }
        for source in [
            "![photo](https://example.test/image.png)",
            "![reference][image]\n\n[image]: https://example.test/image.png",
            "![shortcut]\n\n[shortcut]: https://example.test/image.png",
            "![![nested](https://example.test/inner)](https://example.test/outer)",
            "<ImG src=\"https://example.test/image.png\">",
            "<div>\n<img src=\"https://example.test/image.png\">\n![inside HTML](https://example.test/other)\n</div>",
            "> ![quoted](https://example.test/image.png)\n\n- ![list](https://example.test/list)",
            "| Image |\n| --- |\n| ![table](https://example.test/image.png) |",
        ] {
            inspect(&markdown::to_mdast(&transcript_source(source), &parse_options()).unwrap());
        }
        let source = "![photo][asset]\n\n[asset]: https://example.test/image.png";
        let tree = markdown::to_mdast(&transcript_source(source), &parse_options()).unwrap();
        let paragraph = &tree.children().unwrap()[0];
        let Node::Link(link) = &paragraph.children().unwrap()[0] else {
            panic!("inert link until admitted")
        };
        assert_eq!(
            image_destination(&link.url).as_deref(),
            Some("https://example.test/image.png")
        );
    }
    #[test]
    fn table_cells_omit_structural_pipes_and_keep_authored_inline_content() {
        let source = "| **Surface** | State | Result |\n| --- | :---: | ---: |\n| left \\| right | `a\\|b` | |";
        let tree = markdown::to_mdast(source, &parse_options()).unwrap();
        let table = &tree.children().unwrap()[0];
        let cells: Vec<Vec<String>> = table
            .children()
            .unwrap()
            .iter()
            .map(|row| {
                row.children()
                    .unwrap()
                    .iter()
                    .map(|cell| table_cell_source(cell, source))
                    .collect()
            })
            .collect();
        fn visible(node: &Node) -> String {
            match node {
                Node::Text(text) => text.value.clone(),
                Node::InlineCode(code) => code.value.clone(),
                _ => node.children().into_iter().flatten().map(visible).collect(),
            }
        }
        let rendered: Vec<Vec<String>> = cells
            .iter()
            .map(|row| {
                row.iter()
                    .map(|cell| visible(&markdown::to_mdast(cell, &parse_options()).unwrap()))
                    .collect()
            })
            .collect();
        assert_eq!(
            rendered,
            vec![
                vec!["Surface", "State", "Result"],
                vec!["left | right", "a|b", ""]
            ]
        );
    }
    #[test]
    fn json_tree_keeps_duplicate_members_and_original_order() {
        let tree = parse_json_tree(r#"{"z":1,"a":[{"same":true,"same":false}],"z":2}"#).unwrap();
        assert_eq!(
            tree,
            JsonTree::Object(vec![
                ("z".into(), JsonTree::Scalar(serde_json::json!(1))),
                (
                    "a".into(),
                    JsonTree::Array(vec![JsonTree::Object(vec![
                        ("same".into(), JsonTree::Scalar(serde_json::json!(true))),
                        ("same".into(), JsonTree::Scalar(serde_json::json!(false))),
                    ])])
                ),
                ("z".into(), JsonTree::Scalar(serde_json::json!(2))),
            ])
        );
    }
    #[test]
    fn fenced_tool_output_keeps_embedded_markdown_literal() {
        let output =
            "before\n```\n# not a heading\n![literal](https://example.invalid/image)\n~~~~~\nafter";
        let parsed = markdown::to_mdast(&fenced_code("text", output), &parse_options()).unwrap();
        let blocks = parsed.children().unwrap();
        assert_eq!(blocks.len(), 1);
        let Node::Code(code) = &blocks[0] else {
            panic!("literal code")
        };
        assert_eq!(code.value, output);
    }
}
