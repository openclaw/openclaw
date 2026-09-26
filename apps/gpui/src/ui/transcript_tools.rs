use super::{AppView, theme::Palette, transcript_state::fenced_code};
use crate::model::tools::{ToolCall, tools_elapsed_ms};
use crate::ui::theme::tokens::{conversation as t, radius, space, text, weight};
use gpui_kit::{
    component::{
        Sizable, StyledExt,
        button::{Button, ButtonVariants},
        spinner::Spinner,
        text::TextView,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn render_tool_group(
        &mut self,
        message_key: &str,
        index: usize,
        tools: &[ToolCall],
        streaming: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let key = format!("{message_key}:tools");
        let collapsed =
            !streaming && tools.len() > 1 && !self.transcript_state.expanded.contains(&key);
        let duration = tools_elapsed_ms(tools);
        let toggle = key.clone();
        let mut group = div().v_flex().gap(space::REM_SM);
        if !streaming && tools.len() > 1 {
            group = group.child(
                Button::new(SharedString::from(key.clone()))
                    .ghost()
                    .small()
                    .child(div().w_full().text_left().child(format!(
                        "{} {}{} tools",
                        if collapsed { "›" } else { "⌄" },
                        duration
                            .map(|duration| format!(
                                "Worked for {:.1}s · ",
                                duration as f64 / 1000.
                            ))
                            .unwrap_or_default(),
                        tools.len()
                    )))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this.transcript_state.expanded.remove(&toggle) {
                            this.transcript_state.expanded.insert(toggle.clone());
                        }
                        this.transcript_list.remeasure_items(index..index + 1);
                        cx.notify();
                    })),
            );
        }
        if !collapsed {
            for (tool_index, tool) in tools.iter().enumerate() {
                let key = format!("{key}:{}:{tool_index}", tool.id);
                let expanded = self.transcript_state.expanded.contains(&key);
                let toggle = key.clone();
                let output_key = format!("{key}:output");
                let show_all = self.transcript_state.show_all.contains(&output_key);
                let output = if show_all {
                    tool.output.clone()
                } else {
                    tool.output.lines().take(200).collect::<Vec<_>>().join("\n")
                };
                let status = tool.status();
                let success = tool.complete && !tool.is_error && !tool.interrupted();
                let mut card = div()
                    .v_flex()
                    .w_full()
                    .rounded(radius::WIDGET_MD)
                    .when(expanded, |card| {
                        card.bg(p.card)
                            .border(space::HAIRLINE)
                            .border_color(p.border)
                    })
                    .overflow_hidden()
                    .child(
                        div()
                            .id(SharedString::from(key.clone()))
                            .h_flex()
                            .px(space::XS)
                            .min_h(t::TOOL_ROW_MIN_HEIGHT)
                            .py(space::XS)
                            .gap(space::REM_SM)
                            .hover(|this| this.bg(p.hover))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.transcript_state.expanded.remove(&toggle) {
                                    this.transcript_state.expanded.insert(toggle.clone());
                                }
                                this.transcript_list.remeasure_items(index..index + 1);
                                cx.notify();
                            }))
                            .child(div().text_color(p.muted).child(if expanded {
                                "⌄"
                            } else {
                                "›"
                            }))
                            .when(tool.running(), |this| {
                                this.child(Spinner::new().color(p.accent))
                            })
                            .when(!tool.running(), |this| {
                                this.child(
                                    div()
                                        .text_color(if tool.interrupted() {
                                            p.muted
                                        } else if tool.is_error {
                                            p.danger
                                        } else if success {
                                            p.ok
                                        } else {
                                            p.muted
                                        })
                                        .child(if tool.interrupted() {
                                            "−"
                                        } else if tool.is_error {
                                            "✕"
                                        } else if success {
                                            "✓"
                                        } else {
                                            "−"
                                        }),
                                )
                            })
                            .child(
                                div()
                                    .flex_1()
                                    .min_w(space::NONE)
                                    .truncate()
                                    .text_size(text::WIDGET_SM_SIZE)
                                    .font_weight(weight::MEDIUM)
                                    .text_color(p.strong)
                                    .child(tool.summary()),
                            )
                            .child(
                                div()
                                    .text_size(text::WIDGET_XS_SIZE)
                                    .text_color(p.muted)
                                    .child(
                                        tool.duration_ms()
                                            .map(|duration| {
                                                format!(
                                                    "{status} · {:.1}s",
                                                    duration as f64 / 1000.
                                                )
                                            })
                                            .unwrap_or_else(|| status.into()),
                                    ),
                            ),
                    );
                if expanded {
                    let args = serde_json::to_string_pretty(&tool.args).unwrap_or_default();
                    let args =
                        self.markdown_state(format!("{key}:args"), &fenced_code("json", &args), cx);
                    let result =
                        self.markdown_state(output_key.clone(), &fenced_code("text", &output), cx);
                    let copy = tool.output.clone();
                    card = card.child(
                        div()
                            .v_flex()
                            .p(space::REM_MD)
                            .gap(space::REM_SM)
                            .border_t(space::HAIRLINE)
                            .border_color(p.border)
                            .child(
                                div()
                                    .text_size(text::WIDGET_XS_SIZE)
                                    .text_color(p.muted)
                                    .child("Arguments"),
                            )
                            .child(TextView::new(&args).selectable(true).scrollable(false))
                            .when(!tool.output.is_empty(), |this| {
                                this.child(
                                    div()
                                        .h_flex()
                                        .justify_between()
                                        .child(
                                            div()
                                                .text_size(text::WIDGET_XS_SIZE)
                                                .text_color(p.muted)
                                                .child("Result"),
                                        )
                                        .child(
                                            Button::new(SharedString::from(format!("{key}:copy")))
                                                .ghost()
                                                .xsmall()
                                                .label("Copy")
                                                .on_click(move |_, _, cx| {
                                                    cx.write_to_clipboard(
                                                        ClipboardItem::new_string(copy.clone()),
                                                    )
                                                }),
                                        ),
                                )
                                .child(TextView::new(&result).selectable(true).scrollable(false))
                            })
                            .when(tool.output.lines().count() > 200 && !show_all, |this| {
                                this.child(
                                    Button::new(SharedString::from(format!("{key}:all")))
                                        .ghost()
                                        .small()
                                        .label("Show all output")
                                        .on_click(cx.listener(move |this, _, _, cx| {
                                            this.transcript_state
                                                .show_all
                                                .insert(output_key.clone());
                                            this.transcript_list.remeasure_items(index..index + 1);
                                            cx.notify();
                                        })),
                                )
                            }),
                    );
                }
                group = group.child(card);
            }
        }
        group.into_any_element()
    }
}
