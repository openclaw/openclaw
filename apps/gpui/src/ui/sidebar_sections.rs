use super::{AppView, theme::Palette};
use crate::model::{
    people::{OnlinePerson, Person},
    sessions::SessionRow,
    sidebar::{self, SECTION_PAGE_SIZE, SidebarSection},
    sidebar_pr,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        hover_card::HoverCard,
        menu::{DropdownMenu, PopupMenuItem},
    },
    prelude::FluentBuilder,
    *,
};
use serde_json::json;

impl AppView {
    fn projected_sections(&self, rows: &[SessionRow], main: &str) -> Vec<SidebarSection> {
        let adopted = crate::model::sidebar_catalog::adopted_keys(
            &self.sidebar_state.catalogs.catalogs,
            &self.sidebar_state.preferences.hidden_catalogs,
            self.sidebar_state.preferences.all_agents
                || self.sidebar_state.preferences.archive == sidebar::ArchiveFilter::Archived,
        );
        let rows: Vec<_> = rows
            .iter()
            .filter(|row| !adopted.contains(&row.key))
            .cloned()
            .collect();
        let mut preferences = self.sidebar_state.preferences.clone();
        if preferences.all_agents {
            preferences.grouping = sidebar::Grouping::None;
        }
        let mut sections = sidebar::sections(
            &rows,
            &preferences,
            main,
            self.sidebar_state
                .people
                .self_user
                .as_ref()
                .map(|p| p.id.as_str()),
            &self.sidebar_state.created_order,
        );
        if preferences.all_agents {
            for section in &mut sections {
                section.render_header = false;
            }
        }
        sections
    }
    pub(super) fn sidebar_session_sections(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let mut content = div().v_flex().gap(px(2.));
        if self.sidebar_state.preferences.all_agents {
            for agent in &self.sidebar_state.agents {
                let id = agent.id.clone();
                let scope = format!("agent:{id}");
                let main = format!("agent:{id}:{}", self.sidebar_state.main_key);
                let rows: Vec<_> = self
                    .rows
                    .iter()
                    .filter(|row| row.agent() == Some(&id))
                    .cloned()
                    .collect();
                let collapsed = self
                    .sidebar_state
                    .preferences
                    .collapsed_sections
                    .contains(&scope);
                let attention = rows.iter().any(|row| {
                    !row.archived
                        && self.sidebar_attention(row)
                            != crate::model::sidebar_activity::SidebarAttention::None
                });
                let running = rows
                    .iter()
                    .any(|row| !row.archived && row.display_running());
                let unread = rows.iter().any(|row| !row.archived && row.unread);
                let toggle = scope.clone();
                let agent_id = id.clone();
                let new_agent = id.clone();
                let menu_agent = id.clone();
                let menu_main = main.clone();
                let view = cx.entity().downgrade();
                content = content.child(
                    div()
                        .h_flex()
                        .pt(px(10.))
                        .gap(px(4.))
                        .child(
                            Button::new(SharedString::from(format!("agent-section:{id}")))
                                .ghost()
                                .small()
                                .size(px(20.))
                                .h(px(34.))
                                .justify_start()
                                .gap(px(7.))
                                .icon(
                                    Icon::new(if collapsed {
                                        IconName::ChevronRight
                                    } else {
                                        IconName::ChevronDown
                                    })
                                    .size(px(12.)),
                                )
                                .accessibility_label(format!(
                                    "{} {}",
                                    if collapsed { "Expand" } else { "Collapse" },
                                    agent.name()
                                ))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.toggle_sidebar_section(&toggle, cx)
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("agent-home:{id}")))
                                .ghost()
                                .small()
                                .flex_1()
                                .min_w_0()
                                .justify_start()
                                .gap(px(7.))
                                .h(px(34.))
                                .child(self.render_agent_avatar(agent, 24., cx))
                                .label(agent.name().to_owned())
                                .when(attention || running || unread, |el| {
                                    el.child(
                                        Icon::new(if attention {
                                            IconName::Hand
                                        } else if running {
                                            IconName::LoaderCircle
                                        } else {
                                            IconName::Circle
                                        })
                                        .size(px(12.))
                                        .text_color(if attention { p.danger } else { p.accent }),
                                    )
                                })
                                .accessibility_label(format!("{} Home", agent.name()))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.sidebar_state.selected_agent = Some(agent_id.clone());
                                    this.select_session(main.clone(), window, cx);
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("agent-new:{id}")))
                                .ghost()
                                .small()
                                .size(px(24.))
                                .icon(Icon::new(IconName::Plus).size(px(14.)))
                                .accessibility_label(format!("New conversation: {}", agent.name()))
                                .disabled(self.session.is_none())
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.sidebar_state.selected_agent = Some(new_agent.clone());
                                    this.sidebar_state.agent_revision += 1;
                                    this.new_chat(window, cx);
                                })),
                        )
                        .child(
                            Button::new(SharedString::from(format!("agent-options:{id}")))
                                .ghost()
                                .small()
                                .size(px(24.))
                                .icon(Icon::new(IconName::Ellipsis).size(px(14.)))
                                .accessibility_label(format!("Agent options: {}", agent.name()))
                                .dropdown_menu(move |menu, _, _| {
                                    let home_view = view.clone();
                                    let agent = menu_agent.clone();
                                    let main = menu_main.clone();
                                    let sessions_view = view.clone();
                                    let collapse_view = view.clone();
                                    let keep = menu_agent.clone();
                                    menu.item(PopupMenuItem::new("Open main chat").on_click(
                                        move |_, window, cx| {
                                            let _ = home_view.update(cx, |this, cx| {
                                                this.sidebar_state.selected_agent =
                                                    Some(agent.clone());
                                                this.select_session(main.clone(), window, cx);
                                            });
                                        },
                                    ))
                                    .item(PopupMenuItem::new("All sessions…").on_click(
                                        move |_, window, cx| {
                                            let _ = sessions_view.update(cx, |this, cx| {
                                                this.open_control_page(
                                                    "/sessions",
                                                    "Sessions",
                                                    window,
                                                    cx,
                                                )
                                            });
                                        },
                                    ))
                                    .separator()
                                    .item(
                                        PopupMenuItem::new("Collapse other agents").on_click(
                                            move |_, _, cx| {
                                                let _ = collapse_view.update(cx, |this, cx| {
                                                    let ids: Vec<_> = this
                                                        .sidebar_state
                                                        .agents
                                                        .iter()
                                                        .map(|agent| agent.id.clone())
                                                        .collect();
                                                    for id in ids {
                                                        let key = format!("agent:{id}");
                                                        if id == keep {
                                                            this.sidebar_state
                                                                .preferences
                                                                .collapsed_sections
                                                                .remove(&key);
                                                        } else {
                                                            this.sidebar_state
                                                                .preferences
                                                                .collapsed_sections
                                                                .insert(key);
                                                        }
                                                    }
                                                    this.sidebar_state.preference_revision += 1;
                                                    this.persist_sidebar_preferences(cx);
                                                    this.sync_sidebar_pull_requests(cx);
                                                    this.sync_sidebar_activity(cx);
                                                    cx.notify();
                                                });
                                            },
                                        ),
                                    )
                                }),
                        ),
                );
                if !collapsed {
                    let main = format!("agent:{id}:{}", self.sidebar_state.main_key);
                    for section in self.projected_sections(&rows, &main) {
                        content = content.child(self.render_sidebar_section(&section, &scope, cx));
                    }
                }
            }
        } else {
            let sections = self.projected_sections(&self.rows, &self.agent_home());
            if sections.iter().all(|s| s.rows.is_empty()) {
                content = content.child(div().p_3().text_size(px(12.)).text_color(p.muted).child(
                    if self.roster_loading {
                        "Loading conversations…"
                    } else if self.sidebar_state.preferences.archive
                        == sidebar::ArchiveFilter::Archived
                    {
                        "No archived conversations."
                    } else if self.sidebar_state.preferences.filtered() {
                        "No conversations match these filters."
                    } else {
                        "No conversations yet. Start a new chat."
                    },
                ));
            }
            for section in sections {
                content = content.child(self.render_sidebar_section(&section, "", cx));
            }
        }
        content.into_any_element()
    }
    fn render_sidebar_section(
        &self,
        section: &SidebarSection,
        scope: &str,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let key = if scope.is_empty() {
            section.id.clone()
        } else {
            format!("{scope}/{}", section.id)
        };
        let collapsed = section.render_header
            && self
                .sidebar_state
                .preferences
                .collapsed_sections
                .contains(&key);
        let attention = section.rows.iter().any(|row| {
            !row.archived
                && (self.sidebar_attention(row)
                    != crate::model::sidebar_activity::SidebarAttention::None
                    || row.last_run_error.is_some()
                    || row
                        .child_sessions
                        .iter()
                        .any(|key| self.sidebar_state.attention.contains(key)))
        });
        let running = section
            .rows
            .iter()
            .any(|row| !row.archived && row.display_running());
        let mut content = div().v_flex().gap(px(2.));
        if section.render_header {
            let toggle = key.clone();
            let person = section.person_owner.as_ref().and_then(Person::from_actor);
            let online = person.as_ref().and_then(|person| {
                self.sidebar_state
                    .people
                    .online_people()
                    .into_iter()
                    .find(|online| online.person.key() == person.key())
            });
            let header = Button::new(SharedString::from(format!("section:{key}")))
                .ghost()
                .small()
                .flex_1()
                .min_w_0()
                .h(px(29.))
                .justify_start()
                .px(px(8.))
                .gap(px(6.))
                .icon(
                    Icon::new(if collapsed {
                        IconName::ChevronRight
                    } else {
                        IconName::ChevronDown
                    })
                    .size(px(12.)),
                )
                .when_some(person.clone(), |el, person| {
                    el.child(
                        div()
                            .relative()
                            .size(px(18.))
                            .child(self.render_person_avatar(&person, 18., cx))
                            .when_some(online.as_ref(), |el, online| {
                                el.child(
                                    div()
                                        .absolute()
                                        .bottom(px(-1.))
                                        .right(px(-1.))
                                        .size(px(6.))
                                        .rounded_full()
                                        .border_1()
                                        .border_color(p.sidebar)
                                        .bg(if online.idle() { p.muted } else { p.ok }),
                                )
                            }),
                    )
                })
                .child(
                    div()
                        .flex_1()
                        .text_size(px(11.))
                        .text_color(p.muted)
                        .child(section.label.clone()),
                )
                .when(collapsed, |el| {
                    el.child(
                        div()
                            .text_size(px(10.))
                            .text_color(p.muted)
                            .child(section.rows.len().to_string()),
                    )
                })
                .when(collapsed && (attention || running), |el| {
                    el.child(
                        Icon::new(if attention {
                            IconName::Hand
                        } else {
                            IconName::LoaderCircle
                        })
                        .size(px(12.))
                        .text_color(if attention {
                            p.danger
                        } else {
                            p.accent
                        }),
                    )
                })
                .on_click(
                    cx.listener(move |this, _, _, cx| this.toggle_sidebar_section(&toggle, cx)),
                );
            let card_person = person.as_ref().filter(|person| {
                person.profile_id().is_some()
                    && self
                        .sidebar_state
                        .people
                        .self_user
                        .as_ref()
                        .is_none_or(|own| own.key() != person.key())
            });
            let header = if let Some(person) = card_person {
                let person = person.clone();
                let view = cx.entity().downgrade();
                HoverCard::new(SharedString::from(format!("section-person:{key}")))
                    .anchor(Anchor::TopLeft)
                    .trigger(header)
                    .content(move |_, _, cx| {
                        let Some(entity) = view.upgrade() else {
                            return div().into_any_element();
                        };
                        let this = entity.read(cx);
                        let online = this
                            .sidebar_state
                            .people
                            .online_people()
                            .into_iter()
                            .find(|online| online.person.key() == person.key())
                            .unwrap_or_else(|| OnlinePerson {
                                person: person.clone(),
                                entries: Vec::new(),
                                watched_sessions: Vec::new(),
                            });
                        this.person_card(&online, view.clone(), cx)
                    })
                    .into_any_element()
            } else {
                header.into_any_element()
            };
            let new_group = section.id.strip_prefix("category:").map(str::to_owned);
            let supports_new_group = new_group.is_some() || section.id == "ungrouped";
            content = content.child(
                div()
                    .h_flex()
                    .child(header)
                    .when(supports_new_group, |el| {
                        el.child(
                            Button::new(SharedString::from(format!("group-new:{key}")))
                                .ghost()
                                .small()
                                .size(px(24.))
                                .icon(Icon::new(IconName::Plus).size(px(14.)))
                                .accessibility_label(format!("New chat in {}", section.label))
                                .disabled(self.session.is_none())
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.new_chat_in_group(new_group.clone(), window, cx)
                                })),
                        )
                    })
                    .when_some(person, |el, person| {
                        let id = person.id.clone();
                        let active =
                            self.sidebar_state.preferences.owner_id.as_deref() == Some(&id);
                        el.child(
                            Button::new(SharedString::from(format!("person-filter:{key}")))
                                .ghost()
                                .small()
                                .size(px(24.))
                                .icon(
                                    Icon::new(IconName::ListFilter)
                                        .size(px(12.))
                                        .text_color(if active { p.accent } else { p.muted }),
                                )
                                .accessibility_label(if active {
                                    "Show everyone".to_owned()
                                } else {
                                    format!("Show only {}", person.label())
                                })
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.change_sidebar_preferences(
                                        |prefs| {
                                            prefs.owner_id =
                                                if active { None } else { Some(id.clone()) };
                                            prefs.involving_me = false;
                                        },
                                        cx,
                                    )
                                })),
                        )
                    }),
            );
        }
        if !collapsed {
            let limit = self
                .sidebar_state
                .section_limits
                .get(&key)
                .copied()
                .unwrap_or(SECTION_PAGE_SIZE);
            let rows = sidebar::page_rows(section, limit, self.chat.selected_session.as_deref());
            for row in &rows {
                content = content.child(self.sidebar_row(row, 0, cx));
            }
            if rows.len() < section.rows.len() {
                let key = key.clone();
                content = content.child(
                    Button::new(SharedString::from(format!("section-more:{key}")))
                        .ghost()
                        .small()
                        .h(px(25.))
                        .label("Show more")
                        .text_size(px(11.))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.sidebar_state
                                .section_limits
                                .insert(key.clone(), limit + SECTION_PAGE_SIZE);
                            this.sync_sidebar_pull_requests(cx);
                            cx.notify();
                        })),
                );
            }
            if limit > 30 {
                let key = key.clone();
                content = content.child(
                    Button::new(SharedString::from(format!("section-less:{key}")))
                        .ghost()
                        .small()
                        .label("Show less")
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.sidebar_state.section_limits.remove(&key);
                            this.sidebar_state.selection.clear();
                            this.sync_sidebar_pull_requests(cx);
                            cx.notify();
                        })),
                );
            }
        }
        content.into_any_element()
    }
    pub(super) fn toggle_sidebar_section(&mut self, key: &str, cx: &mut Context<Self>) {
        if !self
            .sidebar_state
            .preferences
            .collapsed_sections
            .remove(key)
        {
            self.sidebar_state
                .preferences
                .collapsed_sections
                .insert(key.to_owned());
        }
        self.sidebar_state.preference_revision += 1;
        self.persist_sidebar_preferences(cx);
        self.sync_sidebar_pull_requests(cx);
        cx.notify();
    }
    pub(super) fn sidebar_visible_keys(&self) -> Vec<String> {
        let mut result = Vec::new();
        let groups: Vec<_> = if self.sidebar_state.preferences.all_agents {
            self.sidebar_state
                .agents
                .iter()
                .map(|agent| {
                    let rows = self
                        .rows
                        .iter()
                        .filter(|row| row.agent() == Some(&agent.id))
                        .cloned()
                        .collect::<Vec<_>>();
                    (
                        format!("agent:{}", agent.id),
                        format!("agent:{}:{}", agent.id, self.sidebar_state.main_key),
                        rows,
                    )
                })
                .collect()
        } else {
            vec![(String::new(), self.agent_home(), self.rows.clone())]
        };
        for (scope, main, rows) in groups {
            if !scope.is_empty()
                && self
                    .sidebar_state
                    .preferences
                    .collapsed_sections
                    .contains(&scope)
            {
                continue;
            }
            for section in self.projected_sections(&rows, &main) {
                let key = if scope.is_empty() {
                    section.id.clone()
                } else {
                    format!("{scope}/{}", section.id)
                };
                if section.render_header
                    && self
                        .sidebar_state
                        .preferences
                        .collapsed_sections
                        .contains(&key)
                {
                    continue;
                }
                let limit = self
                    .sidebar_state
                    .section_limits
                    .get(&key)
                    .copied()
                    .unwrap_or(SECTION_PAGE_SIZE);
                result.extend(
                    sidebar::page_rows(&section, limit, self.chat.selected_session.as_deref())
                        .iter()
                        .map(|row| row.key.clone()),
                );
            }
        }
        result
    }
    pub(super) fn sidebar_row_click(
        &mut self,
        key: String,
        event: &ClickEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let modifiers = event.modifiers();
        let visible = self.sidebar_visible_keys();
        if modifiers.shift && visible.contains(&key) {
            self.sidebar_state.selection.extend(
                &visible,
                &key,
                self.chat.selected_session.as_deref(),
            );
        } else if modifiers.platform && visible.contains(&key) {
            self.sidebar_state.selection.toggle(&key);
        } else {
            self.sidebar_state.selection.clear();
            self.sidebar_state.selection.anchor = Some(key.clone());
            if self.sidebar_state.preferences.all_agents {
                self.sidebar_state.selected_agent = self
                    .rows
                    .iter()
                    .find(|row| row.key == key)
                    .and_then(|row| row.agent().map(str::to_owned));
            }
            self.select_session(key, window, cx);
        }
        self.sidebar_state.list_focus.focus(window, cx);
        cx.notify();
    }
    pub(super) fn sync_sidebar_pull_requests(&mut self, cx: &mut Context<Self>) {
        let Some(session) = &self.session else {
            return;
        };
        let advertised = session
            .hello()
            .pointer("/features/methods")
            .and_then(|value| value.as_array())
            .is_some_and(|methods| {
                methods.iter().any(|method| {
                    method.as_str() == Some("controlUi.sessionPullRequests.subscribe")
                })
            });
        if !advertised {
            return;
        }
        let visible = self.sidebar_visible_keys();
        let keys = self
            .rows
            .iter()
            .filter(|row| {
                visible.contains(&row.key)
                    && row.worktree.as_ref().and_then(|v| v.get("id")).is_some()
            })
            .map(|row| sidebar_pr::scoped_key(&row.key, row.agent()))
            .collect();
        if self.sidebar_state.pull_requests.set_watched(keys) {
            let keys = self.sidebar_state.pull_requests.watched_keys();
            self.sidebar_state.pull_request_generation += 1;
            let generation = self.sidebar_state.pull_request_generation;
            self.request(
                "controlUi.sessionPullRequests.subscribe",
                json!({"sessionKeys":keys,"refreshSessionKeys":keys}),
                cx,
                move |this, result, _| {
                    if this.sidebar_state.pull_request_generation != generation {
                        return;
                    }
                    if let Err(error) = result {
                        if this.sidebar_state.pull_requests.watched_keys() == keys {
                            this.sidebar_state.pull_requests.clear();
                        }
                        this.mutation_error(format!(
                            "Could not subscribe to pull requests: {error}"
                        ));
                    }
                },
            );
        }
    }
}
