use super::{
    AppView,
    theme::{Palette, TranscriptSurfaceTokens as T},
};
use crate::model::chat::{Message, now_ms};
use gpui_kit::{
    component::{
        Disableable, IconName, StyledExt,
        button::{Button, ButtonVariants},
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
            return self.transcript_welcome(cx);
        }
        let view = cx.entity().downgrade();
        div()
            .relative()
            .v_flex()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .child(self.render_run_error(cx))
            .when(self.chat.has_more, |this| {
                this.child(
                    div().flex().justify_center().py_1().child(
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
                        .px_6()
                        .py_2()
                        .gap_3()
                        .text_sm()
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
                .w_full()
                .flex_1()
                .min_h_0(),
            )
            .when(!self.transcript_list.is_following_tail(), |this| {
                this.child(
                    div()
                        .absolute()
                        .bottom_3()
                        .left_0()
                        .right_0()
                        .flex()
                        .justify_center()
                        .child(
                            Button::new("jump-latest")
                                .icon(IconName::ArrowDown)
                                .tooltip("Scroll to bottom")
                                .accessibility_label("Scroll to bottom")
                                .rounded_full()
                                .w(px(T::SCROLL_SIZE))
                                .h(px(T::SCROLL_SIZE))
                                .bg(p.panel_strong)
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.transcript_list.set_follow_mode(FollowMode::Tail);
                                    this.transcript_list.scroll_to_end();
                                    cx.notify();
                                })),
                        ),
                )
            })
            .children(self.render_reply_preview(cx))
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
            let elapsed = now_ms().saturating_sub(self.chat.started_at.unwrap_or_else(now_ms));
            let waiting = self
                .router
                .approvals
                .pending
                .values()
                .any(|approval| approval.expires_at_ms > now_ms());
            div()
                .v_flex()
                .gap_3()
                .child(self.render_message(index, &message, true, true, cx))
                .when(self.chat.compacting, |this| {
                    this.child(super::transcript_notices::system_line(
                        "Compacting context…",
                        None,
                        true,
                        true,
                        cx,
                    ))
                })
                .child(self.render_working_indicator(
                    waiting,
                    elapsed,
                    (self.chat.output_tokens > 0).then_some(self.chat.output_tokens),
                    cx,
                ))
                .into_any_element()
        } else if let Some(recap) = self.chat.turn_recap.as_ref() {
            self.render_turn_recap(recap.runtime_ms, recap.output_tokens, cx)
        } else if let Some(note) = self.chat.note.as_ref().filter(|note| !note.error) {
            div()
                .my_3()
                .text_size(px(T::SMALL_TEXT))
                .text_color(p.muted)
                .child(note.text.clone())
                .into_any_element()
        } else {
            div().into_any_element()
        };
        div()
            .w_full()
            .flex()
            .justify_center()
            .px(px(T::INSET))
            .child(div().w_full().max_w(px(T::WIDTH)).child(content))
            .into_any_element()
    }
}
