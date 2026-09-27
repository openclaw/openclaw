use super::{
    AppView,
    theme::{Palette, tokens::transcript::TranscriptSurfaceTokens as T},
};
use crate::model::chat::Message;
use gpui_kit::{
    assets::IconName,
    component::{
        Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        text::TextView,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn render_system_notice(
        &mut self,
        index: usize,
        key: &str,
        message: &Message,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let notice = message.notice.as_ref();
        let compaction = notice.is_some_and(|notice| notice.compaction);
        let title = notice
            .map(|notice| notice.label.as_str())
            .unwrap_or("System");
        let metric = notice
            .and_then(|notice| notice.saved_tokens)
            .map(|count| format!("saved {} tokens", compact_tokens(count)));
        let mut body = div()
            .v_flex()
            .w_full()
            .items_center()
            .gap(px(T::NOTICE_GAP))
            .my(px(T::NOTICE_MARGIN))
            .text_size(px(T::SMALL_TEXT))
            .line_height(relative(1.4))
            .text_color(p.muted)
            .child(system_line(title, metric, compaction, false, cx));
        let text = notice
            .and_then(|notice| notice.body.as_deref())
            .unwrap_or(&message.text)
            .trim_start_matches("[System] ");
        if !text.is_empty() {
            let toggle_key = format!("{key}:notice");
            let collapsed = notice.is_some_and(|notice| notice.collapsed);
            let expanded = !collapsed || self.transcript_state.expanded.contains(&toggle_key);
            if collapsed {
                body = body.child(
                    Button::new(SharedString::from(toggle_key.clone()))
                        .ghost()
                        .small()
                        .icon(if expanded {
                            IconName::ChevronDown
                        } else {
                            IconName::ChevronRight
                        })
                        .label("Show content")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if !this.transcript_state.expanded.remove(&toggle_key) {
                                this.transcript_state.expanded.insert(toggle_key.clone());
                            }
                            this.transcript_list.remeasure_items(index..index + 1);
                            cx.notify();
                        })),
                );
            }
            if expanded {
                let markdown = self.markdown_state(format!("{key}:notice-body"), text, cx);
                body = body.child(
                    div()
                        .w_full()
                        .max_w(px(T::NOTICE_WIDTH))
                        .child(TextView::new(&markdown).selectable(true).scrollable(false)),
                );
            }
        }
        body.into_any_element()
    }

    pub(super) fn render_run_error(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let Some(note) = self.chat.note.as_ref().filter(|note| note.error) else {
            return div().into_any_element();
        };
        let p = Palette::get(cx);
        let detail = self.chat.error_detail.clone();
        let full = format!(
            "{}{}",
            note.text,
            detail
                .as_ref()
                .map(|text| format!("\n{text}"))
                .unwrap_or_default()
        );
        let summary = note.text.clone();
        let expanded = self.transcript_state.error_expanded;
        div()
            .w_full()
            .flex()
            .justify_center()
            .px(px(T::SCROLL_ICON))
            .mt(px(T::SCROLL_OFFSET))
            .child(
                div()
                    .v_flex()
                    .w_full()
                    .max_w(px(T::ERROR_WIDTH))
                    .gap(px(T::RULE_GAP))
                    .px(px(T::ERROR_INSET_X))
                    .py(px(T::ERROR_INSET_Y))
                    .rounded(px(T::ERROR_RADIUS))
                    .border_1()
                    .border_color(p.border.blend(Hsla {
                        a: T::ERROR_BORDER_ALPHA,
                        ..p.danger
                    }))
                    .bg(p.elevated.blend(Hsla {
                        a: T::ERROR_FILL_ALPHA,
                        ..p.danger
                    }))
                    .text_size(px(T::BODY_TEXT))
                    .text_color(p.strong)
                    .child(
                        div()
                            .h_flex()
                            .gap(px(T::RULE_GAP))
                            .child(
                                Icon::new(IconName::CircleAlert)
                                    .size(px(T::SCROLL_ICON))
                                    .text_color(p.danger),
                            )
                            .child(div().flex_1().min_w_0().child(summary))
                            .when(detail.is_some(), |this| {
                                this.child(
                                    Button::new("error-details")
                                        .ghost()
                                        .xsmall()
                                        .icon(if expanded {
                                            IconName::ChevronUp
                                        } else {
                                            IconName::ChevronDown
                                        })
                                        .label("Details")
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            this.transcript_state.error_expanded =
                                                !this.transcript_state.error_expanded;
                                            cx.notify();
                                        })),
                                )
                            })
                            .child(
                                Button::new("dismiss-run-error")
                                    .ghost()
                                    .xsmall()
                                    .icon(IconName::X)
                                    .tooltip("Dismiss error")
                                    .accessibility_label("Dismiss error")
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.chat.note = None;
                                        this.chat.error_detail = None;
                                        this.transcript_state.error_expanded = false;
                                        this.sync_transcript();
                                        cx.notify();
                                    })),
                            ),
                    )
                    .when(expanded, |this| {
                        this.child(
                            div()
                                .id("run-error-diagnostic")
                                .max_h(px(T::ERROR_DETAILS_HEIGHT))
                                .overflow_y_scroll()
                                .child(detail.unwrap_or_default()),
                        )
                        .child(
                            Button::new("copy-error")
                                .ghost()
                                .xsmall()
                                .label("Copy diagnostic")
                                .on_click(move |_, _, cx| {
                                    cx.write_to_clipboard(ClipboardItem::new_string(full.clone()))
                                }),
                        )
                    }),
            )
            .into_any_element()
    }
}

pub(super) fn system_line(
    title: &str,
    metric: Option<String>,
    compaction: bool,
    active: bool,
    cx: &App,
) -> AnyElement {
    let p = Palette::get(cx);
    div()
        .h_flex()
        .w_full()
        .gap(px(T::RULE_GAP))
        .text_color(p.muted)
        .text_size(px(if compaction {
            T::BODY_TEXT
        } else {
            T::SMALL_TEXT
        }))
        .child(div().flex_1().h(px(T::RULE_WIDTH)).bg(p.border))
        .when(compaction, |this| {
            this.child(super::components::activity_mark::compaction_mark(
                active, cx,
            ))
        })
        .when(!compaction, |this| {
            this.child(Icon::new(IconName::Cpu).size(px(T::BODY_TEXT)))
        })
        .font_weight(if compaction {
            FontWeight::NORMAL
        } else {
            FontWeight::SEMIBOLD
        })
        .child(if compaction {
            title.to_owned()
        } else {
            title.to_uppercase()
        })
        .when_some(metric, |this, metric| this.child("·").child(metric))
        .child(div().flex_1().h(px(T::RULE_WIDTH)).bg(p.border))
        .into_any_element()
}

fn compact_tokens(count: u64) -> String {
    if count >= 1_000_000 {
        format!("{:.1}M", count as f64 / 1_000_000.)
    } else if count >= 1_000 {
        format!("{:.1}k", count as f64 / 1_000.)
    } else {
        count.to_string()
    }
}
