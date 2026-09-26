use super::{AppView, theme::Palette};
use crate::model::chat::{Message, now_ms};
use crate::ui::theme::tokens::{conversation as t, radius, space, text, weight};
use gpui_kit::{
    component::{
        Disableable, StyledExt,
        button::{Button, ButtonVariants},
        spinner::Spinner,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn transcript(&mut self, cx: &mut Context<Self>) -> AnyElement {
        self.install_transcript_scroll(cx);
        let p = Palette::get(cx);
        if self.chat.messages.is_empty()
            && self.chat.active_run.is_none()
            && self.chat.note.is_none()
            && self.chat.history_error.is_none()
        {
            return div()
                .v_flex()
                .flex_1()
                .min_h(space::NONE)
                .items_center()
                .justify_center()
                .gap(space::REM_MD)
                .p(space::REM_XXL)
                .child(
                    div()
                        .text_size(t::EMPTY_AVATAR_SIZE)
                        .text_color(p.accent)
                        .child(self.selected_agent_avatar()),
                )
                .child(
                    div()
                        .text_size(t::EMPTY_TITLE_SIZE)
                        .font_weight(weight::SEMIBOLD)
                        .text_color(p.strong)
                        .child(self.selected_agent_name()),
                )
                .child(div().text_color(p.muted).child(if self.chat.loading {
                    "Loading conversation…"
                } else {
                    "Type / for commands"
                }))
                .when(!self.chat.loading, |this| {
                    this.child(
                        div()
                            .v_flex()
                            .w_full()
                            .max_w(t::RECENT_MAX_WIDTH)
                            .mt(space::REM_XL)
                            .gap(space::REM_XS)
                            .children(
                                self.rows
                                    .iter()
                                    .filter(|row| {
                                        Some(&row.key) != self.chat.selected_session.as_ref()
                                    })
                                    .take(5)
                                    .map(|row| {
                                        let key = row.key.clone();
                                        Button::new(SharedString::from(format!("recent-{key}")))
                                            .ghost()
                                            .label(row.title().to_owned())
                                            .on_click(cx.listener(move |this, _, window, cx| {
                                                this.select_session(key.clone(), window, cx)
                                            }))
                                    }),
                            ),
                    )
                })
                .into_any_element();
        }
        let view = cx.entity().downgrade();
        div()
            .relative()
            .v_flex()
            .flex_1()
            .min_h(space::NONE)
            .overflow_hidden()
            .when(self.chat.has_more, |this| {
                this.child(
                    div().flex().justify_center().py(space::REM_XS).child(
                        Button::new("earlier-messages")
                            .ghost()
                            .label(if self.chat.loading_older {
                                "Loading earlier messages…"
                            } else {
                                "Show earlier messages"
                            })
                            .disabled(self.chat.loading_older)
                            .on_click(cx.listener(|this, _, _, cx| this.load_earlier(cx))),
                    ),
                )
            })
            .when_some(self.chat.history_error.clone(), |this, error| {
                this.child(
                    div()
                        .h_flex()
                        .px(space::REM_XL)
                        .py(space::REM_SM)
                        .gap(space::REM_MD)
                        .text_size(text::WIDGET_SM_SIZE)
                        .text_color(p.danger)
                        .child(
                            div()
                                .flex_1()
                                .child(format!("Could not load history: {error}")),
                        )
                        .child(
                            Button::new("retry-history")
                                .ghost()
                                .label("Retry")
                                .on_click(cx.listener(|this, _, _, cx| this.load_history(cx))),
                        ),
                )
            })
            .child(
                list(self.transcript_list.clone(), move |index, _, cx| {
                    view.update(cx, |this, cx| this.transcript_row(index, cx))
                        .unwrap_or_else(|_| div().into_any_element())
                })
                .size_full(),
            )
            .when(!self.transcript_list.is_following_tail(), |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom(space::REM_MD)
                        .left(space::NONE)
                        .right(space::NONE)
                        .flex()
                        .justify_center()
                        .child(
                            Button::new("jump-latest")
                                .label("↓")
                                .rounded_full()
                                .w(t::JUMP_BUTTON_SIZE)
                                .h(t::JUMP_BUTTON_SIZE)
                                .bg(p.panel_strong)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.transcript_list.set_follow_mode(FollowMode::Tail);
                                    this.transcript_list.scroll_to_end();
                                    cx.notify();
                                })),
                        ),
                )
            })
            .into_any_element()
    }
    fn transcript_row(&mut self, index: usize, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let content = if let Some(mut message) = self.chat.messages.get(index).cloned() {
            message.tools = self.chat.history_tools(index);
            if !message.visible() {
                return div().into_any_element();
            }
            let previous = self.chat.messages[..index]
                .iter()
                .enumerate()
                .rev()
                .find_map(|(i, previous)| {
                    let mut previous = previous.clone();
                    previous.tools = self.chat.history_tools(i);
                    previous.visible().then_some(previous)
                });
            let group = crate::model::grouping::starts_group(previous.as_ref(), &message);
            self.render_message(index, &message, group, false, cx)
        } else if index == self.chat.messages.len() && self.chat.active_run.is_some() {
            let message = Message {
                role: "assistant".into(),
                text: self.chat.stream_text.clone(),
                thinking: self.chat.stream_thinking.clone(),
                tools: self.chat.streaming_tools(),
                run_id: self.chat.active_run.clone(),
                ..Default::default()
            };
            let elapsed =
                now_ms().saturating_sub(self.chat.started_at.unwrap_or_else(now_ms)) / 1000;
            let phase = if self.chat.phase_label.is_empty() {
                "Working".to_owned()
            } else {
                self.chat.phase_label.clone()
            };
            div()
                .v_flex()
                .gap(space::REM_MD)
                .child(self.render_message(index, &message, true, true, cx))
                .child(
                    div()
                        .h_flex()
                        .gap(space::REM_SM)
                        .text_color(p.muted)
                        .text_size(text::WIDGET_XS_SIZE)
                        .child(Spinner::new().color(p.accent))
                        .child(format!(
                            "{phase} · {elapsed}s{}",
                            if self.chat.output_tokens > 0 {
                                format!(" · {} tokens", self.chat.output_tokens)
                            } else {
                                String::new()
                            }
                        )),
                )
                .into_any_element()
        } else if let Some(note) = self.chat.note.clone() {
            let details = self.chat.error_detail.clone();
            let full = format!(
                "{}{}",
                note.text,
                details
                    .as_ref()
                    .map(|text| format!("\n{text}"))
                    .unwrap_or_default()
            );
            div()
                .v_flex()
                .gap(space::REM_SM)
                .p(space::REM_MD)
                .rounded(radius::WIDGET_MD)
                .bg(p.card)
                .border(space::HAIRLINE)
                .border_color(if note.error { p.danger } else { p.border })
                .text_size(text::WIDGET_SM_SIZE)
                .text_color(if note.error { p.danger } else { p.muted })
                .child(
                    div()
                        .h_flex()
                        .gap(space::REM_SM)
                        .child(div().flex_1().child(note.text))
                        .child(Button::new("copy-error").ghost().label("Copy").on_click(
                            move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(full.clone()))
                            },
                        ))
                        .when(details.is_some(), |this| {
                            this.child(
                                Button::new("error-details")
                                    .ghost()
                                    .label(if self.transcript_state.error_expanded {
                                        "Hide details"
                                    } else {
                                        "Details"
                                    })
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.transcript_state.error_expanded =
                                            !this.transcript_state.error_expanded;
                                        this.transcript_list.remeasure();
                                        cx.notify();
                                    })),
                            )
                        }),
                )
                .when(self.transcript_state.error_expanded, |this| {
                    this.child(
                        div()
                            .text_size(text::WIDGET_XS_SIZE)
                            .font_family(t::CODE_FONT_FAMILY)
                            .child(details.unwrap_or_default()),
                    )
                })
                .into_any_element()
        } else {
            div().into_any_element()
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .px(space::REM_XL)
            .child(div().w_full().max_w(t::MAX_WIDTH).child(content))
            .into_any_element()
    }
}
