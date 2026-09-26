use crate::model::markdown::{JsonTree, fenced_code};
use crate::ui::theme::{MarkdownTokens as M, Palette};
use gpui_kit::{
    component::{
        IconName, Selectable, Sizable, StyledExt, Theme, WindowExt,
        button::{Button, ButtonVariants},
        text::{MarkdownNode, TextView, TextViewStyle},
    },
    prelude::FluentBuilder,
    *,
};
use std::{collections::HashSet, sync::Arc, time::Duration};

#[derive(Clone)]
pub(crate) struct CodeBlock {
    pub language: String,
    pub code: String,
    pub json: Option<JsonTree>,
    pub owner: Option<WeakEntity<crate::ui::AppView>>,
}

#[derive(Default)]
struct CodeState {
    expanded: bool,
    wrapped: bool,
    raw: bool,
    closed_json: HashSet<String>,
}

#[derive(Default)]
struct CopyState {
    result: Option<bool>,
    attempt: u64,
    source: String,
}

fn copy_button(
    id: &'static str,
    offset: usize,
    label: &'static str,
    source: String,
    window: &mut Window,
    cx: &mut App,
) -> Button {
    let state = window.use_keyed_state((id, offset), cx, |_, _| CopyState::default());
    state.update(cx, |state, _| {
        if state.source != source {
            state.source = source.clone();
            state.result = None;
            state.attempt += 1;
        }
    });
    let result = state.read(cx).result;
    Button::new(id)
        .ghost()
        .small()
        .size(px(M::CONTROL))
        .icon(if result == Some(true) {
            IconName::Check
        } else {
            IconName::Copy
        })
        .accessibility_label(match result {
            Some(true) => "Copied",
            Some(false) => "Copy failed",
            None => label,
        })
        .tooltip(match result {
            Some(true) => "Copied",
            Some(false) => "Copy failed",
            None => label,
        })
        .on_click(move |_, window, cx| {
            cx.write_to_clipboard(ClipboardItem::new_string(source.clone()));
            let copied = cx
                .read_from_clipboard()
                .and_then(|item| item.text())
                .as_deref()
                == Some(source.as_str());
            let attempt = state.update(cx, |state, cx| {
                state.attempt += 1;
                state.result = Some(copied);
                cx.notify();
                state.attempt
            });
            window.refresh();
            let state = state.downgrade();
            cx.spawn(async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(if copied { 1500 } else { 2000 }))
                    .await;
                let _ = state.update(cx, |state, cx| {
                    if state.attempt == attempt {
                        state.result = None;
                        cx.notify();
                        cx.refresh_windows();
                    }
                });
            })
            .detach();
        })
}

fn code_style(cx: &App, wrapped: bool) -> TextViewStyle {
    let mut code = StyleRefinement::default()
        .bg(transparent_black())
        .rounded_none()
        .px(px(M::CODE_PAD))
        .pt(px(M::SMALL_RADIUS))
        .pb(px(M::CODE_PAD))
        .text_size(px(M::CODE_TEXT))
        .line_height(px(M::CODE_LINE));
    if !wrapped {
        code = code.whitespace_nowrap();
    }
    let mut style = TextViewStyle::default().code_block(code);
    style.highlight_theme = M::syntax(Theme::global(cx).is_dark());
    style
}

pub(crate) fn render_code(node: &MarkdownNode, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(block) = node.data::<CodeBlock>() else {
        return div().into_any_element();
    };
    let p = Palette::get(cx);
    let offset = node.source_range().map_or(0, |range| range.start);
    let state = window.use_keyed_state(("transcript-code-state", offset), cx, |_, _| {
        CodeState::default()
    });
    let resize = block.owner.clone();
    let data = state.read(cx);
    let expanded = data.expanded;
    let wrapped = data.wrapped;
    let raw = data.raw;
    let hidden = if matches!(block.language.as_str(), "text" | "md" | "markdown") {
        0
    } else {
        block.code.lines().count().saturating_sub(7)
    };
    let code = if hidden > 0 && !expanded {
        block.code.lines().take(7).collect::<Vec<_>>().join("\n")
    } else {
        block.code.clone()
    };
    let mut actions = div().h_flex().gap_1();
    if block.json.is_some() {
        for (name, is_raw) in [("Tree", false), ("Raw", true)] {
            let state = state.clone();
            let resize = resize.clone();
            actions = actions.child(
                Button::new(name)
                    .ghost()
                    .small()
                    .label(name)
                    .selected(raw == is_raw)
                    .on_click(move |_, window, cx| {
                        state.update(cx, |state, cx| {
                            state.raw = is_raw;
                            cx.notify();
                        });
                        remeasure(&resize, cx);
                        window.refresh();
                    }),
            );
        }
    }
    if hidden == 0 || expanded {
        let state = state.clone();
        let resize = resize.clone();
        actions = actions.child(
            Button::new("wrap-code")
                .ghost()
                .small()
                .icon(wrap_icon())
                .accessibility_label(if wrapped {
                    "Disable wrapping"
                } else {
                    "Enable wrapping"
                })
                .selected(wrapped)
                .tooltip(if wrapped {
                    "Disable wrapping"
                } else {
                    "Enable wrapping"
                })
                .on_click(move |_, window, cx| {
                    state.update(cx, |state, cx| {
                        state.wrapped = !state.wrapped;
                        cx.notify();
                    });
                    remeasure(&resize, cx);
                    window.refresh();
                }),
        );
    }
    actions = actions.child(copy_button(
        "copy-code",
        offset,
        "Copy code",
        block.code.clone(),
        window,
        cx,
    ));
    let mut frame = div()
        .id(("transcript-code", offset))
        .w_full()
        .min_w_0()
        .rounded(px(M::RADIUS))
        .border_1()
        .border_color(Hsla {
            a: M::CODE_BORDER_ALPHA,
            ..p.text
        })
        .overflow_hidden()
        .child(
            div()
                .h_flex()
                .justify_between()
                .min_h(px(M::CODE_HEADER))
                .pl(px(M::CODE_PAD))
                .pr(px(M::GAP))
                .pt(px(M::GAP))
                .pb(px(M::SMALL_RADIUS))
                .text_size(px(M::CODE_LABEL))
                .line_height(px(M::CODE_LABEL))
                .text_color(p.muted)
                .child(
                    div()
                        .font_family("monospace")
                        .child(if block.language.is_empty() {
                            "text".to_owned()
                        } else {
                            block.language.clone()
                        }),
                )
                .child(actions),
        );
    if let Some(json) = &block.json
        && !raw
    {
        frame = frame.child(
            div()
                .px(px(M::CODE_PAD))
                .pb(px(M::CODE_PAD))
                .font_family("monospace")
                .text_size(px(M::CODE_TEXT))
                .line_height(px(M::CODE_LINE))
                .child(render_json(
                    json,
                    "root".to_owned(),
                    None,
                    0,
                    &state,
                    &resize,
                    cx,
                )),
        );
    } else {
        frame = frame.child(
            div()
                .id("code-viewport")
                .w_full()
                .min_w_0()
                .overflow_x_scroll()
                .child(
                    TextView::markdown("code-body", fenced_code(&block.language, &code))
                        .style(code_style(cx, wrapped))
                        .selectable(true)
                        .scrollable(false),
                ),
        );
        if hidden > 0 && !expanded {
            let state = state.clone();
            let resize = resize.clone();
            frame = frame.child(
                Button::new("expand-code")
                    .ghost()
                    .small()
                    .icon(IconName::ChevronDown)
                    .label(format!(
                        "{hidden} hidden {}",
                        if hidden == 1 { "line" } else { "lines" }
                    ))
                    .on_click(move |_, window, cx| {
                        state.update(cx, |state, cx| {
                            state.expanded = true;
                            cx.notify();
                        });
                        remeasure(&resize, cx);
                        window.refresh();
                    }),
            );
        }
    }
    frame.into_any_element()
}

fn render_json(
    value: &JsonTree,
    path: String,
    label: Option<&str>,
    depth: usize,
    state: &Entity<CodeState>,
    resize: &Option<WeakEntity<crate::ui::AppView>>,
    cx: &App,
) -> AnyElement {
    let p = Palette::get(cx);
    let children: Vec<(String, &JsonTree)> = match value {
        JsonTree::Object(map) => map
            .iter()
            .map(|(key, value)| (key.clone(), value))
            .collect(),
        JsonTree::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value))
            .collect(),
        _ => Vec::new(),
    };
    let label = label
        .map(|label| format!("{label:?}: "))
        .unwrap_or_default();
    if children.is_empty() {
        let text = match value {
            JsonTree::Scalar(value) => value.to_string(),
            JsonTree::Object(_) => "{}".to_owned(),
            JsonTree::Array(_) => "[]".to_owned(),
        };
        return div()
            .text_color(p.text)
            .child(format!("{label}{text}"))
            .into_any_element();
    }
    let closed = state.read(cx).closed_json.contains(&path) != (depth >= 2);
    let array = matches!(value, JsonTree::Array(_));
    let summary = format!(
        "{label}{} {} {}",
        if array { "[" } else { "{" },
        children.len(),
        if array { "items" } else { "keys" }
    );
    let toggle = state.clone();
    let toggle_path = path.clone();
    let toggle_resize = resize.clone();
    let mut result = div().v_flex().child(
        Button::new(SharedString::from(path.clone()))
            .ghost()
            .small()
            .icon(if closed {
                IconName::ChevronRight
            } else {
                IconName::ChevronDown
            })
            .label(summary)
            .on_click(move |_, window, cx| {
                toggle.update(cx, |state, cx| {
                    if !state.closed_json.remove(&toggle_path) {
                        state.closed_json.insert(toggle_path.clone());
                    }
                    cx.notify();
                });
                remeasure(&toggle_resize, cx);
                window.refresh();
            }),
    );
    if !closed {
        result = result
            .child(
                div()
                    .pl(px(M::CODE_PAD))
                    .children(
                        children
                            .into_iter()
                            .enumerate()
                            .map(|(index, (key, value))| {
                                render_json(
                                    value,
                                    format!("{path}/{index}"),
                                    (!array).then_some(key.as_str()),
                                    depth + 1,
                                    state,
                                    resize,
                                    cx,
                                )
                            }),
                    ),
            )
            .child(if array { "]" } else { "}" });
    }
    result.into_any_element()
}

#[derive(Clone)]
pub(crate) struct TableBlock {
    pub cells: Vec<Vec<String>>,
    pub plain: Vec<Vec<String>>,
    pub align: Vec<markdown::mdast::AlignKind>,
}

pub(crate) fn render_table(node: &MarkdownNode, window: &mut Window, cx: &mut App) -> AnyElement {
    let Some(table) = node.data::<TableBlock>() else {
        return div().into_any_element();
    };
    let p = Palette::get(cx);
    let offset = node.source_range().map_or(0, |range| range.start);
    let copy = table
        .plain
        .iter()
        .map(|row| row.join("\t"))
        .collect::<Vec<_>>()
        .join("\n");
    let expanded = table.clone();
    let focus = window
        .use_keyed_state(("table-controls-focus", offset), cx, |_, cx| {
            cx.focus_handle()
        })
        .read(cx)
        .clone();
    div()
        .id(("transcript-table", offset))
        .group("transcript-table")
        .relative()
        .w_full()
        .min_w_0()
        .child(table_body(table, cx))
        .child(
            div()
                .id("table-controls")
                .track_focus(&focus)
                .absolute()
                .right_0()
                .top_0()
                .h_flex()
                .bg(p.bg)
                .opacity(0.)
                .in_focus(|this| this.opacity(1.))
                .group_hover("transcript-table", |this| this.opacity(1.))
                .child(
                    Button::new("expand-table")
                        .ghost()
                        .small()
                        .icon(IconName::Maximize)
                        .label("Expand table")
                        .on_click(move |_, window, cx| {
                            let table = expanded.clone();
                            window.open_dialog(cx, move |dialog, _, cx| {
                                dialog.title("Expanded table").w(px(M::DIALOG_WIDTH)).child(
                                    div()
                                        .id("expanded-table-scroll")
                                        .max_h(px(M::DIALOG_HEIGHT))
                                        .overflow_scroll()
                                        .child(table_body(&table, cx)),
                                )
                            });
                        }),
                )
                .child(copy_button(
                    "copy-table",
                    offset,
                    "Copy table",
                    copy,
                    window,
                    cx,
                )),
        )
        .into_any_element()
}

fn table_body(table: &TableBlock, cx: &App) -> AnyElement {
    let p = Palette::get(cx);
    let columns = table.cells.first().map_or(1, Vec::len).max(1);
    div()
        .w_full()
        .min_w_0()
        .text_size(px(M::TABLE_TEXT))
        .children(table.cells.iter().enumerate().map(|(row, cells)| {
            div()
                .flex()
                .w_full()
                .items_start()
                .border_b_1()
                .border_color(if row == 0 {
                    p.border_strong
                } else {
                    Hsla {
                        a: M::TABLE_BORDER_ALPHA,
                        ..p.border
                    }
                })
                .children(cells.iter().enumerate().map(|(column, cell)| {
                    div()
                        .w(relative(1. / columns as f32))
                        .min_w_0()
                        .px(px(M::CELL_PAD))
                        .py(px(M::CELL_PAD))
                        .when(column == 0, |this| this.pl_0())
                        .when(row == 0, |this| {
                            this.font_weight(FontWeight::SEMIBOLD).text_color(p.strong)
                        })
                        .when(row > 0 && column == 0, |this| {
                            this.font_weight(FontWeight::MEDIUM).text_color(p.strong)
                        })
                        .when(
                            table.align.get(column) == Some(&markdown::mdast::AlignKind::Right),
                            |this| this.text_right(),
                        )
                        .when(
                            table.align.get(column) == Some(&markdown::mdast::AlignKind::Center),
                            |this| this.text_center(),
                        )
                        .child(
                            TextView::markdown(("cell", row * columns + column), cell.clone())
                                .markdown_extensions(
                                    crate::ui::transcript_state::code_markdown_extensions(),
                                )
                                .selectable(true)
                                .scrollable(false),
                        )
                }))
        }))
        .into_any_element()
}

#[derive(Clone)]
pub(crate) struct ImageBlock {
    pub label: String,
    pub url: String,
    pub image: Option<Arc<Image>>,
}

pub(crate) fn render_image(image: &ImageBlock) -> AnyElement {
    let p_label = image.label.clone();
    if let Some(image) = &image.image {
        return div()
            .w_full()
            .max_h(px(M::IMAGE_MAX_HEIGHT))
            .overflow_hidden()
            .child(
                img(image.clone())
                    .max_w_full()
                    .max_h(px(M::IMAGE_MAX_HEIGHT))
                    .object_fit(ObjectFit::Contain),
            )
            .into_any_element();
    }
    // URL routing is explicit and user initiated; this component never requests it.
    let target = url::Url::parse(&image.url)
        .ok()
        .filter(|url| matches!(url.scheme(), "https" | "http"));
    div()
        .w_full()
        .h_flex()
        .justify_between()
        .flex_wrap()
        .gap(px(M::GAP))
        .px(px(M::IMAGE_PAD_X))
        .py(px(M::IMAGE_PAD_Y))
        .rounded(px(M::RADIUS))
        .child(format!(
            "External image not loaded{}",
            if p_label.is_empty() {
                String::new()
            } else {
                format!(": {p_label}")
            }
        ))
        .when_some(target, |this, target| {
            this.child(
                Button::new("open-image")
                    .small()
                    .label("Open image")
                    .on_click(move |_, _, cx| cx.open_url(target.as_str())),
            )
        })
        .into_any_element()
}

fn remeasure(owner: &Option<WeakEntity<crate::ui::AppView>>, cx: &mut App) {
    if let Some(owner) = owner {
        let _ = owner.update(cx, |view, cx| {
            view.transcript_list.remeasure();
            cx.notify();
        });
    }
}

fn wrap_icon() -> gpui_kit::component::Icon {
    gpui_kit::component::Icon::default().data(br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-4m2-2-2 2 2 2M3 18h7"/></svg>"#)
}
