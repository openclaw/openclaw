use super::{
    AppView,
    theme::{Palette, tokens::transcript::TranscriptSurfaceTokens as T},
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
            && self.chat.manual_compaction.is_none()
            && self.chat.note.is_none()
            && self.chat.history_error.is_none()
        {
            return self.transcript_welcome(cx);
        }
        let view = cx.entity().downgrade();
        let focus = self
            .transcript_state
            .focus
            .get_or_insert_with(|| cx.focus_handle())
            .clone();
        div()
            .id("chat-transcript")
            .track_focus(&focus)
            .tab_index(0)
            .role(Role::ScrollView)
            .aria_label("Conversation messages")
            .on_click(cx.listener(|this, _, window, cx| {
                if let Some(focus) = &this.transcript_state.focus
                    && !focus.contains_focused(window, cx)
                {
                    focus.focus(window, cx);
                }
            }))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                let modifiers = event.keystroke.modifiers;
                if modifiers.control || modifiers.alt || modifiers.platform || modifiers.shift {
                    return;
                }
                let page =
                    this.transcript_list.viewport_bounds().size.height * T::SCROLL_PAGE_FRACTION;
                match event.keystroke.key.as_str() {
                    "pageup" => this.transcript_list.scroll_by(-page),
                    "pagedown" => this.transcript_list.scroll_by(page),
                    "home" => {
                        this.transcript_list.pause_following_tail();
                        this.transcript_list.scroll_to(ListOffset {
                            item_ix: 0,
                            offset_in_item: px(0.),
                        });
                    }
                    "end" => {
                        this.transcript_list.set_follow_mode(FollowMode::Tail);
                        this.transcript_list.scroll_to_end();
                    }
                    _ => return,
                }
                cx.stop_propagation();
                cx.notify();
            }))
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
                list(self.transcript_list.clone(), move |index, window, cx| {
                    view.update(cx, |this, cx| this.transcript_row(index, window, cx))
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
    fn transcript_row(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let manual_index = self.chat.messages.len() + usize::from(self.chat.active_run.is_some());
        let recap_index = manual_index + usize::from(self.chat.manual_compaction.is_some());
        let note_index = recap_index + usize::from(self.chat.turn_recap.is_some());
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
            self.render_message(index, &message, group, false, window, cx)
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
                .child(self.render_message(index, &message, true, true, window, cx))
                .when(
                    self.chat.compacting && self.chat.manual_compaction.is_none(),
                    |this| {
                        this.child(super::transcript_notices::system_line(
                            "Compacting context…",
                            None,
                            true,
                            true,
                            cx,
                        ))
                    },
                )
                .child(self.render_working_indicator(
                    waiting,
                    elapsed,
                    (self.chat.output_tokens > 0).then_some(self.chat.output_tokens),
                    cx,
                ))
                .into_any_element()
        } else if index == manual_index && self.chat.manual_compaction.is_some() {
            super::transcript_notices::system_line("Compacting context…", None, true, true, cx)
        } else if let Some(recap) = self
            .chat
            .turn_recap
            .as_ref()
            .filter(|_| index == recap_index)
        {
            self.render_turn_recap(recap.runtime_ms, recap.output_tokens, cx)
        } else if let Some(note) = self
            .chat
            .note
            .as_ref()
            .filter(|note| !note.error && index == note_index)
        {
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
