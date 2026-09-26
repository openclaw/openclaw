use super::{
    AppView,
    components::{
        facepile::{self, FacepileItem},
        hover_card::{HoverCard, HoverCardDismiss},
        list::{list_row, section_header, section_header_content},
    },
    theme::{
        Palette,
        tokens::{
            InsetsExt, TypographyExt, avatar, card, colors, header, icon, opacity, radius, row,
            space, text,
        },
    },
};
use crate::model::{
    avatars,
    elapsed_time::{ElapsedFormat, format_elapsed},
    people::{OnlinePerson, PeopleState, card_sessions},
    sessions::SessionRow,
};
use gpui_kit::{
    assets::IconName,
    component::{Icon, StyledExt, Theme},
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
        let mut header_content = section_header_content()
            .child(
                div()
                    .w(icon::LEADING)
                    .h(space::XXL)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        Icon::new(if collapsed {
                            IconName::ChevronRight
                        } else {
                            IconName::ChevronDown
                        })
                        .size(icon::SECTION)
                        .opacity(opacity::DISCLOSURE),
                    ),
            )
            .child(
                div()
                    .h_flex()
                    .gap(header::ONLINE_TRACKING)
                    .typography(text::SECTION)
                    .children(
                        "ONLINE"
                            .chars()
                            .map(|letter| div().child(letter.to_string())),
                    ),
            );
        if collapsed {
            header_content = header_content
                .child(div().flex_1())
                .child(self.online_facepile(&people, 2, cx));
        }
        let header = section_header("online-people-toggle", "Online")
            .border_0()
            .h(header::SECTION_HEIGHT)
            .pl(space::MD)
            .pr(space::LG)
            .flex()
            .items_center()
            .gap(space::MD)
            .cursor_pointer()
            .text_color(p.muted)
            .typography(text::SECTION)
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
            .child(header_content);
        let mut section = div()
            .id("sidebar-online")
            .v_flex()
            .gap(space::XS)
            .mt(space::XL)
            .mb(space::LG)
            .pt(space::XL)
            .pr(space::MD)
            .border_t(space::HAIRLINE)
            .border_color(colors::section_border(p))
            .child(header);
        if !collapsed {
            let mut list = div().v_flex().gap(space::XXS);
            for person in people {
                let p = Palette::sidebar(cx);
                let id = person.person.key();
                let route = person.person.profile_id().map(person_activity_path);
                let title = person.person.label().to_owned();
                let idle = person.idle();
                let row = list_row(SharedString::from(format!("online:{id}")), row::PERSON)
                    .role(if route.is_some() {
                        Role::Button
                    } else {
                        Role::Group
                    })
                    .aria_label(title.clone())
                    .group(SharedString::from(format!("online-row:{id}")))
                    .h(row::PERSON.min_height)
                    .px(space::MD)
                    .flex()
                    .items_center()
                    .gap(space::MD)
                    .rounded(radius::PERSON)
                    .cursor_pointer()
                    .hover(move |style| style.bg(colors::navigation_hover(p)))
                    .when(idle, |this| this.opacity(opacity::IDLE))
                    .child(self.render_person_avatar(&person.person, avatar::PERSON, cx))
                    .child(
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .text_ellipsis()
                            .typography(text::NAV)
                            .child(title.clone()),
                    )
                    .when_some(route, |this, route| {
                        this.on_click(cx.listener(move |this, _, window, cx| {
                            this.open_control_page(&route, &title, window, cx)
                        }))
                    });
                let view = cx.entity().downgrade();
                let trigger_id = id.clone();
                list = list.child(HoverCard::new(
                    SharedString::from(format!("person-card:{id}")),
                    move |open| {
                        row.child(
                            div()
                                .size(icon::COMPACT)
                                .opacity(if open {
                                    opacity::VISIBLE
                                } else {
                                    opacity::HIDDEN
                                })
                                .group_hover(
                                    SharedString::from(format!("online-row:{trigger_id}")),
                                    |style| style.opacity(opacity::VISIBLE),
                                )
                                .text_color(p.muted)
                                .child(Icon::new(IconName::ChevronRight).size(icon::COMPACT)),
                        )
                        .into_any_element()
                    },
                    move |dismiss, _, cx| {
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
                            .map(|person| {
                                this.person_card(&person, view.clone(), dismiss.clone(), cx)
                            })
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
        let gateway = self
            .web
            .auth
            .as_ref()
            .map(|auth| auth.gateway_url.as_str())
            .unwrap_or("");
        let items = people
            .iter()
            .map(|person| FacepileItem {
                key: format!("online-face:{}", person.person.key()),
                label: person.person.label().to_owned(),
                avatar: avatars::person_avatar(&person.person, gateway),
            })
            .collect::<Vec<_>>();
        facepile::facepile(
            &items,
            &self.sidebar_state.avatars,
            limit,
            people.len(),
            Palette::sidebar(cx).sidebar,
            cx,
        )
    }

    pub(super) fn person_card(
        &self,
        person: &OnlinePerson,
        view: WeakEntity<Self>,
        dismiss: HoverCardDismiss,
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
                .map(|since| {
                    format!(
                        "Online for {}",
                        format_elapsed(now.saturating_sub(since), ElapsedFormat::MinuteCompact)
                    )
                })
                .unwrap_or_else(|| "Online".into())
        };
        let dark = Theme::global(cx).is_dark();
        let surface = colors::hover_card_surface(p, dark);
        let header = div()
            .h_flex()
            .items_center()
            .gap(space::LG)
            .insets(card::HEADER_PADDING)
            .child(self.render_person_avatar_on(&person.person, avatar::PERSON_CARD, surface))
            .child(
                div()
                    .v_flex()
                    .gap(space::XS)
                    .min_w_0()
                    .child(
                        div()
                            .typography(text::PERSON_CARD_NAME)
                            .child(person.person.label().to_owned()),
                    )
                    .child(
                        div()
                            .h_flex()
                            .gap(space::TIGHT)
                            .typography(text::PERSON_CARD_STATUS)
                            .text_color(p.muted)
                            .child(div().size(icon::DOT).rounded_full().bg(if offline {
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
            .typography(text::PERSON_CARD_BODY)
            .text_color(p.text)
            .child(header);
        if person.person.id == "gateway-owner" {
            card = card.child(
                div()
                    .px(space::XXL)
                    .pb(space::XL)
                    .text_color(p.muted)
                    .child("A shared Gateway identity. Multiple people may use this account."),
            );
        }
        if !offline {
            let mut facts = div().v_flex().gap(space::XL).px(space::XXL).pb(space::XXL);
            let connections = person.connections();
            let zones = person.time_zones();
            if !connections.is_empty() || !zones.is_empty() {
                let mut values = div().v_flex().gap(space::TIGHT).flex_1().min_w_0();
                for connection in connections {
                    values =
                        values.child(div().typography(text::PERSON_CARD_LINK).child(connection));
                }
                for zone in zones {
                    values = values.child(
                        div()
                            .typography(text::PERSON_CARD_AGE)
                            .text_color(p.muted)
                            .child(format!("Reported time zone: {zone}")),
                    );
                }
                facts = facts.child(
                    div()
                        .h_flex()
                        .items_start()
                        .gap(space::MD)
                        .child(
                            div()
                                .w(card::FACT_LABEL_WIDTH)
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
                        .gap(space::MD)
                        .child(
                            div()
                                .w(card::FACT_LABEL_WIDTH)
                                .flex_shrink_0()
                                .text_color(p.muted)
                                .child("Last activity"),
                        )
                        .child(
                            div().flex_1().min_w_0().child(
                                person
                                    .last_activity_at()
                                    .map(|at| {
                                        format!(
                                            "{} ago",
                                            format_elapsed(
                                                now.saturating_sub(at),
                                                ElapsedFormat::Compact
                                            )
                                        )
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
                dismiss.clone(),
                p,
            ));
        }
        card = card.child(person_card_sessions(
            "Recent sessions",
            recent,
            view.clone(),
            dismiss.clone(),
            p,
        ));
        if let Some(profile) = person.person.profile_id() {
            let route = person_activity_path(profile);
            let title = person.person.label().to_owned();
            card = card.child(
                div()
                    .id("person-view-activity")
                    .px(space::XXL)
                    .py(space::MD)
                    .min_h(card::FOOTER_MIN_HEIGHT)
                    .typography(text::PERSON_CARD_LINK)
                    .border_t(space::HAIRLINE)
                    .border_color(p.border)
                    .flex()
                    .items_center()
                    .justify_between()
                    .cursor_pointer()
                    .hover(move |style| style.bg(p.hover))
                    .child("View activity")
                    .child(Icon::new(IconName::ChevronRight).size(icon::ACTION))
                    .on_click(move |_, window, cx| {
                        dismiss.dismiss(window, cx);
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
    dismiss: HoverCardDismiss,
    p: Palette,
) -> AnyElement {
    let mut section = div()
        .v_flex()
        .insets(card::SECTION_PADDING)
        .border_t(space::HAIRLINE)
        .border_color(p.border)
        .child(
            div()
                .mb(space::SM)
                .typography(text::PERSON_CARD_BODY)
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
            format_elapsed(
                crate::model::chat::now_ms().saturating_sub(at as u64),
                ElapsedFormat::SingleUnit,
            )
        });
        let view = view.clone();
        let dismiss = dismiss.clone();
        section = section.child(
            div()
                .id(SharedString::from(format!("card-session:{label}:{key}")))
                .mt(if index == 0 { space::NONE } else { space::XXS })
                .p(space::SM)
                .mx(-space::SM)
                .rounded(radius::SMALL)
                .flex()
                .items_center()
                .gap(space::MD)
                .cursor_pointer()
                .hover(move |style| style.bg(p.hover))
                .child(
                    Icon::new(IconName::MessageSquare)
                        .size(icon::ACTION)
                        .text_color(p.muted),
                )
                .child(
                    div()
                        .flex_1()
                        .overflow_hidden()
                        .text_ellipsis()
                        .typography(text::PERSON_CARD_LINK)
                        .child(row.title()),
                )
                .when_some(age, |this, age| {
                    this.child(
                        div()
                            .flex_shrink_0()
                            .typography(text::PERSON_CARD_AGE)
                            .text_color(p.muted)
                            .child(age),
                    )
                })
                .on_click(move |_, window, cx| {
                    dismiss.dismiss(window, cx);
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
