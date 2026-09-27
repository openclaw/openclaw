use super::*;

#[derive(Clone)]
pub(crate) struct TableBlock {
    pub cells: Vec<Vec<String>>,
    pub plain: Vec<Vec<String>>,
    pub extensions: gpui_kit::component::text::MarkdownExtensions,
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
                                .markdown_extensions(table.extensions.clone())
                                .selectable(true)
                                .scrollable(false),
                        )
                }))
        }))
        .into_any_element()
}
