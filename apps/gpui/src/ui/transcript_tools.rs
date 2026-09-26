use super::{
    AppView,
    theme::{Palette, tokens::transcript::ToolTokens as T},
    transcript_state::fenced_code,
};
use crate::model::{
    chat::MessageContent,
    tools::{DiffKind, ToolCall, ToolKind, group_summary},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        tab::{Tab, TabBar},
        text::{TextView, TextViewStyle},
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
        let group_key = format!("{message_key}:tools");
        let collapsed =
            !streaming && tools.len() > 1 && !self.transcript_state.expanded.contains(&group_key);
        let mut group = div().v_flex().gap(px(T::GAP)).w_full();
        if !streaming && tools.len() > 1 {
            let toggle = group_key.clone();
            group = group.child(
                Button::new(SharedString::from(group_key.clone()))
                    .ghost()
                    .small()
                    .self_start()
                    .max_w_full()
                    .icon(if collapsed {
                        IconName::ChevronRight
                    } else {
                        IconName::ChevronDown
                    })
                    .label(group_summary(tools))
                    .text_size(px(T::ROW_FONT))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(p.muted)
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.toggle_tool(&toggle, index, cx)),
                    ),
            );
        }
        if !collapsed {
            for (tool_index, tool) in tools.iter().enumerate() {
                let key = format!("{group_key}:{}:{tool_index}", tool.id);
                let expanded = self.transcript_state.expanded.contains(&key);
                let toggle = key.clone();
                let icon_color = if tool.interrupted() {
                    p.muted
                } else if tool.failed() {
                    p.danger
                } else if tool.running() {
                    p.accent
                } else {
                    p.muted
                };
                let mut card = div().v_flex().w_full().min_w_0();
                card = card.child(
                    Button::new(SharedString::from(key.clone()))
                        .ghost()
                        .small()
                        .self_start()
                        .max_w_full()
                        .accessibility_label(tool.summary())
                        .px(px(T::INLINE_PADDING))
                        .py(px(T::ROW_PADDING))
                        .h_auto()
                        .text_color(p.muted)
                        .tooltip(
                            tool.duration_ms()
                                .map(|duration| {
                                    format!("{} · {:.1}s", tool.outcome(), duration as f64 / 1000.)
                                })
                                .unwrap_or_else(|| tool.outcome()),
                        )
                        .child(
                            div()
                                .h_flex()
                                .min_w_0()
                                .gap(px(T::ROW_GAP))
                                .child(
                                    Icon::new(if expanded {
                                        IconName::ChevronDown
                                    } else {
                                        IconName::ChevronRight
                                    })
                                    .size(px(T::ICON)),
                                )
                                .child(
                                    Icon::new(tool_icon(tool.kind()))
                                        .size(px(T::ICON))
                                        .text_color(icon_color),
                                )
                                .child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(T::ROW_FONT))
                                        .line_height(px(T::ROW_LINE))
                                        .font_weight(FontWeight::NORMAL)
                                        .child(tool.summary()),
                                )
                                .when(
                                    tool.failed() || tool.interrupted() || tool.running(),
                                    |row| {
                                        row.child(
                                            div()
                                                .text_size(px(T::OUTCOME_FONT))
                                                .text_color(icon_color)
                                                .child(tool.status()),
                                        )
                                    },
                                ),
                        )
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.toggle_tool(&toggle, index, cx)),
                        ),
                );
                if expanded {
                    card = card.child(self.render_tool_body(&key, index, tool, cx));
                }
                group = group.child(card);
            }
        }
        group.into_any_element()
    }

    fn toggle_tool(&mut self, key: &str, index: usize, cx: &mut Context<Self>) {
        if !self.transcript_state.expanded.remove(key) {
            self.transcript_state.expanded.insert(key.to_owned());
        }
        self.transcript_list.remeasure_items(index..index + 1);
        cx.notify();
    }

    fn render_tool_body(
        &mut self,
        key: &str,
        index: usize,
        tool: &ToolCall,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let mut body = div()
            .v_flex()
            .w_full()
            .min_w_0()
            .rounded(px(T::RADIUS))
            .border_1()
            .border_color(p.border)
            .overflow_hidden();
        let diff = tool.diff();
        if !diff.is_empty() {
            let path = tool.workspace_path().map(str::to_owned);
            let copy = diff
                .iter()
                .map(|line| {
                    format!(
                        "{}{}",
                        match line.kind {
                            DiffKind::Add => "+",
                            DiffKind::Delete => "-",
                            _ => " ",
                        },
                        line.text
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");
            let copy_key = format!("{key}:copy-diff");
            let copied = self
                .transcript_state
                .copied
                .get(&copy_key)
                .is_some_and(|(copied, _)| *copied);
            body = body.child(
                div()
                    .h_flex()
                    .justify_between()
                    .px(px(T::BODY_X))
                    .py(px(T::INLINE_PADDING))
                    .when_some(path, |row, path| {
                        row.child(
                            Button::new(SharedString::from(format!("{key}:file")))
                                .ghost()
                                .xsmall()
                                .label(path.clone())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.open_workspace_file(&path, cx)
                                })),
                        )
                    })
                    .child(
                        Button::new(SharedString::from(format!("{key}:copy-diff")))
                            .ghost()
                            .xsmall()
                            .icon(if copied {
                                IconName::Check
                            } else {
                                IconName::Copy
                            })
                            .tooltip(if copied { "Copied" } else { "Copy diff" })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.copy_transcript_text(copy_key.clone(), copy.clone(), cx)
                            })),
                    ),
            );
            let raw_key = format!("{key}:raw-mode");
            let explicit_diff = format!("{key}:diff-mode");
            let raw = self.transcript_state.expanded.contains(&raw_key)
                || (tool.failed() || tool.interrupted())
                    && !self.transcript_state.expanded.contains(&explicit_diff);
            body = body.child(
                TabBar::new(SharedString::from(format!("{key}:modes")))
                    .underline()
                    .small()
                    .selected_index(usize::from(raw))
                    .child(Tab::new().label("Diff"))
                    .child(Tab::new().label("Raw"))
                    .on_click(cx.listener(move |this, selected: &usize, _, cx| {
                        if *selected == 1 {
                            this.transcript_state.expanded.insert(raw_key.clone());
                            this.transcript_state.expanded.remove(&explicit_diff);
                        } else {
                            this.transcript_state.expanded.remove(&raw_key);
                            this.transcript_state.expanded.insert(explicit_diff.clone());
                        }
                        this.transcript_list.remeasure_items(index..index + 1);
                        cx.notify();
                    })),
            );
            if raw {
                let args =
                    serde_json::to_string_pretty(tool.display_target().1).unwrap_or_default();
                body =
                    body.child(self.render_tool_code(format!("{key}:raw-args"), "json", &args, cx));
                if !tool.output.is_empty() || tool.result.get("content").is_some() {
                    body = body.child(self.render_tool_output(key, index, tool, cx));
                }
            } else {
                body = body.child(div().v_flex().w_full().py(px(T::INLINE_PADDING)).children(
                    diff.into_iter().map(|line| {
                        let color = match line.kind {
                            DiffKind::Add => p.ok,
                            DiffKind::Delete => p.danger,
                            _ => p.text,
                        };
                        let marker = match line.kind {
                            DiffKind::Add => "+",
                            DiffKind::Delete => "−",
                            DiffKind::Skip => "…",
                            _ => " ",
                        };
                        div()
                            .h_flex()
                            .px(px(T::BODY_X))
                            .text_size(px(T::SMALL_FONT))
                            .line_height(px(T::CODE_LINE))
                            .font_family("monospace")
                            .when(
                                matches!(line.kind, DiffKind::Add | DiffKind::Delete),
                                |row| {
                                    row.bg(Hsla {
                                        a: T::TINT,
                                        ..color
                                    })
                                },
                            )
                            .child(
                                div()
                                    .w(px(T::DIFF_GUTTER))
                                    .flex_shrink_0()
                                    .text_color(p.muted)
                                    .child(
                                        line.number
                                            .map(|number| number.to_string())
                                            .unwrap_or_default(),
                                    ),
                            )
                            .child(
                                div()
                                    .w(px(T::ICON))
                                    .flex_shrink_0()
                                    .text_color(color)
                                    .child(marker),
                            )
                            .child(div().min_w_0().text_color(p.text).child(line.text))
                    }),
                ));
            }
        } else {
            if let Some(command) = tool.command() {
                body = body.child(
                    div()
                        .h_flex()
                        .items_start()
                        .px(px(T::BODY_X))
                        .pt(px(T::BLOCK_GAP))
                        .gap(px(T::BLOCK_GAP))
                        .child(
                            div()
                                .font_family("monospace")
                                .text_size(px(T::SMALL_FONT))
                                .text_color(p.muted)
                                .child("$"),
                        )
                        .child(self.render_tool_code(
                            format!("{key}:command"),
                            "bash",
                            command,
                            cx,
                        )),
                );
            } else if let Some(code) = tool.code() {
                body = body.child(self.render_tool_code(
                    format!("{key}:code"),
                    "javascript",
                    code,
                    cx,
                ));
            }
            let extras = tool.extra_args();
            if !extras.is_empty() {
                body = body.child(
                    div()
                        .v_flex()
                        .px(px(T::BODY_X))
                        .py(px(T::BLOCK_GAP))
                        .gap(px(T::INLINE_PADDING))
                        .children(extras.into_iter().map(|(key, value)| {
                            div()
                                .h_flex()
                                .items_start()
                                .gap(px(T::GAP))
                                .text_size(px(T::SMALL_FONT))
                                .child(div().text_color(p.muted).child(format!("{key}:")))
                                .child(div().min_w_0().text_color(p.text).child(value))
                        })),
                );
            }
            if !tool.output.is_empty() || tool.result.get("content").is_some() {
                body = body.child(self.render_tool_output(key, index, tool, cx));
            }
            if tool.failed() && tool.output.is_empty() {
                body = body.child(
                    div()
                        .px(px(T::BODY_X))
                        .py(px(T::BLOCK_GAP))
                        .text_size(px(T::SMALL_FONT))
                        .text_color(p.danger)
                        .child("Tool failed without output."),
                );
            }
        }
        if !tool.result.is_null() {
            let raw_key = format!("{key}:raw-details");
            let shown = self.transcript_state.expanded.contains(&raw_key);
            body = body.child(
                Button::new(SharedString::from(raw_key.clone()))
                    .ghost()
                    .xsmall()
                    .self_start()
                    .label("Raw details")
                    .icon(if shown {
                        IconName::ChevronDown
                    } else {
                        IconName::ChevronRight
                    })
                    .on_click(
                        cx.listener(move |this, _, _, cx| this.toggle_tool(&raw_key, index, cx)),
                    ),
            );
            if shown {
                let raw = serde_json::to_string_pretty(&tool.result).unwrap_or_default();
                body = body.child(self.render_tool_code(
                    format!("{key}:raw-details-content"),
                    "json",
                    &raw,
                    cx,
                ));
            }
        }
        body.child(
            div()
                .w_full()
                .border_t_1()
                .border_color(p.border)
                .px(px(T::OUTCOME_X))
                .py(px(T::BLOCK_GAP))
                .text_right()
                .text_size(px(T::OUTCOME_FONT))
                .text_color(p.muted)
                .child(tool.outcome()),
        )
        .into_any_element()
    }

    fn render_tool_output(
        &mut self,
        key: &str,
        index: usize,
        tool: &ToolCall,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if let Some(message) = tool.rich_result() {
            let mut body = div().v_flex().w_full().gap(px(T::BLOCK_GAP));
            for (part_index, part) in message.ordered_content().into_iter().enumerate() {
                match part {
                    MessageContent::Text(text) => {
                        body = body.child(self.render_tool_code(
                            format!("{key}:rich:{part_index}"),
                            "text",
                            &text,
                            cx,
                        ))
                    }
                    MessageContent::Attachment(attachment) => {
                        if let Some(attachment) = message.attachments.get(attachment) {
                            body = body.child(self.render_message_attachment(attachment, cx));
                        }
                    }
                    MessageContent::Media(media) => {
                        if let Some(media) = message.media.get(media) {
                            body = body.child(self.render_message_media(
                                &format!("{key}:rich:{part_index}"),
                                media,
                                cx,
                            ));
                        }
                    }
                }
            }
            return body.into_any_element();
        }
        let output_key = format!("{key}:output");
        let show_all = self.transcript_state.show_all.contains(&output_key);
        let output = if show_all {
            tool.output.clone()
        } else {
            tool.output.lines().take(200).collect::<Vec<_>>().join("\n")
        };
        div()
            .v_flex()
            .w_full()
            .child(
                div()
                    .id(SharedString::from(format!("{key}:output-viewport")))
                    .max_h(px(T::OUTPUT_HEIGHT))
                    .overflow_y_scroll()
                    .child(self.render_tool_code(output_key.clone(), "text", &output, cx)),
            )
            .when(tool.output.lines().count() > 200 && !show_all, |body| {
                body.child(
                    Button::new(SharedString::from(format!("{key}:all")))
                        .ghost()
                        .small()
                        .label("Show full output")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.transcript_state.show_all.insert(output_key.clone());
                            this.transcript_list.remeasure_items(index..index + 1);
                            cx.notify();
                        })),
                )
            })
            .into_any_element()
    }

    fn render_tool_code(
        &mut self,
        key: String,
        language: &str,
        source: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let state = self.markdown_state(key, &fenced_code(language, source), cx);
        TextView::new(&state)
            .selectable(true)
            .scrollable(false)
            .style(
                TextViewStyle::default().code_block(
                    StyleRefinement::default()
                        .bg(transparent_black())
                        .border_0()
                        .rounded_none()
                        .px(px(T::BODY_X))
                        .py(px(T::BLOCK_GAP))
                        .text_size(px(T::SMALL_FONT))
                        .line_height(px(T::CODE_LINE))
                        .text_color(p.text),
                ),
            )
            .into_any_element()
    }
}

fn tool_icon(kind: ToolKind) -> IconName {
    match kind {
        ToolKind::Command => IconName::Terminal,
        ToolKind::Read => IconName::FileText,
        ToolKind::Edit => IconName::SquarePen,
        ToolKind::Write => IconName::FileText,
        ToolKind::Search => IconName::Search,
        ToolKind::Fetch => IconName::Globe,
        ToolKind::Generic => IconName::Wrench,
    }
}
