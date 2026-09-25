use super::{AppView, theme::Palette};
use crate::model::{
    people::{OnlinePerson, PeopleState, card_sessions},
    sessions::SessionRow,
};
use gpui_kit::{
    assets::IconName,
    component::{Icon, StyledExt, hover_card::HoverCard, tooltip::Tooltip},
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
        let p = Palette::get(cx);
        let collapsed = self.sidebar_state.preferences.people_collapsed;
        let mut header = div()
            .id("online-people-toggle")
            .h(px(30.))
            .px(px(8.))
            .flex()
            .items_center()
            .gap(px(7.))
            .cursor_pointer()
            .rounded(px(6.))
            .hover(move |style| style.bg(p.hover))
            .text_color(p.muted)
            .text_size(px(12.))
            .on_click(cx.listener(move |this, _, _, cx| {
                this.change_sidebar_preferences(
                    |preferences| preferences.people_collapsed = !collapsed,
                    cx,
                )
            }))
            .child(
                Icon::new(if collapsed {
                    IconName::ChevronRight
                } else {
                    IconName::ChevronDown
                })
                .size(px(12.)),
            )
            .child("Online");
        if collapsed {
            header = header
                .child(div().flex_1())
                .child(self.online_facepile(&people, 2, cx));
        }
        let mut section = div()
            .id("sidebar-online")
            .v_flex()
            .gap(px(2.))
            .mt(px(8.))
            .child(header);
        if !collapsed {
            for person in people {
                let p = Palette::get(cx);
                let id = person.person.key();
                let route = person.person.profile_id().map(person_activity_path);
                let title = person.person.label().to_owned();
                let idle = person.idle();
                let row = div()
                    .id(SharedString::from(format!("online:{id}")))
                    .h(px(30.))
                    .px(px(8.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.hover))
                    .when(idle, |this| this.opacity(0.45))
                    .child(self.person_presence_avatar(&person, 20., cx))
                    .child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .text_ellipsis()
                            .text_size(px(13.))
                            .child(title.clone()),
                    )
                    .child(
                        Icon::new(IconName::ChevronRight)
                            .size(px(12.))
                            .text_color(p.muted),
                    )
                    .when_some(route, |this, route| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            this.open_control_page(&route, &title, window, cx)
                        }))
                    });
                let view = cx.entity().downgrade();
                section = section.child(
                    HoverCard::new(SharedString::from(format!("person-card:{id}")))
                        .anchor(Anchor::TopLeft)
                        .trigger(row)
                        .content(move |_, _, cx| {
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
                        }),
                );
            }
        }
        section.into_any_element()
    }

    pub(super) fn online_facepile(
        &self,
        people: &[OnlinePerson],
        limit: usize,
        cx: &App,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let mut pile = div().flex().items_center();
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
                    .border_1()
                    .border_color(p.sidebar)
                    .child(self.person_presence_avatar(person, 18., cx))
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

    fn person_presence_avatar(&self, person: &OnlinePerson, size: f32, cx: &App) -> AnyElement {
        let p = Palette::get(cx);
        div()
            .relative()
            .size(px(size))
            .flex_shrink_0()
            .child(self.render_person_avatar(&person.person, size, cx))
            .child(
                div()
                    .absolute()
                    .bottom(px(-1.))
                    .right(px(-1.))
                    .size(px(6.))
                    .rounded_full()
                    .border_1()
                    .border_color(p.sidebar)
                    .bg(if person.idle() { p.muted } else { p.ok }),
            )
            .into_any_element()
    }

    pub(super) fn person_card(
        &self,
        person: &OnlinePerson,
        view: WeakEntity<Self>,
        cx: &App,
    ) -> AnyElement {
        let p = Palette::get(cx);
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
        let header = div()
            .flex()
            .items_center()
            .gap(px(10.))
            .child(self.render_person_avatar(&person.person, 32., cx))
            .child(
                div()
                    .v_flex()
                    .gap(px(3.))
                    .child(
                        div()
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(p.strong)
                            .child(person.person.label().to_owned()),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .text_size(px(11.))
                            .text_color(p.muted)
                            .child(div().size(px(5.)).rounded_full().bg(if offline {
                                p.muted
                            } else {
                                p.ok
                            }))
                            .child(status),
                    ),
            );
        let mut card = div()
            .w(px(292.))
            .p(px(14.))
            .v_flex()
            .gap(px(12.))
            .text_size(px(12.))
            .text_color(p.text)
            .child(header);
        if person.person.id == "gateway-owner" {
            card = card.child(
                div()
                    .text_color(p.muted)
                    .child("A shared Gateway identity. Multiple people may use this account."),
            );
        }
        let connections = person.connections();
        let zones = person.time_zones();
        if !connections.is_empty() || !zones.is_empty() {
            let mut facts = div()
                .v_flex()
                .gap(px(4.))
                .child(div().text_color(p.muted).text_size(px(11.)).child("Where"));
            for connection in connections {
                facts = facts.child(connection);
            }
            for zone in zones {
                facts = facts.child(
                    div()
                        .text_color(p.muted)
                        .text_size(px(10.))
                        .child(format!("Reported time zone: {zone}")),
                );
            }
            card = card.child(facts);
        }
        if !offline {
            card = card.child(
                div()
                    .v_flex()
                    .gap(px(4.))
                    .child(
                        div()
                            .text_color(p.muted)
                            .text_size(px(11.))
                            .child("Last activity"),
                    )
                    .child(
                        person
                            .last_activity_at()
                            .map(|at| format!("{} ago", elapsed(now.saturating_sub(at), false)))
                            .unwrap_or_else(|| "Not observed yet".into()),
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
                    .pt(px(8.))
                    .border_t_1()
                    .border_color(p.border)
                    .flex()
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .hover(move |style| style.text_color(p.accent))
                    .child("View activity")
                    .child(Icon::new(IconName::ChevronRight).size(px(12.)))
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
        .gap(px(5.))
        .child(div().text_size(px(11.)).text_color(p.muted).child(label));
    if rows.is_empty() {
        return section
            .child(div().text_color(p.muted).child("No recent sessions"))
            .into_any_element();
    }
    for row in rows {
        let key = row.key.clone();
        let age = row.updated_at.map(|at| {
            format!(
                "{} ago",
                elapsed(
                    crate::model::chat::now_ms().saturating_sub(at as u64),
                    false
                )
            )
        });
        let view = view.clone();
        section = section.child(
            div()
                .id(SharedString::from(format!("card-session:{label}:{key}")))
                .px(px(5.))
                .py(px(4.))
                .rounded(px(5.))
                .flex()
                .items_center()
                .gap(px(6.))
                .cursor_pointer()
                .hover(move |style| style.bg(p.hover))
                .child(Icon::new(IconName::MessageCircle).size(px(13.)))
                .child(
                    div()
                        .flex_1()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(row.title()),
                )
                .when_some(age, |this, age| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(10.))
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
