use crate::model::markdown::{JsonTree, fenced_code};
use crate::ui::theme::{MarkdownTokens as M, Palette};
use gpui_kit::{
    base::ElementExt,
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
    viewport_width: Pixels,
    measured_code: Option<(String, SharedString, Pixels)>,
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
    let mono = Theme::global(cx).mono_font_family.clone();
    if state
        .read(cx)
        .measured_code
        .as_ref()
        .is_none_or(|(source, family, _)| source != &block.code || family != &mono)
    {
        let width = text_width(&block.code, font(mono.clone()), px(M::CODE_TEXT), window);
        state.update(cx, |state, _| {
            state.measured_code = Some((block.code.clone(), mono, width))
        });
    }
    let data = state.read(cx);
    let has_overflow = data.viewport_width > px(0.)
        && data.measured_code.as_ref().is_some_and(|(_, _, width)| {
            *width > data.viewport_width - px(M::CODE_PAD * 2. + M::CODE_BORDER * 2.)
        });
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
    if (hidden == 0 || expanded) && (has_overflow || wrapped) {
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
    let measure_state = state.clone();
    let mut frame = div()
        .id(("transcript-code", offset))
        .w_full()
        .min_w_0()
        .rounded(px(M::CODE_RADIUS))
        .border_1()
        .border_color(Hsla {
            a: M::CODE_BORDER_ALPHA,
            ..p.text
        })
        .overflow_hidden()
        .on_prepaint(move |bounds, _, cx| {
            measure_state.update(cx, |state, cx| {
                if state.viewport_width != bounds.size.width {
                    state.viewport_width = bounds.size.width;
                    cx.notify();
                }
            })
        })
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
                        .font_family(Theme::global(cx).mono_font_family.clone())
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
                .id("json-tree")
                .max_h(px(M::JSON_HEIGHT))
                .overflow_y_scroll()
                .px(px(M::CODE_PAD))
                .pt(px(M::JSON_PAD_TOP))
                .pb(px(M::JSON_PAD_BOTTOM))
                .text_color(p.muted)
                .font_family(Theme::global(cx).mono_font_family.clone())
                .text_size(px(M::CODE_TEXT))
                .line_height(px(M::JSON_LINE))
                .child(render_json(
                    json,
                    "root".to_owned(),
                    None,
                    false,
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
                    .self_start()
                    .justify_start()
                    .h(px(M::CONTROL))
                    .ml(px(M::GAP))
                    .px(px(M::GAP))
                    .py_0()
                    .font_family(Theme::global(cx).mono_font_family.clone())
                    .text_size(px(M::CODE_LABEL))
                    .text_color(p.muted)
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
    trailing: bool,
    state: &Entity<CodeState>,
    resize: &Option<WeakEntity<crate::ui::AppView>>,
    cx: &App,
) -> AnyElement {
    let p = Palette::get(cx);
    let syntax = M::syntax(Theme::global(cx).is_dark());
    let string_color = syntax
        .string
        .map(HighlightStyle::from)
        .and_then(|style| style.color)
        .unwrap_or(p.text);
    let literal_color = syntax
        .number
        .map(HighlightStyle::from)
        .and_then(|style| style.color)
        .unwrap_or(p.text);
    let children: Vec<(String, &JsonTree)> = match value {
        JsonTree::Object(members) => members
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
    let suffix = if trailing { "," } else { "" };
    if children.is_empty() {
        let (text, color) = match value {
            JsonTree::Scalar(value) => (
                value.to_string(),
                if value.is_string() {
                    string_color
                } else if value.is_null() {
                    p.muted
                } else {
                    literal_color
                },
            ),
            JsonTree::Object(_) => ("{}".to_owned(), p.muted),
            JsonTree::Array(_) => ("[]".to_owned(), p.muted),
        };
        return div()
            .h_flex()
            .gap_0()
            .text_color(p.muted)
            .when(!label.is_empty(), |this| {
                this.child(div().text_color(string_color).child(label))
            })
            .child(div().text_color(color).child(text))
            .child(suffix)
            .into_any_element();
    }
    let depth = path.matches('/').count();
    let closed = state.read(cx).closed_json.contains(&path) != (depth >= 2);
    let array = matches!(value, JsonTree::Array(_));
    let summary = if closed {
        format!(
            "{} ({} {}){suffix}",
            if array { "Array" } else { "Object" },
            children.len(),
            if array { "items" } else { "keys" }
        )
    } else {
        if array { "[" } else { "{" }.to_owned()
    };
    let accessibility = format!("{label}{summary}");
    let toggle = state.clone();
    let toggle_path = path.clone();
    let toggle_resize = resize.clone();
    let mut result = div().v_flex().child(
        Button::new(SharedString::from(path.clone()))
            .ghost()
            .small()
            .self_start()
            .justify_start()
            .h(px(M::JSON_LINE))
            .ml(px(-M::ICON))
            .px_0()
            .py_0()
            .font_family(Theme::global(cx).mono_font_family.clone())
            .text_size(px(M::CODE_TEXT))
            .text_color(p.muted)
            .icon(if closed {
                IconName::ChevronRight
            } else {
                IconName::ChevronDown
            })
            .accessibility_label(accessibility)
            .child(
                div()
                    .h_flex()
                    .gap_0()
                    .when(!label.is_empty(), |this| {
                        this.child(div().text_color(string_color).child(label))
                    })
                    .child(div().when(closed, |this| this.italic()).child(summary)),
            )
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
        let count = children.len();
        result = result
            .child(
                div()
                    .pl(px(M::JSON_INDENT))
                    .children(
                        children
                            .into_iter()
                            .enumerate()
                            .map(|(index, (key, value))| {
                                render_json(
                                    value,
                                    format!("{path}/{index}"),
                                    (!array).then_some(key.as_str()),
                                    index + 1 < count,
                                    state,
                                    resize,
                                    cx,
                                )
                            }),
                    ),
            )
            .child(format!("{}{suffix}", if array { "]" } else { "}" }));
    }
    result.into_any_element()
}

#[derive(Clone)]
pub(crate) struct TableBlock {
    pub cells: Vec<Vec<String>>,
    pub plain: Vec<Vec<String>>,
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
        .child(table_body(table, window, cx))
        .child(
            div()
                .id("table-controls")
                .track_focus(&focus)
                .absolute()
                .right_0()
                .top_0()
                .h_flex()
                .bg(p.bg)
                .opacity(if focus.contains_focused(window, cx) {
                    1.
                } else {
                    0.
                })
                .group_hover("transcript-table", |this| this.opacity(1.))
                .child(
                    Button::new("expand-table")
                        .ghost()
                        .small()
                        .icon(IconName::Maximize)
                        .label("Expand table")
                        .on_click(move |_, window, cx| {
                            let table = expanded.clone();
                            window.open_dialog(cx, move |dialog, window, cx| {
                                dialog.title("Expanded table").w(px(M::DIALOG_WIDTH)).child(
                                    div()
                                        .id("expanded-table-scroll")
                                        .max_h(px(M::DIALOG_HEIGHT))
                                        .overflow_scroll()
                                        .child(table_body(&table, window, cx)),
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

fn table_body(table: &TableBlock, window: &mut Window, cx: &App) -> AnyElement {
    let p = Palette::get(cx);
    let columns = table.cells.first().map_or(1, Vec::len).max(1);
    let mut widths = vec![M::CELL_PAD; columns];
    for (row, cells) in table.plain.iter().enumerate() {
        for (column, text) in cells.iter().take(columns).enumerate() {
            let mut face = font(Theme::global(cx).font_family.clone());
            face.weight = if row == 0 {
                FontWeight::SEMIBOLD
            } else if column == 0 {
                FontWeight::MEDIUM
            } else {
                FontWeight::NORMAL
            };
            let padding = M::CELL_PAD * if column == 0 { 1. } else { 2. };
            widths[column] = widths[column]
                .max(f32::from(text_width(text, face, px(M::TABLE_TEXT), window)) + padding);
        }
    }
    let total: f32 = widths.iter().sum();
    div()
        .w_full()
        .min_w_0()
        .text_size(px(M::TABLE_TEXT))
        .line_height(px(M::TABLE_LINE))
        .children(table.cells.iter().enumerate().map(|(row, cells)| {
            div()
                .flex()
                .w_full()
                .items_start()
                .when(row + 1 < table.cells.len(), |this| this.border_b_1())
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
                        .w(relative(widths[column] / total))
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
                        .child(
                            TextView::markdown(("cell", row * columns + column), cell.clone())
                                .text_color(if row == 0 || column == 0 {
                                    p.strong
                                } else {
                                    p.text
                                })
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

pub(crate) fn render_image(image: &ImageBlock, cx: &App) -> AnyElement {
    let p = Palette::get(cx);
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
        .rounded(px(M::IMAGE_RADIUS))
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
                    .ghost()
                    .small()
                    .border_0()
                    .h(px(M::IMAGE_ACTION_HEIGHT))
                    .px(px(M::IMAGE_ACTION_PAD_X))
                    .py(px(M::IMAGE_ACTION_PAD_Y))
                    .rounded(px(M::SMALL_RADIUS))
                    .bg(Hsla {
                        a: M::IMAGE_ACTION_ALPHA,
                        ..p.text
                    })
                    .text_color(p.accent)
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

fn text_width(source: &str, face: Font, size: Pixels, window: &mut Window) -> Pixels {
    source
        .lines()
        .map(|line| {
            window
                .text_system()
                .shape_line(
                    line.to_owned().into(),
                    size,
                    &[TextRun {
                        len: line.len(),
                        font: face.clone(),
                        color: transparent_black(),
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    }],
                    None,
                )
                .width()
        })
        .max_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(px(0.))
}
