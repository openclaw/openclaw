use super::{
    AppView,
    theme::Palette,
    transcript_state::{code_markdown_extensions, transcript_text_style},
};
use crate::model::chat::{Message, now_ms};
use crate::ui::theme::tokens::{conversation as t, radius, space, text, weight};
use gpui_kit::{
    component::{
        IconName, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::TextView,
        tooltip::Tooltip,
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
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let key = message_key(message, index, streaming);
        if message.system {
            return div()
                .w_full()
                .py(space::REM_ROOMY)
                .h_flex()
                .gap(space::REM_MD)
                .text_size(text::WIDGET_XS_SIZE)
                .text_color(p.muted)
                .child(div().flex_1().h(space::HAIRLINE).bg(p.border))
                .child(
                    div()
                        .max_w(t::SYSTEM_MESSAGE_MAX_WIDTH)
                        .child(message.text.clone()),
                )
                .child(div().flex_1().h(space::HAIRLINE).bg(p.border))
                .into_any_element();
        }
        let user = message.role == "user";
        let author = message.sender.clone().unwrap_or_else(|| {
            if user {
                "You".into()
            } else {
                self.selected_agent_name()
            }
        });
        let timestamp = relative_time(message.timestamp);
        let exact = message
            .timestamp
            .map(exact_time)
            .unwrap_or_else(|| "Current response".into());
        let info = format!(
            "{author} · {exact}\n{}\n{} input · {} output tokens",
            message.model.as_deref().unwrap_or("Default model"),
            message.usage.input,
            message.usage.output
        );
        let link_view = cx.entity().downgrade();
        let media_view = link_view.clone();
        let markdown = self.markdown_state(key.clone(), &message.text, cx);
        let thinking_key = format!("{key}:thinking");
        let thinking_open = streaming || self.transcript_state.expanded.contains(&thinking_key);
        let mut content = div()
            .group(SharedString::from(key.clone()))
            .relative()
            .v_flex()
            .w_full()
            .min_w(space::NONE)
            .gap(space::REM_SM)
            .text_size(t::MESSAGE_TEXT_SIZE)
            .line_height(relative(t::MESSAGE_LINE_HEIGHT))
            .pb(space::REM_XS)
            .when(user, |this| {
                this.max_w(relative(t::USER_WIDTH_RATIO)).items_end()
            });
        if !message.thinking.is_empty() {
            let toggle = thinking_key.clone();
            let thinking = self.markdown_state(thinking_key.clone(), &message.thinking, cx);
            content = content.child(
                div()
                    .v_flex()
                    .gap(space::REM_SM)
                    .text_color(p.muted)
                    .child(
                        Button::new(SharedString::from(thinking_key))
                            .ghost()
                            .small()
                            .label(if thinking_open {
                                "⌄ Thinking"
                            } else {
                                "› Thinking"
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.transcript_state.expanded.remove(&toggle) {
                                    this.transcript_state.expanded.insert(toggle.clone());
                                }
                                this.transcript_list.remeasure_items(index..index + 1);
                                cx.notify();
                            })),
                    )
                    .when(thinking_open, |this| {
                        this.child(
                            div()
                                .border_l(space::XXS)
                                .border_color(p.border)
                                .pl(space::REM_MD)
                                .text_size(text::WIDGET_SM_SIZE)
                                .child(
                                    TextView::new(&thinking)
                                        .style(transcript_text_style(p))
                                        .markdown_extensions(code_markdown_extensions())
                                        .selectable(true)
                                        .scrollable(false),
                                ),
                        )
                    }),
            );
        }
        if !message.tools.is_empty() {
            content =
                content.child(self.render_tool_group(&key, index, &message.tools, streaming, cx));
        }
        if !message.text.is_empty() {
            content = content.child(
                div()
                    .max_w_full()
                    .when(user, |this| {
                        this.bg(p.user_bubble)
                            .rounded(radius::CONTROL)
                            .p(space::REM_LG)
                    })
                    .when(!user, |this| this.w_full().py(space::REM_XS))
                    .child(
                        TextView::new(&markdown)
                            .style(transcript_text_style(p))
                            .markdown_extensions(code_markdown_extensions())
                            .selectable(true)
                            .scrollable(false)
                            .stream_fade(streaming)
                            .on_link_click(move |url, _, _, cx| {
                                let _ = link_view
                                    .update(cx, |this, cx| this.open_transcript_link(url, cx));
                            }),
                    ),
            );
        }
        if !message.attachments.is_empty() {
            content = content.child(div().flex().flex_wrap().gap(space::REM_SM).children(
                message.attachments.iter().map(|attachment| {
                    let mut chip = div()
                        .h_flex()
                        .gap(space::REM_SM)
                        .rounded(radius::WIDGET_MD)
                        .border(space::HAIRLINE)
                        .border_color(p.border)
                        .bg(p.card)
                        .p(space::REM_SM);
                    let format = match attachment.mime_type.as_str() {
                        "image/png" => Some(ImageFormat::Png),
                        "image/jpeg" => Some(ImageFormat::Jpeg),
                        "image/gif" => Some(ImageFormat::Gif),
                        "image/webp" => Some(ImageFormat::Webp),
                        _ => None,
                    };
                    if let Some(format) = format {
                        chip = chip.child(
                            img(self
                                .transcript_state
                                .images
                                .entry(attachment.id.clone())
                                .or_insert_with(|| {
                                    Arc::new(Image::from_bytes(format, attachment.bytes.to_vec()))
                                })
                                .clone())
                            .size(t::ATTACHMENT_SIZE)
                            .object_fit(ObjectFit::Cover)
                            .rounded(radius::WIDGET_MD),
                        );
                    } else {
                        chip = chip.child(div().text_size(t::ATTACHMENT_GLYPH_SIZE).child("▤"));
                    }
                    chip.child(
                        div()
                            .v_flex()
                            .gap(space::REM_XS)
                            .child(
                                div()
                                    .text_size(text::WIDGET_SM_SIZE)
                                    .child(attachment.file_name.clone()),
                            )
                            .child(
                                div()
                                    .text_size(text::WIDGET_XS_SIZE)
                                    .text_color(p.muted)
                                    .child(attachment.size_label()),
                            ),
                    )
                }),
            ));
        }
        if !message.media.is_empty() && message.attachments.is_empty() {
            content = content.child(div().flex().flex_wrap().gap(space::REM_SM).children(
                message.media.iter().map(|media| {
                    let name = media
                        .file_name
                        .clone()
                        .or_else(|| {
                            media
                                .path
                                .as_deref()
                                .and_then(|path| path.rsplit('/').next())
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| "Attachment".into());
                    let size = media
                        .size_bytes
                        .map(|size| format!(" · {:.1} KB", size as f64 / 1024.))
                        .unwrap_or_default();
                    div()
                        .px(space::REM_MD)
                        .py(space::REM_SM)
                        .rounded(radius::WIDGET_MD)
                        .border(space::HAIRLINE)
                        .border_color(p.border)
                        .bg(p.card)
                        .text_size(text::WIDGET_SM_SIZE)
                        .child(format!("▤ {name}{size}"))
                        .when_some(
                            media.url.clone().filter(|url| {
                                url.starts_with("https://") || url.starts_with("http://")
                            }),
                            |this, url| {
                                let view = media_view.clone();
                                this.child(
                                    Button::new(SharedString::from(format!("media-{url}")))
                                        .ghost()
                                        .xsmall()
                                        .label("Open")
                                        .on_click(move |_, _, cx| {
                                            let _ = view.update(cx, |this, cx| {
                                                this.open_transcript_link(&url, cx)
                                            });
                                        }),
                                )
                            },
                        )
                }),
            ));
        }
        if message.pending {
            content = content.child(
                div()
                    .text_size(text::WIDGET_XS_SIZE)
                    .text_color(p.muted)
                    .child("Sending…"),
            );
        }
        if let Some(error) = &message.send_error {
            let retry = message.send_id.clone().unwrap_or_default();
            let discard = retry.clone();
            content = content.child(
                div()
                    .h_flex()
                    .gap(space::REM_SM)
                    .text_size(text::WIDGET_XS_SIZE)
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
            let ends_group = self
                .chat
                .messages
                .get(index + 1..)
                .and_then(|remaining| remaining.iter().find(|next| next.visible()))
                .is_none_or(|next| crate::model::grouping::starts_group(Some(message), next));
            let source = message.text.clone();
            content = content.child(
                div()
                    .id(SharedString::from(format!("{key}:actions")))
                    .absolute()
                    .h_flex()
                    .h(t::MESSAGE_ACTION_HEIGHT)
                    .gap(space::REM_XS)
                    .rounded(radius::WIDGET_SM)
                    .bg(p.bg)
                    .when(ends_group, |this| {
                        this.bottom(-t::MESSAGE_ACTION_HEIGHT)
                            .when(user, |this| this.right(space::NONE))
                            .when(!user, |this| this.left(space::NONE))
                    })
                    .when(!ends_group, |this| this.top(space::NONE).right(space::NONE))
                    .opacity(0.)
                    .hover(|this| this.opacity(1.))
                    .group_hover(SharedString::from(key.clone()), |this| this.opacity(1.))
                    .child(
                        Button::new(SharedString::from(format!("copy-{key}")))
                            .ghost()
                            .xsmall()
                            .icon(IconName::Copy)
                            .tooltip("Copy message")
                            .on_click(move |_, _, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(source.clone()))
                            }),
                    )
                    .when_some(message.entry_id.clone().filter(|_| user), |this, entry| {
                        this.child(
                            Button::new(SharedString::from(format!("fork-{key}")))
                                .ghost()
                                .xsmall()
                                .label("Fork from here")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.fork_message(entry.clone(), window, cx)
                                })),
                        )
                    })
                    .child(
                        div()
                            .id(SharedString::from(format!("{key}:timestamp")))
                            .text_size(text::WIDGET_XS_SIZE)
                            .text_color(p.muted)
                            .child(timestamp)
                            .tooltip(move |window, cx| {
                                Tooltip::new(info.clone()).build(window, cx)
                            }),
                    ),
            );
        }
        div()
            .w_full()
            .flex()
            .items_start()
            .pl(space::XS)
            .pr(if user {
                space::XXL
            } else {
                t::ASSISTANT_END_INSET
            })
            .gap(space::LG)
            .pt(if group {
                t::MESSAGE_GROUP_GAP
            } else {
                space::XXS
            })
            .when(user, |this| this.justify_end())
            .when(!user, |this| {
                this.child(
                    div()
                        .w(t::MESSAGE_AVATAR_SIZE)
                        .flex_shrink_0()
                        .when(group, |this| {
                            this.child(
                                div()
                                    .size(t::MESSAGE_AVATAR_SIZE)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .border(space::HAIRLINE)
                                    .border_color(p.border)
                                    .bg(p.panel_strong)
                                    .text_size(t::EDITOR_TEXT_SIZE)
                                    .font_weight(weight::SEMIBOLD)
                                    .text_color(p.strong)
                                    .child(self.selected_agent_avatar()),
                            )
                        }),
                )
            })
            .child(content)
            .when(user, |this| {
                this.child(div().w(t::MESSAGE_AVATAR_SIZE).flex_shrink_0())
            })
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
fn relative_time(timestamp: Option<u64>) -> String {
    let Some(timestamp) = timestamp else {
        return String::new();
    };
    let seconds = now_ms().saturating_sub(timestamp) / 1000;
    match seconds {
        0..60 => "Just now".into(),
        60..3600 => format!("{}m ago", seconds / 60),
        3600..86400 => format!("{}h ago", seconds / 3600),
        86400..604800 => format!("{}d ago", seconds / 86400),
        _ => exact_time(timestamp)
            .split(' ')
            .next()
            .unwrap_or_default()
            .to_owned(),
    }
}

fn exact_time(timestamp: u64) -> String {
    // Gregorian civil date from Unix days, with no locale or process timezone mutation.
    let seconds = timestamp / 1000;
    let days = (seconds / 86400) as i64 + 719468;
    let era = days / 146097;
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02} UTC",
        seconds / 3600 % 24,
        seconds / 60 % 60,
        seconds % 60
    )
}
