use super::{
    AppView,
    theme::{Palette, tokens::transcript::TranscriptTokens as T},
};
use crate::model::{
    attachments::Attachment,
    avatars,
    chat::{Message, MessageContent, ReplyTarget, relative_timestamp},
    people::Person,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder,
    *,
};
use std::{
    collections::hash_map::DefaultHasher,
    hash::{Hash, Hasher},
    sync::Arc,
};

impl AppView {
    pub(super) fn render_message(
        &mut self,
        index: usize,
        message: &Message,
        group: bool,
        streaming: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let key = message_key(message, index, streaming);
        if message.system || message.notice.is_some() {
            return self.render_system_notice(index, &key, message, cx);
        }
        let user = message.role == "user";
        let ends_group = self
            .chat
            .messages
            .get(index + 1..)
            .and_then(|remaining| remaining.iter().find(|next| next.visible()))
            .is_none_or(|next| crate::model::grouping::starts_group(Some(message), next));
        let peer = message.is_peer(self.sidebar_state.people.self_user.as_ref());
        let own = user && !peer;
        let author = self.message_author(message);
        let source_label = message.source_label();
        let persistent_identity =
            user && (message.sender_person.is_some() || !source_label.is_empty());
        let sender_hue = message.sender_person.as_ref().map(|person| {
            let identity = if person.id.trim().is_empty() {
                person.label()
            } else {
                &person.id
            };
            (avatars::fnv1a_utf16(identity) % 360) as u16
        });
        let dark = gpui_kit::component::Theme::global(cx).is_dark();
        let bubble = sender_hue
            .map(|hue| T::sender_bubble(p, hue, dark))
            .unwrap_or(p.user_bubble);
        let author_color = sender_hue
            .filter(|_| user)
            .map(|hue| T::sender_label(hue, dark))
            .unwrap_or(p.muted);
        let mut content = div()
            .group(SharedString::from(key.clone()))
            .relative()
            .v_flex()
            .w_full()
            .min_w_0()
            .gap(px(T::MESSAGE_GAP))
            .text_size(px(T::TEXT_SIZE))
            .line_height(relative(T::LINE_HEIGHT))
            .when(user, |this| {
                this.max_w(relative(T::USER_MAX_WIDTH)).items_start()
            })
            .when(own, |this| this.items_end());
        if group
            && message.role == "assistant"
            && message.sender_agent.is_none()
            && let Some(recipient) = self.message_reply_attribution(index)
        {
            content = content.child(
                div()
                    .h_flex()
                    .flex_wrap()
                    .gap(px(T::ATTRIBUTION_GAP))
                    .mb(px(T::ATTRIBUTION_MARGIN_BOTTOM))
                    .text_size(px(T::META_SIZE))
                    .line_height(relative(T::REPLY_LINE_HEIGHT))
                    .text_color(p.muted)
                    .child(Icon::new(IconName::CornerDownLeft).size(px(T::REPLY_ICON)))
                    .child(recipient),
            );
        }
        if let Some(reply) = self.resolve_message_reply(message) {
            let target = reply.id.clone();
            let label = format!("Replying to {}", reply.sender);
            let preview = reply.text.chars().take(120).collect::<String>();
            let preview = if reply.text.chars().count() > 120 {
                format!("{preview}...")
            } else {
                preview
            };
            content = content.child(
                Button::new(SharedString::from(format!("{key}:reply-preview")))
                    .ghost()
                    .max_w_full()
                    .h_auto()
                    .min_h(px(T::REPLY_MIN_HEIGHT))
                    .self_start()
                    .mt_1()
                    .mb(px(T::REPLY_MARGIN_BOTTOM))
                    .py(px(T::REPLY_PADDING_Y))
                    .pl(px(T::REPLY_PADDING_LEFT))
                    .pr(px(T::REPLY_PADDING_RIGHT))
                    .rounded(px(T::REPLY_RADIUS))
                    .border_1()
                    .border_color(T::reply_border(p))
                    .bg(T::reply_fill(p))
                    .text_color(p.muted)
                    .accessibility_label(label.clone())
                    .child(
                        div()
                            .h_flex()
                            .min_w_0()
                            .gap(px(T::REPLY_GAP))
                            .text_size(px(T::TEXT_SIZE))
                            .line_height(relative(T::REPLY_LINE_HEIGHT))
                            .child(
                                Icon::new(IconName::MessageSquare)
                                    .size(px(T::REPLY_ICON))
                                    .flex_shrink_0(),
                            )
                            .child(
                                div()
                                    .flex_shrink_0()
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(p.text)
                                    .child(label),
                            )
                            .child(div().min_w_0().truncate().child(preview)),
                    )
                    .when_some(target, |this, target| {
                        this.on_click(cx.listener(move |this, _, _, cx| {
                            this.sidebar_state.search_target = Some(target.clone());
                            this.reveal_search_target(cx);
                        }))
                    }),
            );
        }
        if !message.thinking.is_empty() {
            content = content.child(self.render_reasoning(&key, index, &message.thinking, cx));
        }
        if !message.tools.is_empty() {
            content =
                content.child(self.render_tool_group(&key, index, &message.tools, streaming, cx));
        }
        for (part_index, part) in message.ordered_content().into_iter().enumerate() {
            match part {
                MessageContent::Text(text) if !text.is_empty() => {
                    let markdown = self.render_message_markdown(
                        format!("{key}:text:{part_index}"),
                        index,
                        &text,
                        user,
                        streaming,
                        cx,
                    );
                    content = content.child(
                        div()
                            .max_w_full()
                            .when(user, |this| {
                                this.bg(bubble)
                                    .border_1()
                                    .border_color(transparent_black())
                                    .rounded(px(T::BUBBLE_RADIUS))
                                    .px(px(T::BUBBLE_PADDING_X))
                                    .py(px(T::BUBBLE_PADDING_Y))
                            })
                            .when(!user, |this| this.w_full().py(px(T::ASSISTANT_PADDING_Y)))
                            .child(markdown),
                    );
                }
                MessageContent::Attachment(attachment) => {
                    if let Some(attachment) = message.attachments.get(attachment) {
                        content = content.child(self.render_message_attachment(attachment, cx));
                    }
                }
                MessageContent::Media(media) => {
                    if let Some(media) = message.media.get(media) {
                        content = content.child(self.render_message_media(
                            &format!("{key}:media:{part_index}"),
                            media,
                            cx,
                        ));
                    }
                }
                _ => {}
            }
        }
        if message.pending {
            content = content.child(div().text_xs().text_color(p.muted).child("Sending…"));
        }
        if let Some(error) = &message.send_error {
            let retry = message.send_id.clone().unwrap_or_default();
            let discard = retry.clone();
            content = content.child(
                div()
                    .h_flex()
                    .gap_2()
                    .text_xs()
                    .text_color(p.danger)
                    .child(div().flex_1().child(format!("Not sent · {error}")))
                    .child(
                        Button::new(SharedString::from(format!("retry-{key}")))
                            .ghost()
                            .small()
                            .label("Retry")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.retry_send(retry.clone(), cx)
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("discard-{key}")))
                            .ghost()
                            .small()
                            .label("Discard")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.discard_send(discard.clone(), cx)
                            })),
                    ),
            );
        }
        if !streaming && !message.text.is_empty() {
            let focus = self
                .transcript_state
                .footer_focus
                .entry(key.clone())
                .or_insert_with(|| cx.focus_handle())
                .clone();
            let copy_key = key.clone();
            let source = message.text.clone();
            let copied = self
                .transcript_state
                .copied
                .get(&key)
                .map(|(copied, _)| *copied);
            let metadata_key = format!("{key}:metadata");
            let details_open = self.transcript_state.expanded.contains(&metadata_key);
            let feedback = copied.is_some() || details_open;
            let reply = ReplyTarget {
                id: message.entry_id.clone().or_else(|| message.id.clone()),
                text: source.clone(),
                sender: author.clone(),
            };
            let mut actions = div()
                .h_flex()
                .gap_1()
                .child(
                    Button::new(SharedString::from(format!("reply-{key}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::MessageSquare)
                        .text_color(p.muted)
                        .accessibility_label("Reply to message")
                        .tooltip("Reply to message")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.start_message_reply(reply.clone(), window, cx)
                        })),
                )
                .child(
                    Button::new(SharedString::from(format!("copy-{key}")))
                        .ghost()
                        .xsmall()
                        .icon(if copied == Some(true) {
                            IconName::Check
                        } else {
                            IconName::Copy
                        })
                        .text_color(match copied {
                            Some(true) => p.ok,
                            Some(false) => p.danger,
                            None => p.muted,
                        })
                        .tooltip(match copied {
                            Some(true) => "Copied",
                            Some(false) => "Copy failed — try again",
                            None => "Copy message",
                        })
                        .accessibility_label(match copied {
                            Some(true) => "Copied",
                            Some(false) => "Copy failed — try again",
                            None => "Copy message",
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.copy_transcript_text(copy_key.clone(), source.clone(), cx)
                        })),
                );
            if let Some(entry) = message.entry_id.clone().filter(|_| user) {
                actions = actions.child(
                    Button::new(SharedString::from(format!("fork-{key}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::GitFork)
                        .text_color(p.muted)
                        .accessibility_label("Fork from here")
                        .tooltip("Fork from here")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.fork_message(entry.clone(), window, cx)
                        })),
                );
            }
            let info = self.message_metadata(index, message);
            let details = cx.entity().downgrade();
            let timestamp = super::components::popover(
                SharedString::from(format!("{key}:timestamp")),
                Anchor::BottomLeft,
                details_open,
                Button::new(SharedString::from(format!("{key}:timestamp-button")))
                    .ghost()
                    .xsmall()
                    .text_color(p.muted)
                    .label(relative_timestamp(message.timestamp))
                    .tooltip(info.clone()),
                div()
                    .max_w(px(T::DETAIL_WIDTH))
                    .text_size(px(T::META_SIZE))
                    .child(info)
                    .into_any_element(),
                move |open, _, cx| {
                    let _ = details.update(cx, |this, cx| {
                        if open {
                            this.transcript_state.expanded.insert(metadata_key.clone());
                        } else {
                            this.transcript_state.expanded.remove(&metadata_key);
                        }
                        cx.notify();
                    });
                },
            )
            .appearance(true);
            let controls = div()
                .id(SharedString::from(format!("{key}:controls")))
                .track_focus(&focus)
                .h_flex()
                .flex_wrap()
                .gap(px(T::FOOTER_GAP))
                .opacity(if feedback || focus.contains_focused(window, cx) {
                    1.
                } else {
                    0.
                })
                .hover(|this| this.opacity(1.))
                .group_hover(SharedString::from(key.clone()), |this| this.opacity(1.))
                .when(ends_group && !user, |this| {
                    this.child(
                        div()
                            .text_size(px(T::META_SIZE))
                            .text_color(p.muted)
                            .child(author.clone()),
                    )
                });
            let controls = if user {
                controls
                    .child(actions)
                    .when(ends_group, |this| this.child(timestamp))
            } else {
                controls
                    .when(ends_group, |this| this.child(timestamp))
                    .child(actions)
            };
            content = content.child(
                div()
                    .id(SharedString::from(format!("{key}:footer")))
                    .w_full()
                    .h_flex()
                    .flex_wrap()
                    .gap(px(T::FOOTER_GAP))
                    .min_h(px(T::FOOTER_HEIGHT))
                    .when(own, |this| this.justify_end())
                    .when(ends_group && !own && persistent_identity, |this| {
                        this.child(
                            div()
                                .text_size(px(T::META_SIZE))
                                .text_color(author_color)
                                .font_weight(FontWeight::MEDIUM)
                                .child(author.clone()),
                        )
                        .child(
                            div()
                                .text_size(px(T::META_SIZE))
                                .text_color(p.muted)
                                .child(source_label.clone()),
                        )
                    })
                    .child(controls)
                    .when(ends_group && own && persistent_identity, |this| {
                        this.child(
                            div()
                                .text_size(px(T::META_SIZE))
                                .text_color(author_color)
                                .font_weight(FontWeight::MEDIUM)
                                .child(author),
                        )
                        .child(
                            div()
                                .text_size(px(T::META_SIZE))
                                .text_color(p.muted)
                                .child(source_label),
                        )
                    }),
            );
        }
        div()
            .w_full()
            .flex()
            .items_start()
            .pl(px(T::ROW_INSET))
            .pr(px(if own {
                T::OWN_TRAILING_INSET
            } else {
                T::ASSISTANT_TRAILING_INSET
            }))
            .gap(px(T::AVATAR_GAP))
            .pt(px(if index == 0 {
                T::FIRST_TURN_INSET
            } else if group {
                T::TURN_GAP
            } else {
                T::CONTINUATION_GAP
            }))
            .when(own, |this| this.justify_end())
            .when(!own, |this| {
                this.child(self.render_message_avatar_slot(
                    message,
                    if user { ends_group } else { group },
                    cx,
                ))
            })
            .child(content)
            .when(own, |this| {
                this.child(self.render_message_avatar_slot(
                    message,
                    if user { ends_group } else { group },
                    cx,
                ))
            })
            .into_any_element()
    }

    fn render_message_avatar_slot(&self, message: &Message, show: bool, cx: &App) -> AnyElement {
        div()
            .w(px(T::AVATAR))
            .flex_shrink_0()
            .when(show, |this| {
                this.child(self.render_message_avatar(message, cx))
            })
            .into_any_element()
    }

    fn render_message_avatar(&self, message: &Message, cx: &App) -> AnyElement {
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        let render_avatar = |spec: &avatars::AvatarSpec| {
            super::components::avatar::Avatar::new(
                spec,
                &self.sidebar_state.avatars,
                super::theme::tokens::AvatarMetrics {
                    diameter: px(T::AVATAR),
                    text_size: px(
                        if matches!(spec.fallback, avatars::AvatarFallback::Initials { .. }) {
                            T::AVATAR_INITIALS_SIZE
                        } else {
                            T::AVATAR_TEXT_SIZE
                        },
                    ),
                    border: super::theme::tokens::space::NONE,
                },
            )
            .initials_weight(super::theme::tokens::weight::SEMIBOLD)
            .text_fallback_background(Palette::get(cx).elevated)
            .into_any_element()
        };
        if message.role == "user" {
            if message.sender_person.is_none()
                && message.sender.is_none()
                && message
                    .source_clients
                    .as_array()
                    .is_some_and(|sources| !sources.is_empty())
            {
                return div().into_any_element();
            }
            let fallback = Person {
                name: Some("You".into()),
                ..Default::default()
            };
            let person = message
                .sender_person
                .as_ref()
                .or(self.sidebar_state.people.self_user.as_ref())
                .unwrap_or(&fallback);
            let mut avatar = avatars::person_avatar(person, gateway);
            if message.sender_person.is_none() {
                // Unattributed local messages use the local display-name fallback,
                // while keeping the same admitted profile-image route and cache.
                avatar.fallback = avatars::person_avatar(
                    &Person {
                        name: Some(person.label().to_owned()),
                        ..Default::default()
                    },
                    gateway,
                )
                .fallback;
            }
            return render_avatar(&avatar);
        }
        let agent_id = message
            .sender_agent
            .as_deref()
            .or(self.chat.selected_agent.as_deref());
        if let Some(agent) = self
            .sidebar_state
            .agents
            .iter()
            .find(|agent| Some(agent.id.as_str()) == agent_id)
        {
            return render_avatar(&avatars::agent_avatar(
                &agent.id,
                agent.identity.avatar.as_deref(),
                agent.identity.avatar_url.as_deref(),
                agent.identity.emoji.as_deref(),
                gateway,
            ));
        }
        if message.sender_agent.is_some() {
            return div().into_any_element();
        }
        render_avatar(&avatars::AvatarSpec {
            url: None,
            fallback: avatars::AvatarFallback::Text(self.selected_agent_avatar()),
        })
    }

    pub(super) fn render_message_attachment(
        &mut self,
        attachment: &Attachment,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        if let Some(format) = ImageFormat::from_mime_type(&attachment.mime_type) {
            let image = self
                .transcript_state
                .images
                .entry(attachment.id.clone())
                .or_insert_with(|| Arc::new(Image::from_bytes(format, attachment.bytes.to_vec())))
                .clone();
            return img(image)
                .max_w(px(T::MEDIA_IMAGE_MAX))
                .max_h(px(T::MEDIA_IMAGE_MAX))
                .object_fit(ObjectFit::Contain)
                .rounded(px(T::MEDIA_IMAGE_RADIUS))
                .into_any_element();
        }
        div()
            .h_flex()
            .gap_2()
            .rounded_md()
            .border_1()
            .border_color(p.border)
            .bg(p.card)
            .p_2()
            .child(
                div()
                    .v_flex()
                    .gap_1()
                    .child(div().text_sm().child(attachment.file_name.clone()))
                    .child(
                        div()
                            .text_xs()
                            .text_color(p.muted)
                            .child(attachment.size_label()),
                    ),
            )
            .child(self.render_attachment_download(attachment, cx))
            .into_any_element()
    }
}

fn message_key(message: &Message, index: usize, streaming: bool) -> String {
    if streaming {
        return format!("stream:{}", message.run_id.as_deref().unwrap_or_default());
    }
    if let Some(id) = message.id.as_ref().or(message.send_id.as_ref()) {
        return format!("message:{id}");
    }
    let mut hasher = DefaultHasher::new();
    message.text.hash(&mut hasher);
    message.role.hash(&mut hasher);
    message.timestamp.hash(&mut hasher);
    format!("message:{index}:{}", hasher.finish())
}
