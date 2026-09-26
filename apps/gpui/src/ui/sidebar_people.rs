pub(super) use super::sidebar_person_hover::PersonHoverCard;

use super::{AppView, theme::Palette};
use crate::model::{
    people::{OnlinePerson, PeopleState, card_sessions},
    sessions::SessionRow,
};
use gpui_kit::{
    assets::IconName,
    component::{Icon, StyledExt, Theme, tooltip::Tooltip},
    prelude::FluentBuilder,
    *,
};
use serde_json::{Value, json};

impl AppView {
    pub(super) fn sidebar_people_connected(&mut self, hello: &Value, cx: &mut Context<Self>) {
        let instance_id = self.sidebar_state.people.instance_id.take();
        self.sidebar_state.people = PeopleState {
            instance_id,
            ..Default::default()
        };
        self.sidebar_state.avatars = Default::default();
        if let Some(snapshot) = hello.get("snapshot") {
            self.sidebar_state.people.apply_presence(snapshot);
        }
        self.refresh_sidebar_avatars(cx);
        self.request("users.self", json!({}), cx, |this, result, cx| {
            if let Ok(profile) = result {
                this.sidebar_state.people.apply_self_profile(&profile);
                this.refresh_sidebar_avatars(cx);
            }
        });
    }

    pub(super) fn sidebar_presence(&mut self, payload: &Value, cx: &mut Context<Self>) {
        self.sidebar_state.people.apply_presence(payload);
        self.refresh_sidebar_avatars(cx);
        cx.notify();
    }

    pub(super) fn people_section(&self, cx: &mut Context<Self>) -> AnyElement {
        let people = self.sidebar_state.people.online_people();
        if people.is_empty() {
            return div().into_any_element();
        }
        let p = Palette::sidebar(cx);
        let collapsed = if self.sidebar_state.preferences.all_agents {
            self.sidebar_state.preferences.people_collapsed_roster
        } else {
            self.sidebar_state.preferences.people_collapsed
        };
        let mut header = div()
            .id("online-people-toggle")
            .h(px(24.))
            .pl(px(8.))
            .pr(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .cursor_pointer()
            .text_color(p.muted)
            .text_size(px(11.))
            .line_height(relative(1.55))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.change_sidebar_preferences(
                    |preferences| {
                        if preferences.all_agents {
                            preferences.people_collapsed_roster =
                                !preferences.people_collapsed_roster;
                        } else {
                            preferences.people_collapsed = !preferences.people_collapsed;
                        }
                    },
                    cx,
                )
            }))
            .child(
                div()
                    .w(px(20.))
                    .h(px(16.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        Icon::new(if collapsed {
                            IconName::ChevronRight
                        } else {
                            IconName::ChevronDown
                        })
                        .size(px(11.))
                        .opacity(0.75),
                    ),
            )
            .child(
                div()
                    .h_flex()
                    .gap(px(0.88))
                    .font_weight(FontWeight(650.))
                    .children(
                        "ONLINE"
                            .chars()
                            .map(|letter| div().child(letter.to_string())),
                    ),
            );
        if collapsed {
            header = header
                .child(div().flex_1())
                .child(self.online_facepile(&people, 2, cx));
        }
        let mut section = div()
            .id("sidebar-online")
            .v_flex()
            .gap(px(4.))
            .mt(px(12.))
            .mb(px(10.))
            .pt(px(12.))
            .pr(px(8.))
            .border_t_1()
            .border_color(p.border.opacity(0.64))
            .child(header);
        if !collapsed {
            let mut list = div().v_flex().gap(px(2.));
            for person in people {
                let p = Palette::sidebar(cx);
                let id = person.person.key();
                let route = person.person.profile_id().map(person_activity_path);
                let title = person.person.label().to_owned();
                let idle = person.idle();
                let row = div()
                    .id(SharedString::from(format!("online:{id}")))
                    .group(SharedString::from(format!("online-row:{id}")))
                    .h(px(30.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(10.))
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.hover.opacity(0.84)))
                    .when(idle, |this| this.opacity(0.45))
                    .child(self.render_person_avatar(&person.person, 20., cx))
                    .child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .line_height(relative(1.55))
                            .child(title.clone()),
                    )
                    .child(
                        div()
                            .size(px(13.))
                            .opacity(0.)
                            .group_hover(SharedString::from(format!("online-row:{id}")), |style| {
                                style.opacity(1.)
                            })
                            .text_color(p.muted)
                            .child(Icon::new(IconName::ChevronRight).size(px(13.))),
                    )
                    .when_some(route, |this, route| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            this.open_control_page(&route, &title, window, cx)
                        }))
                    });
                let view = cx.entity().downgrade();
                list = list.child(PersonHoverCard::new(
                    SharedString::from(format!("person-card:{id}")),
                    row,
                    move |_, cx| {
                        let Some(entity) = view.upgrade() else {
                            return div().into_any_element();
                        };
                        let this = entity.read(cx);
                        let current = this
                            .sidebar_state
                            .people
                            .online_people()
                            .into_iter()
                            .find(|current| current.person.key() == id);
                        current
                            .map(|person| this.person_card(&person, view.clone(), cx))
                            .unwrap_or_else(|| div().into_any_element())
                    },
                ));
            }
            section = section.child(list);
        }
        section.into_any_element()
    }

    pub(super) fn online_facepile(
        &self,
        people: &[OnlinePerson],
        limit: usize,
        cx: &App,
    ) -> AnyElement {
        let p = Palette::sidebar(cx);
        let mut pile = div().ml(px(1.)).flex().items_center();
        for (index, person) in people.iter().take(limit).enumerate() {
            let label = person.person.label().to_owned();
            pile = pile.child(
                div()
                    .id(SharedString::from(format!(
                        "online-face:{}",
                        person.person.key()
                    )))
                    .when(index > 0, |this| this.ml(px(-5.)))
                    .rounded_full()
                    .child(self.render_person_avatar(&person.person, 18., cx))
                    .tooltip(move |window, cx| Tooltip::new(label.clone()).build(window, cx)),
            );
        }
        if people.len() > limit {
            let names = people
                .iter()
                .skip(limit)
                .map(|person| person.person.label())
                .collect::<Vec<_>>()
                .join("\n");
            pile = pile.child(
                div()
                    .id("online-face-overflow")
                    .ml(px(-5.))
                    .size(px(18.))
                    .rounded_full()
                    .bg(p.elevated)
                    .border_1()
                    .border_color(p.sidebar)
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_size(px(8.))
                    .text_color(p.muted)
                    .child(format!("+{}", people.len() - limit))
                    .tooltip(move |window, cx| Tooltip::new(names.clone()).build(window, cx)),
            );
        }
        pile.into_any_element()
    }

    pub(super) fn person_card(
        &self,
        person: &OnlinePerson,
        view: WeakEntity<Self>,
        cx: &App,
    ) -> AnyElement {
        let p = Palette::sidebar(cx);
        let now = crate::model::chat::now_ms();
        let offline = person.entries.is_empty();
        let status = if offline {
            "Offline".into()
        } else {
            person
                .online_since()
                .map(|since| format!("Online for {}", elapsed(now.saturating_sub(since), true)))
                .unwrap_or_else(|| "Online".into())
        };
        let dark = Theme::global(cx).is_dark();
        let surface = if dark {
            p.card.blend(Hsla {
                a: 0.06,
                ..rgb(0).into()
            })
        } else {
            p.card
        };
        let header = div()
            .h_flex()
            .items_center()
            .gap(px(10.))
            .px(px(16.))
            .pt(px(15.))
            .pb(px(12.))
            .child(self.render_person_avatar_on(&person.person, 34.5, 12., surface, cx))
            .child(
                div()
                    .v_flex()
                    .gap(px(4.))
                    .min_w_0()
                    .child(
                        div()
                            .text_size(px(14.))
                            .line_height(relative(1.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(person.person.label().to_owned()),
                    )
                    .child(
                        div()
                            .h_flex()
                            .gap(px(3.))
                            .text_size(px(12.))
                            .line_height(relative(1.))
                            .text_color(p.muted)
                            .child(div().size(px(6.)).rounded_full().bg(if offline {
                                p.muted
                            } else {
                                p.ok
                            }))
                            .child(status),
                    ),
            );
        let mut card = div()
            .w_full()
            .v_flex()
            .text_size(px(12.))
            .line_height(relative(1.5))
            .text_color(p.text)
            .child(header);
        if person.person.id == "gateway-owner" {
            card = card.child(
                div()
                    .px(px(16.))
                    .pb(px(12.))
                    .text_color(p.muted)
                    .child("A shared Gateway identity. Multiple people may use this account."),
            );
        }
        if !offline {
            let mut facts = div().v_flex().gap(px(12.)).px(px(16.)).pb(px(16.));
            let connections = person.connections();
            let zones = person.time_zones();
            if !connections.is_empty() || !zones.is_empty() {
                let mut values = div().v_flex().gap(px(3.)).flex_1().min_w_0();
                for connection in connections {
                    values = values.child(div().font_weight(FontWeight::MEDIUM).child(connection));
                }
                for zone in zones {
                    values = values.child(
                        div()
                            .text_size(px(11.))
                            .text_color(p.muted)
                            .child(format!("Reported time zone: {zone}")),
                    );
                }
                facts = facts.child(
                    div()
                        .h_flex()
                        .items_start()
                        .gap(px(8.))
                        .child(
                            div()
                                .w(px(80.))
                                .flex_shrink_0()
                                .text_color(p.muted)
                                .child("Where"),
                        )
                        .child(values),
                );
            }
            card = card.child(
                facts.child(
                    div()
                        .h_flex()
                        .items_start()
                        .gap(px(8.))
                        .child(
                            div()
                                .w(px(80.))
                                .flex_shrink_0()
                                .text_color(p.muted)
                                .child("Last activity"),
                        )
                        .child(
                            div().flex_1().min_w_0().child(
                                person
                                    .last_activity_at()
                                    .map(|at| {
                                        format!("{} ago", elapsed(now.saturating_sub(at), false))
                                    })
                                    .unwrap_or_else(|| "Not observed yet".into()),
                            ),
                        ),
                ),
            );
        }
        let rows: Vec<_> = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .cloned()
            .collect();
        let (viewing, recent) = card_sessions(
            person,
            &rows,
            self.sidebar_state
                .selected_agent
                .as_deref()
                .unwrap_or("main"),
        );
        if !viewing.is_empty() {
            card = card.child(person_card_sessions(
                "Viewing now",
                viewing,
                view.clone(),
                p,
            ));
        }
        card = card.child(person_card_sessions(
            "Recent sessions",
            recent,
            view.clone(),
            p,
        ));
        if let Some(profile) = person.person.profile_id() {
            let route = person_activity_path(profile);
            let title = person.person.label().to_owned();
            card = card.child(
                div()
                    .id("person-view-activity")
                    .px(px(16.))
                    .py(px(8.))
                    .min_h(px(37.))
                    .font_weight(FontWeight::MEDIUM)
                    .border_t_1()
                    .border_color(p.border)
                    .flex()
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.hover))
                    .child("View activity")
                    .child(Icon::new(IconName::ChevronRight).size(px(14.)))
                    .on_click(move |_, window, cx| {
                        let _ = view.update(cx, |this, cx| {
                            this.open_control_page(&route, &title, window, cx)
                        });
                    }),
            );
        }
        card.into_any_element()
    }
}

fn person_card_sessions(
    label: &'static str,
    rows: Vec<SessionRow>,
    view: WeakEntity<AppView>,
    p: Palette,
) -> AnyElement {
    let mut section = div()
        .v_flex()
        .px(px(16.))
        .py(px(12.))
        .border_t_1()
        .border_color(p.border)
        .child(
            div()
                .mb(px(6.))
                .text_size(px(12.))
                .text_color(p.muted)
                .child(label),
        );
    if rows.is_empty() {
        return section
            .child(div().text_color(p.muted).child("No recent sessions"))
            .into_any_element();
    }
    for (index, row) in rows.into_iter().enumerate() {
        let key = row.key.clone();
        let age = row.updated_at.map(|at| {
            elapsed(
                crate::model::chat::now_ms().saturating_sub(at as u64),
                false,
            )
        });
        let view = view.clone();
        section = section.child(
            div()
                .id(SharedString::from(format!("card-session:{label}:{key}")))
                .mt(px(if index == 0 { 0. } else { 2. }))
                .p(px(6.))
                .mx(px(-6.))
                .rounded(px(6.))
                .flex()
                .items_center()
                .gap(px(8.))
                .cursor_pointer()
                .hover(move |style| style.bg(p.hover))
                .child(
                    Icon::new(IconName::MessageSquare)
                        .size(px(14.))
                        .text_color(p.muted),
                )
                .child(
                    div()
                        .flex_1()
                        .overflow_hidden()
                        .text_ellipsis()
                        .font_weight(FontWeight::MEDIUM)
                        .child(row.title()),
                )
                .when_some(age, |this, age| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(11.))
                            .text_color(p.muted)
                            .child(age),
                    )
                })
                .on_click(move |_, window, cx| {
                    let _ =
                        view.update(cx, |this, cx| this.select_session(key.clone(), window, cx));
                }),
        );
    }
    section.into_any_element()
}

fn person_activity_path(profile: &str) -> String {
    format!(
        "/activity/{}",
        percent_encoding::utf8_percent_encode(profile, percent_encoding::NON_ALPHANUMERIC)
    )
}

fn elapsed(ms: u64, minutes: bool) -> String {
    let seconds = ms / 1000;
    if seconds >= 86_400 {
        format!("{}d", seconds / 86_400)
    } else if seconds >= 3_600 {
        format!("{}h", seconds / 3_600)
    } else if seconds >= 60 || minutes {
        format!("{}m", (seconds / 60).max(1))
    } else {
        format!("{seconds}s")
    }
}
