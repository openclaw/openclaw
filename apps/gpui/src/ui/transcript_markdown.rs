use super::super::{
    AppView,
    components::transcript_markdown::{
        CodeBlock, ImageBlock, TableBlock, render_code, render_image, render_table,
    },
    theme::{Palette, tokens::transcript::MarkdownTokens as M},
};
use crate::model::markdown::{
    fenced_code, image_destination, parse_json_tree, should_collapse_user, table_cell_source,
};
use gpui_kit::{
    component::{
        Icon, IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::{
            InlineElement, MarkdownExtensions, MarkdownNode, MarkdownParseContext, MarkdownPlugin,
            TextView, TextViewStyle,
        },
    },
    prelude::FluentBuilder,
    *,
};
use markdown::mdast::Node;
use std::sync::{Arc, OnceLock};

pub(in crate::ui) fn transcript_text_style(_p: Palette) -> TextViewStyle {
    TextViewStyle::default()
        .paragraph_gap(rems(M::PARAGRAPH_REM))
        .heading_font_size(|level, base| {
            base * crate::ui::theme::tokens::conversation::heading_scale(level)
        })
}

fn build_extensions(user: bool, owner: Option<WeakEntity<AppView>>) -> MarkdownExtensions {
    let parser_owner = owner.clone();
    let quote_owner = owner.clone();
    let quote_extensions = Arc::new(OnceLock::new());
    let task_extensions = Arc::new(OnceLock::new());
    MarkdownExtensions::default()
        .parser_revision(u64::from(user))
        .plugin(MarkdownImages {
            owner: owner.clone(),
        })
        .block_parser(move |node, parse| parse_block(node, parse, user, parser_owner.clone()))
        .block_renderer("transcript-code", render_code)
        .block_renderer("transcript-user-code", |node, _, cx| {
            let style = TextViewStyle::default().code_block(
                StyleRefinement::default()
                    .p_0()
                    .border_0()
                    .rounded_none()
                    .bg(transparent_black())
                    .font_family(gpui_kit::component::Theme::global(cx).font_family.clone())
                    .text_size(px(M::BODY))
                    .line_height(px(M::LINE)),
            );
            TextView::markdown("user-code", fenced_code("", node.as_text()))
                .style(style)
                .selectable(true)
                .scrollable(false)
        })
        .block_renderer("transcript-table", render_table)
        .block_renderer("transcript-image", |node, _, cx| {
            let p = Palette::get(cx);
            div()
                .id((
                    "markdown-image",
                    node.source_range().map_or(0, |range| range.start),
                ))
                .text_color(p.muted)
                .bg(p.hover)
                .rounded(px(M::IMAGE_RADIUS))
                .when_some(node.data::<ImageBlock>(), |this, image| {
                    this.child(render_image(image, cx))
                })
        })
        .block_renderer("transcript-quote", move |node, _, cx| {
            let p = Palette::get(cx);
            div()
                .id((
                    "markdown-quote",
                    node.source_range().map_or(0, |range| range.start),
                ))
                .w_full()
                .relative()
                .py(px(M::QUOTE_PAD_Y))
                .px(px(M::QUOTE_PAD_X))
                .text_color(p.muted)
                .child(
                    div()
                        .absolute()
                        .top(px(M::QUOTE_INSET))
                        .bottom(px(M::QUOTE_INSET))
                        .left_0()
                        .w(px(M::QUOTE_BAR))
                        .rounded(px(M::SMALL_RADIUS))
                        .bg(p.border_strong),
                )
                .child(
                    TextView::markdown("quote", node.as_markdown().to_owned())
                        .text_color(p.muted)
                        .style(transcript_text_style(p))
                        .markdown_extensions(
                            quote_extensions
                                .get_or_init(|| build_extensions(user, quote_owner.clone()))
                                .clone(),
                        )
                        .selectable(true)
                        .scrollable(false),
                )
        })
        .block_renderer("transcript-tasks", move |node, _, cx| {
            let p = Palette::get(cx);
            let tasks = node
                .data::<Vec<(bool, String)>>()
                .cloned()
                .unwrap_or_default();
            div()
                .id((
                    "markdown-tasks",
                    node.source_range().map_or(0, |range| range.start),
                ))
                .v_flex()
                .gap(px(M::LIST_GAP))
                .children(
                    tasks
                        .into_iter()
                        .enumerate()
                        .map(|(index, (checked, text))| {
                            div()
                                .h_flex()
                                .items_start()
                                .gap(px(M::TASK_GAP))
                                .child(
                                    div()
                                        .size(px(M::TASK))
                                        .mt(px((M::LINE - M::TASK) / 2.))
                                        .flex_none()
                                        .border_1()
                                        .border_color(if checked {
                                            p.border.blend(Hsla {
                                                a: M::TASK_ACCENT_ALPHA,
                                                ..p.accent
                                            })
                                        } else {
                                            p.border_strong
                                        })
                                        .rounded(px(M::TASK_RADIUS))
                                        .bg(if checked {
                                            p.bg.blend(Hsla {
                                                a: M::TASK_ACCENT_ALPHA,
                                                ..p.accent
                                            })
                                        } else {
                                            p.bg
                                        })
                                        .when(checked, |this| {
                                            this.child(
                                                Icon::new(IconName::Check)
                                                    .size(px(M::ICON))
                                                    .text_color(p.accent_fg),
                                            )
                                        }),
                                )
                                .child(
                                    div().flex_1().min_w_0().text_color(p.muted).child(
                                        TextView::markdown(("task", index), text)
                                            .style(transcript_text_style(p))
                                            .markdown_extensions(
                                                task_extensions
                                                    .get_or_init(|| {
                                                        build_extensions(user, owner.clone())
                                                    })
                                                    .clone(),
                                            )
                                            .selectable(true)
                                            .scrollable(false),
                                    ),
                                )
                        }),
                )
        })
}

fn parse_block(
    node: &Node,
    parse: &MarkdownParseContext<'_>,
    user: bool,
    owner: Option<WeakEntity<AppView>>,
) -> Option<MarkdownNode> {
    match node {
        Node::Code(code) if user => {
            Some(MarkdownNode::new("transcript-user-code", ()).text(code.value.clone()))
        }
        Node::Code(code) => {
            let language = code.lang.clone().unwrap_or_default().to_lowercase();
            let json = if language.is_empty() || language == "json" {
                parse_json_tree(&code.value)
            } else {
                None
            };
            Some(
                MarkdownNode::new(
                    "transcript-code",
                    CodeBlock {
                        language: language.clone(),
                        code: code.value.clone(),
                        json,
                        owner,
                    },
                )
                .text(code.value.clone())
                .markdown(fenced_code(&language, &code.value)),
            )
        }
        Node::Table(table) => {
            let cells: Vec<Vec<String>> = table
                .children
                .iter()
                .map(|row| {
                    row.children()
                        .into_iter()
                        .flatten()
                        .map(|cell| table_cell_source(cell, parse.source()))
                        .collect()
                })
                .collect();
            let plain = table
                .children
                .iter()
                .map(|row| {
                    row.children()
                        .into_iter()
                        .flatten()
                        .map(plain_text)
                        .collect()
                })
                .collect();
            Some(
                MarkdownNode::new(
                    "transcript-table",
                    TableBlock {
                        cells,
                        plain,
                        extensions: build_extensions(user, owner),
                    },
                )
                .markdown(parse.node_source(node).unwrap_or_default().to_owned()),
            )
        }
        Node::Paragraph(paragraph) if paragraph.children.len() == 1 => match &paragraph.children[0]
        {
            Node::Link(link) => image_destination(&link.url).map(|url| {
                let label = plain_text(&paragraph.children[0]);
                MarkdownNode::new("transcript-image", image_block(&label, &url, owner.clone()))
                    .text(label)
            }),
            _ => None,
        },
        Node::Blockquote(_) => {
            let source = parse.node_source(node).unwrap_or_default();
            let text = source
                .lines()
                .map(|line| {
                    let line = line.trim_start();
                    line.strip_prefix('>')
                        .unwrap_or(line)
                        .strip_prefix(' ')
                        .unwrap_or_else(|| line.strip_prefix('>').unwrap_or(line))
                })
                .collect::<Vec<_>>()
                .join("\n");
            Some(MarkdownNode::new("transcript-quote", ()).markdown(text))
        }
        Node::List(list)
            if list
                .children
                .iter()
                .all(|item| matches!(item,Node::ListItem(item) if item.checked.is_some())) =>
        {
            let tasks = list
                .children
                .iter()
                .filter_map(|item| {
                    let Node::ListItem(item) = item else {
                        return None;
                    };
                    let text = item
                        .children
                        .iter()
                        .map(|child| parse.node_source(child).unwrap_or_default())
                        .collect::<Vec<_>>()
                        .join("\n\n");
                    Some((item.checked.unwrap_or(false), text))
                })
                .collect::<Vec<_>>();
            Some(
                MarkdownNode::new("transcript-tasks", tasks)
                    .markdown(parse.node_source(node).unwrap_or_default().to_owned()),
            )
        }
        _ => None,
    }
}

fn plain_text(node: &Node) -> String {
    match node {
        Node::Text(text) => text.value.clone(),
        Node::InlineCode(code) => code.value.clone(),
        Node::Image(image) => image.alt.clone(),
        Node::Break(_) => "\n".into(),
        _ => node
            .children()
            .into_iter()
            .flatten()
            .map(plain_text)
            .collect(),
    }
}

struct MarkdownImages {
    owner: Option<WeakEntity<AppView>>,
}
impl MarkdownPlugin for MarkdownImages {
    fn name(&self) -> &str {
        "transcript-inline-image"
    }
    fn parse(&self, node: &Node, _: &MarkdownParseContext<'_>) -> Option<MarkdownNode> {
        let Node::Link(link) = node else {
            return None;
        };
        let url = image_destination(&link.url)?;
        let label = plain_text(node);
        Some(
            MarkdownNode::new(self.name(), image_block(&label, &url, self.owner.clone()))
                .text(label),
        )
    }
    fn render(&self, node: &MarkdownNode, _: &mut Window, cx: &mut App) -> impl IntoElement {
        node.data::<ImageBlock>()
            .map(|image| render_image(image, cx))
            .unwrap_or_else(|| div().into_any_element())
    }
    fn render_inline(
        &self,
        node: &MarkdownNode,
        _: &gpui_kit::component::text::InlineRenderContext,
        window: &mut Window,
        cx: &mut App,
    ) -> Option<InlineElement> {
        Some(InlineElement::new(self.render(node, window, cx)))
    }
}
fn image_block(label: &str, url: &str, owner: Option<WeakEntity<AppView>>) -> ImageBlock {
    ImageBlock {
        label: label.to_owned(),
        url: url.to_owned(),
        inline: crate::ui::transcript_media::InlineImage::from_data_url(url),
        owner,
    }
}

impl AppView {
    pub(in crate::ui) fn render_message_markdown(
        &mut self,
        key: String,
        index: usize,
        source: &str,
        user: bool,
        streaming: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let state = self.markdown_state(key.clone(), source, cx);
        let owner = cx.entity().downgrade();
        let cached = self
            .transcript_state
            .markdown
            .get_mut(&key)
            .expect("prepared Markdown");
        if cached
            .extensions
            .as_ref()
            .is_none_or(|(role, _)| *role != user)
        {
            cached.extensions = Some((user, build_extensions(user, Some(owner))));
        }
        let markdown_extensions = cached
            .extensions
            .as_ref()
            .expect("prepared extensions")
            .1
            .clone();
        let link_view = cx.entity().downgrade();
        let mut style = transcript_text_style(p);
        style.highlight_theme = M::syntax(gpui_kit::component::Theme::global(cx).is_dark());
        style.code_block = StyleRefinement::default()
            .bg(p.sidebar)
            .border_1()
            .border_color(p.border_strong)
            .rounded(px(M::RADIUS))
            .p(px(M::CODE_PAD))
            .text_size(px(M::CODE_TEXT))
            .line_height(px(M::CODE_LINE));
        let text = TextView::new(&state)
            .style(style)
            .markdown_extensions(markdown_extensions)
            .selectable(true)
            .scrollable(false)
            .stream_fade(streaming)
            .on_link_click(move |url, _, _, cx| {
                let _ = link_view.update(cx, |this, cx| this.open_transcript_link(url, cx));
            });
        if !user || !should_collapse_user(source) {
            return text.into_any_element();
        }
        let disclosure_key = format!("{key}:user-disclosure");
        let expanded = self.transcript_state.expanded.contains(&disclosure_key);
        div()
            .w_full()
            .min_w_0()
            .v_flex()
            .child(
                div()
                    .w_full()
                    .overflow_hidden()
                    .when(!expanded, |this| this.max_h(px(M::USER_PREVIEW)))
                    .child(text),
            )
            .child(
                Button::new(SharedString::from(disclosure_key.clone()))
                    .ghost()
                    .small()
                    .self_start()
                    .justify_start()
                    .px_0()
                    .mt(px(M::DISCLOSURE_GAP))
                    .relative()
                    .top(px(M::DISCLOSURE_OFFSET))
                    .h(px(M::DISCLOSURE_HEIGHT))
                    .text_size(px(M::DISCLOSURE_TEXT))
                    .line_height(px(M::DISCLOSURE_TEXT))
                    .text_color(p.muted)
                    .label(if expanded { "Show less" } else { "Show more" })
                    .child(
                        Icon::new(if expanded {
                            IconName::ChevronUp
                        } else {
                            IconName::ChevronDown
                        })
                        .size(px(M::ICON)),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.transcript_state.expanded.remove(&disclosure_key) {
                            this.transcript_state
                                .expanded
                                .insert(disclosure_key.clone());
                        }
                        this.transcript_list.remeasure_items(index..index + 1);
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::image_block;

    #[test]
    fn oversized_inline_markdown_image_never_reaches_the_renderer() {
        let source =
            "data:image/gif;base64,R0lGODlhEScQJ4AAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        let inline = image_block("Oversized synthetic image", source, None)
            .inline
            .unwrap()
            .unwrap();
        assert!(
            inline.thumbnail().is_err(),
            "oversized canvas must not reach GPUI"
        );
        // Identical GIF data with a 1×1 logical canvas proves this is dimension
        // admission, rather than rejection of unsupported or malformed image data.
        let small_gif = image_block(
            "Synthetic pixel",
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
            None,
        )
        .inline
        .unwrap()
        .unwrap();
        assert!(
            small_gif
                .thumbnail()
                .unwrap()
                .starts_with(b"\x89PNG\r\n\x1a\n")
        );
        let normal = image_block("Synthetic pixel", "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV2kAAAAASUVORK5CYII=", None).inline.unwrap().unwrap();
        assert!(
            normal
                .thumbnail()
                .unwrap()
                .starts_with(b"\x89PNG\r\n\x1a\n")
        );
    }
}
