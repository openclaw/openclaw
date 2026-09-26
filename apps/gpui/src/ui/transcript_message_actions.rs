use super::{
    AppView,
    theme::{Palette, tokens::transcript::TranscriptTokens as T},
};
use crate::model::{
    chat::{Message, ReplyTarget, exact_time},
    people::Person,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    *,
};
use std::time::Duration;

impl AppView {
    pub(super) fn message_author(&self, message: &Message) -> String {
        message
            .sender
            .clone()
            .or_else(|| {
                message
                    .sender_person
                    .as_ref()
                    .map(|person| person.label().to_owned())
            })
            .unwrap_or_else(|| {
                if message.role == "user" {
                    self.sidebar_state
                        .people
                        .self_user
                        .as_ref()
                        .map(|person| person.label().to_owned())
                        .unwrap_or_else(|| "You".into())
                } else if let Some(agent) = message.sender_agent.as_deref().and_then(|id| {
                    self.sidebar_state
                        .agents
                        .iter()
                        .find(|agent| agent.id == id)
                }) {
                    agent.name.clone().unwrap_or_else(|| agent.id.clone())
                } else {
                    self.selected_agent_name()
                }
            })
    }

    pub(super) fn message_reply_attribution(&self, index: usize) -> Option<String> {
        let mut senders = self
            .chat
            .messages
            .iter()
            .filter(|message| message.role == "user")
            .filter_map(|message| message.sender_person.as_ref())
            .map(Person::key);
        let first = senders.next()?;
        if !senders.any(|sender| sender != first) {
            return None;
        }
        let previous = self
            .chat
            .messages
            .get(..index)?
            .iter()
            .rev()
            .find(|message| message.role == "user" || message.sender_agent.is_some())?;
        (previous.role == "user")
            .then(|| {
                previous
                    .sender_person
                    .as_ref()
                    .map(|person| person.label().to_owned())
            })
            .flatten()
    }

    pub(super) fn resolve_message_reply(&self, message: &Message) -> Option<ReplyTarget> {
        let id = message.reply_to.as_ref()?;
        self.chat
            .messages
            .iter()
            .find(|source| source.entry_id.as_ref().or(source.id.as_ref()) == Some(id))
            .map(|source| ReplyTarget {
                id: Some(id.clone()),
                text: source.text.clone(),
                sender: self.message_author(source),
            })
            .or_else(|| message.reply_preview.clone())
            .or_else(|| {
                Some(ReplyTarget {
                    id: Some(id.clone()),
                    text: "View original message".into(),
                    sender: "Reply".into(),
                })
            })
    }

    pub(super) fn message_metadata(&self, index: usize, message: &Message) -> String {
        let mut first = index;
        while first > 0
            && !crate::model::grouping::starts_group(
                self.chat.messages.get(first - 1),
                &self.chat.messages[first],
            )
        {
            first -= 1;
        }
        let meta = crate::model::grouping::GroupMetadata::from_messages(
            self.chat.messages.get(first..=index).unwrap_or_default(),
        );
        let mut parts = vec![
            message
                .timestamp
                .map(exact_time)
                .unwrap_or_else(|| "Current response".into()),
        ];
        for (count, label) in [
            (meta.input, "input"),
            (meta.output, "output"),
            (meta.cache_read, "cache read"),
            (meta.cache_write, "cache write"),
        ] {
            if count > 0 {
                parts.push(format!("{count} {label} tokens"));
            }
        }
        if meta.cost > 0. {
            parts.push(format!("${:.4}", meta.cost));
        }
        if let Some(capacity) = self
            .chat
            .session_info
            .context_tokens
            .or_else(|| {
                self.selected_row()
                    .and_then(|row| row.context_tokens)
                    .filter(|capacity| capacity.is_finite() && *capacity > 0.)
                    .map(|capacity| capacity as u64)
            })
            .filter(|capacity| *capacity > 0)
            && meta.prompt > 0
        {
            parts.push(format!(
                "{}% context",
                (100. * meta.prompt as f64 / capacity as f64)
                    .round()
                    .min(100.)
            ));
        }
        if let Some(model) = meta.model {
            parts.push(model.to_owned());
        }
        parts.join("\n")
    }

    pub(super) fn copy_transcript_text(
        &mut self,
        key: String,
        source: String,
        cx: &mut Context<Self>,
    ) {
        cx.write_to_clipboard(ClipboardItem::new_string(source.clone()));
        let copied = cx
            .read_from_clipboard()
            .and_then(|item| item.text())
            .as_deref()
            == Some(source.as_str());
        let feedback = (copied, std::time::Instant::now());
        self.transcript_state.copied.insert(key.clone(), feedback);
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(if copied {
                    T::COPY_FEEDBACK_MS
                } else {
                    T::COPY_FAILURE_MS
                }))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.transcript_state.copied.get(&key) == Some(&feedback) {
                    this.transcript_state.copied.remove(&key);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(super) fn start_message_reply(
        &mut self,
        target: ReplyTarget,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.composer_state.reply = Some(target);
        self.composer_save_draft(cx);
        self.composer
            .update(cx, |state, cx| state.focus(window, cx));
        cx.notify();
    }

    pub(super) fn render_reply_preview(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let target = self.composer_state.reply.as_ref()?;
        let p = Palette::get(cx);
        Some(
            div()
                .h_flex()
                .gap_2()
                .px_4()
                .py_2()
                .border_t_1()
                .border_color(p.border)
                .bg(p.bg)
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .v_flex()
                        .text_size(px(T::META_SIZE))
                        .text_color(p.muted)
                        .child(format!("Replying to {}", target.sender))
                        .child(div().truncate().child(target.text.clone())),
                )
                .child(
                    Button::new("cancel-message-reply")
                        .ghost()
                        .small()
                        .icon(IconName::X)
                        .accessibility_label("Cancel reply")
                        .tooltip("Cancel reply")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.composer_state.reply = None;
                            this.composer_save_draft(cx);
                            cx.notify();
                        })),
                )
                .into_any_element(),
        )
    }
}
