use super::{
    AppView,
    theme::{Palette, TranscriptSurfaceTokens as T},
};
use gpui_kit::{
    component::{
        StyledExt,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn transcript_welcome(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let mut rows: Vec<_> = self
            .rows
            .iter()
            .filter(|row| {
                !row.archived
                    && Some(&row.key) != self.chat.selected_session.as_ref()
                    && row.agent_id.as_ref().is_none_or(|agent| {
                        Some(agent) == self.sidebar_state.selected_agent.as_ref()
                    })
                    && row
                        .channel
                        .as_deref()
                        .is_none_or(|channel| channel == "webchat")
                    && row.spawned_by.is_none()
                    && !row.is_cron()
            })
            .collect();
        rows.sort_by(|a, b| {
            b.updated_at
                .unwrap_or_default()
                .total_cmp(&a.updated_at.unwrap_or_default())
                .then_with(|| a.key.cmp(&b.key))
        });
        let avatar = self
            .sidebar_state
            .agents
            .iter()
            .find(|agent| Some(&agent.id) == self.sidebar_state.selected_agent.as_ref())
            .map(|agent| self.render_agent_avatar(agent, T::WELCOME_AVATAR, cx))
            .unwrap_or_else(|| {
                div()
                    .text_size(px(T::WELCOME_TITLE))
                    .child(self.selected_agent_avatar())
                    .into_any_element()
            });
        div()
            .flex_1()
            .min_h_0()
            .flex()
            .justify_center()
            .items_center()
            .child(
                div()
                    .v_flex()
                    .w_full()
                    .max_w(px(T::WELCOME_WIDTH))
                    .items_center()
                    .gap(px(T::RULE_GAP))
                    .px(px(T::INSET))
                    .child(
                        div()
                            .v_flex()
                            .items_center()
                            .gap(px(T::WELCOME_GAP))
                            .child(avatar)
                            .child(
                                div()
                                    .v_flex()
                                    .items_center()
                                    .gap_2()
                                    .child(
                                        div()
                                            .text_size(px(T::WELCOME_TITLE))
                                            .font_weight(FontWeight::SEMIBOLD)
                                            .text_color(p.text)
                                            .child(self.selected_agent_name()),
                                    )
                                    .child(div().text_color(p.muted).child(if self.chat.loading {
                                        "Loading conversation…"
                                    } else {
                                        "Type a message below · / for commands"
                                    })),
                            ),
                    )
                    .when(!self.chat.loading && !rows.is_empty(), |this| {
                        this.child(
                            div()
                                .v_flex()
                                .w_full()
                                .max_w(px(T::RECENTS_WIDTH))
                                .mt(px(T::SCROLL_OFFSET))
                                .gap_0p5()
                                .child(
                                    div()
                                        .ml(px(T::SCROLL_OFFSET))
                                        .text_size(px(T::SMALL_TEXT))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(p.muted)
                                        .child("RECENT CHATS"),
                                )
                                .children(rows.into_iter().take(5).map(|row| {
                                    let key = row.key.clone();
                                    Button::new(SharedString::from(format!("recent-{key}")))
                                        .ghost()
                                        .accessibility_label(row.title())
                                        .w_full()
                                        .h(px(T::RECENT_HEIGHT))
                                        .rounded(px(T::RECENT_RADIUS))
                                        .child(
                                            div()
                                                .h_flex()
                                                .w_full()
                                                .gap_2()
                                                .text_size(px(T::BODY_TEXT))
                                                .child(
                                                    div()
                                                        .flex_1()
                                                        .min_w_0()
                                                        .truncate()
                                                        .text_left()
                                                        .font_weight(FontWeight::MEDIUM)
                                                        .child(row.title()),
                                                )
                                                .child(
                                                    div()
                                                        .text_size(px(T::SMALL_TEXT))
                                                        .text_color(p.muted)
                                                        .child(
                                                            crate::model::chat::relative_timestamp(
                                                                row.updated_at
                                                                    .map(|time| time as u64),
                                                            ),
                                                        ),
                                                ),
                                        )
                                        .on_click(cx.listener(move |this, _, window, cx| {
                                            this.select_session(key.clone(), window, cx)
                                        }))
                                })),
                        )
                    }),
            )
            .into_any_element()
    }
}
