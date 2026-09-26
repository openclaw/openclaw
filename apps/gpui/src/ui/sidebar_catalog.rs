use super::{
    AppView,
    components::{icons::icon, list::list_row},
    theme::{
        Palette,
        tokens::{self, header, opacity, radius, row, space, text},
    },
};
use crate::model::{
    sidebar::{ArchiveFilter, Grouping},
    sidebar_catalog::{self, Catalog, CatalogResult},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        menu::{ContextMenuExt, DropdownMenu, PopupMenuItem},
    },
    prelude::FluentBuilder,
    *,
};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Default)]
pub(super) struct SidebarCatalogState {
    pub catalogs: Vec<Catalog>,
    pub loading: bool,
    pub error: Option<String>,
    generation: u64,
    agent: Option<String>,
    pending_refresh: bool,
    paging: HashSet<String>,
    limits: HashMap<String, usize>,
}

impl AppView {
    pub(super) fn refresh_sidebar_catalogs(&mut self, cx: &mut Context<Self>) {
        let supported = self.session.as_ref().is_some_and(|session| {
            session.hello()["features"]["methods"]
                .as_array()
                .is_some_and(|methods| {
                    methods
                        .iter()
                        .any(|method| method.as_str() == Some("sessions.catalog.list"))
                })
        });
        if !supported {
            self.sidebar_state.catalogs = SidebarCatalogState::default();
            return;
        }
        let agent = self.sidebar_state.selected_agent.clone();
        if self.sidebar_state.catalogs.agent != agent {
            let generation = self.sidebar_state.catalogs.generation + 1;
            self.sidebar_state.catalogs = SidebarCatalogState {
                generation,
                agent: agent.clone(),
                ..Default::default()
            };
        }
        if self.sidebar_state.catalogs.loading {
            self.sidebar_state.catalogs.pending_refresh = true;
            return;
        }
        let state = &mut self.sidebar_state.catalogs;
        state.generation += 1;
        let generation = state.generation;
        state.loading = true;
        state.error = None;
        state.pending_refresh = false;
        state.paging.clear();
        let mut params = json!({"limitPerHost":50});
        if let Some(agent) = &agent {
            params["agentId"] = json!(agent);
        }
        // Do not opt into progressive host events: this read owns one complete snapshot.
        self.request(
            "sessions.catalog.list",
            params,
            cx,
            move |this, result, cx| {
                let state = &mut this.sidebar_state.catalogs;
                if state.generation != generation || state.agent != agent {
                    return;
                }
                state.loading = false;
                match result.and_then(|value| {
                    serde_json::from_value::<CatalogResult>(value)
                        .map_err(|error| error.to_string())
                }) {
                    Ok(result) => state.catalogs = result.catalogs,
                    Err(error) => state.error = Some(error),
                }
                let again = state.pending_refresh;
                cx.notify();
                if again {
                    this.refresh_sidebar_catalogs(cx);
                }
            },
        );
    }

    pub(super) fn apply_sidebar_catalog_event(
        &mut self,
        event: &str,
        _payload: &Value,
        cx: &mut Context<Self>,
    ) {
        if event == "sessions.catalog.changed" {
            self.refresh_sidebar_catalogs(cx);
        }
    }

    fn more_sidebar_catalog(&mut self, id: String, cx: &mut Context<Self>) {
        let state = &mut self.sidebar_state.catalogs;
        if state.loading || state.paging.contains(&id) {
            return;
        }
        let Some(catalog) = state.catalogs.iter().find(|catalog| catalog.id == id) else {
            return;
        };
        let cursors: BTreeMap<_, _> = catalog
            .hosts
            .iter()
            .filter_map(|host| Some((host.host_id.clone(), host.next_cursor.clone()?)))
            .collect();
        if cursors.is_empty() {
            return;
        }
        state.paging.insert(id.clone());
        let generation = state.generation;
        let agent = state.agent.clone();
        let mut params =
            json!({"catalogId":id,"hostIds":cursors.keys().collect::<Vec<_>>(),"cursors":cursors});
        if let Some(agent) = &agent {
            params["agentId"] = json!(agent);
        }
        self.request(
            "sessions.catalog.list",
            params,
            cx,
            move |this, result, cx| {
                let state = &mut this.sidebar_state.catalogs;
                if generation != state.generation || state.agent != agent {
                    return;
                }
                state.paging.remove(&id);
                match result.and_then(|value| {
                    serde_json::from_value::<CatalogResult>(value)
                        .map_err(|error| error.to_string())
                }) {
                    Ok(result) => {
                        if let Some(page) =
                            result.catalogs.into_iter().find(|catalog| catalog.id == id)
                            && let Some(current) =
                                state.catalogs.iter_mut().find(|catalog| catalog.id == id)
                        {
                            sidebar_catalog::merge_page(current, page, &cursors);
                            for (key, limit) in &mut state.limits {
                                if key.starts_with(&format!("catalog:{id}:")) {
                                    *limit += 10;
                                }
                            }
                        }
                    }
                    Err(error) => state.error = Some(error),
                }
                cx.notify();
            },
        );
    }

    pub(super) fn sidebar_catalog_sections(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::sidebar(cx);
        let prefs = &self.sidebar_state.preferences;
        let state = &self.sidebar_state.catalogs;
        let mut content = div().v_flex().gap(space::XXS);
        if prefs.archive == ArchiveFilter::Archived || prefs.all_agents {
            return content.into_any_element();
        }
        if let Some(error) = &state.error {
            content = content.child(
                Button::new("catalog-retry")
                    .ghost()
                    .small()
                    .w_full()
                    .label(format!("Session sources: {error} · Retry"))
                    .on_click(cx.listener(|this, _, _, cx| this.refresh_sidebar_catalogs(cx))),
            );
        }
        for catalog in &state.catalogs {
            if prefs.hidden_catalogs.contains(&catalog.id) {
                continue;
            }
            let section = format!("catalog:{}", catalog.id);
            let collapsed = prefs.collapsed_sections.contains(&section);
            let visible = catalog.hosts.iter().any(|host| {
                !sidebar_catalog::grouped_sessions(
                    &host.sessions,
                    prefs.grouping,
                    prefs.owner_id.as_deref(),
                    &self.rows,
                )
                .is_empty()
            });
            let error = catalog.error.as_ref().map(|error| error.label());
            if !visible && error.is_none() {
                continue;
            }
            let id = catalog.id.clone();
            let toggle = section.clone();
            let view = cx.entity().downgrade();
            let current = prefs.grouping;
            let count = catalog
                .hosts
                .iter()
                .map(|host| host.sessions.len())
                .sum::<usize>();
            let header_group = SharedString::from(format!("catalog-header:{}", catalog.id));
            let new_path = sidebar_catalog::new_session_path(
                self.sidebar_state
                    .selected_agent
                    .as_deref()
                    .unwrap_or("main"),
                &catalog.id,
            );
            let mut block = div().v_flex().pt(header::SECTION_GAP).child(
                div()
                    .group(header_group.clone())
                    .h_flex()
                    .gap(space::XXS)
                    .child(
                        Button::new(SharedString::from(section.clone()))
                            .ghost()
                            .small()
                            .flex_1()
                            .justify_start()
                            .icon(icon(
                                if collapsed {
                                    IconName::ChevronRight
                                } else {
                                    IconName::ChevronDown
                                },
                                tokens::icon::ACTION,
                            ))
                            .label(if collapsed {
                                format!("{}  {count}", catalog.label)
                            } else {
                                catalog.label.clone()
                            })
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this
                                    .sidebar_state
                                    .preferences
                                    .collapsed_sections
                                    .remove(&toggle)
                                {
                                    this.sidebar_state
                                        .preferences
                                        .collapsed_sections
                                        .insert(toggle.clone());
                                }
                                this.persist_sidebar_preferences(cx);
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("catalog-menu:{id}")))
                            .ghost()
                            .small()
                            .size(tokens::icon_button::COMPACT.size)
                            .opacity(opacity::HIDDEN)
                            .group_hover(header_group.clone(), |style| {
                                style.opacity(opacity::VISIBLE)
                            })
                            .focus_visible(|style| style.opacity(opacity::VISIBLE))
                            .icon(icon(IconName::ListFilter, tokens::icon::ACTION))
                            .accessibility_label("Session source options")
                            .dropdown_menu(move |mut menu, _, _| {
                                for (label, mode) in [
                                    ("Group by project", Grouping::Project),
                                    ("Group by person", Grouping::Person),
                                    ("Flat list", Grouping::None),
                                ] {
                                    let view = view.clone();
                                    menu = menu.item(
                                        PopupMenuItem::new(label)
                                            .checked(
                                                current == mode
                                                    || (mode == Grouping::Project
                                                        && current == Grouping::Category),
                                            )
                                            .on_click(move |_, _, cx| {
                                                let _ = view.update(cx, |this, cx| {
                                                    this.change_sidebar_preferences(
                                                        |prefs| prefs.grouping = mode,
                                                        cx,
                                                    )
                                                });
                                            }),
                                    );
                                }
                                let hidden_id = id.clone();
                                let hidden_view = view.clone();
                                menu = menu.item(PopupMenuItem::new("Hide source").on_click(
                                    move |_, _, cx| {
                                        let _ = hidden_view.update(cx, |this, cx| {
                                            this.change_sidebar_preferences(
                                                |prefs| {
                                                    prefs.hidden_catalogs.insert(hidden_id.clone());
                                                },
                                                cx,
                                            )
                                        });
                                    },
                                ));
                                let view = view.clone();
                                menu.item(PopupMenuItem::new("Show all hidden sources").on_click(
                                    move |_, _, cx| {
                                        let _ = view.update(cx, |this, cx| {
                                            this.change_sidebar_preferences(
                                                |prefs| prefs.hidden_catalogs.clear(),
                                                cx,
                                            )
                                        });
                                    },
                                ))
                            }),
                    )
                    .when(catalog.capabilities.start_terminal, |header| {
                        header.child(
                            Button::new(SharedString::from(format!("catalog-new:{}", catalog.id)))
                                .ghost()
                                .small()
                                .size(tokens::icon_button::COMPACT.size)
                                .icon(icon(IconName::Plus, tokens::icon::ACTION))
                                .opacity(opacity::HIDDEN)
                                .group_hover(header_group, |style| style.opacity(opacity::VISIBLE))
                                .focus_visible(|style| style.opacity(opacity::VISIBLE))
                                .accessibility_label(format!("New {} session", catalog.label))
                                .disabled(self.session.is_none())
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.open_control_page(&new_path, "New session", window, cx)
                                })),
                        )
                    }),
            );
            if let Some(error) = error {
                block = block.child(
                    div()
                        .px(space::WIDGET_INSET)
                        .text_size(text::WIDGET_XS_SIZE)
                        .text_color(p.danger)
                        .child(error),
                );
            }
            if !collapsed {
                for host in &catalog.hosts {
                    let groups = sidebar_catalog::grouped_sessions(
                        &host.sessions,
                        prefs.grouping,
                        prefs.owner_id.as_deref(),
                        &self.rows,
                    );
                    if groups.is_empty() {
                        continue;
                    }
                    if catalog.hosts.len() > 1 || !host.connected {
                        block = block.child(
                            div()
                                .px(space::WIDGET_INSET)
                                .py(space::WIDGET_GAP)
                                .text_size(text::CAPTION.size)
                                .text_color(p.muted)
                                .child(format!(
                                    "{}{}",
                                    host.label,
                                    if host.connected { "" } else { " · Offline" }
                                )),
                        );
                    }
                    if host.pending {
                        block = block.child(
                            div()
                                .px(space::WIDGET_INSET)
                                .text_size(text::WIDGET_XS_SIZE)
                                .text_color(p.muted)
                                .child("Loading source…"),
                        );
                    }
                    if let Some(error) = &host.error
                        && error.code != "NODE_OFFLINE"
                    {
                        block = block.child(
                            div()
                                .px(space::WIDGET_INSET)
                                .text_size(text::WIDGET_XS_SIZE)
                                .text_color(p.danger)
                                .child(error.label()),
                        );
                    }
                    for group in groups {
                        let group_id = format!("{section}:{}:{}", host.host_id, group.key);
                        let group_collapsed =
                            !group.key.is_empty() && prefs.collapsed_sections.contains(&group_id);
                        if !group.key.is_empty() {
                            let toggle = group_id.clone();
                            block = block.child(
                                Button::new(SharedString::from(group_id.clone()))
                                    .ghost()
                                    .small()
                                    .w_full()
                                    .justify_start()
                                    .text_size(text::CAPTION.size)
                                    .label(group.label)
                                    .icon(icon(
                                        if group_collapsed {
                                            IconName::ChevronRight
                                        } else {
                                            IconName::ChevronDown
                                        },
                                        tokens::icon::SMALL,
                                    ))
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if !this
                                            .sidebar_state
                                            .preferences
                                            .collapsed_sections
                                            .remove(&toggle)
                                        {
                                            this.sidebar_state
                                                .preferences
                                                .collapsed_sections
                                                .insert(toggle.clone());
                                        }
                                        this.persist_sidebar_preferences(cx);
                                        cx.notify();
                                    })),
                            );
                        }
                        if group_collapsed {
                            continue;
                        }
                        let limit = state.limits.get(&group_id).copied().unwrap_or(10);
                        for row in group.sessions.iter().take(limit) {
                            let live = row
                                .session_key
                                .as_deref()
                                .and_then(|key| self.rows.iter().find(|row| row.key == key));
                            let title = live
                                .map(|row| row.title())
                                .unwrap_or_else(|| row.title().to_owned());
                            let agent = self
                                .sidebar_state
                                .selected_agent
                                .as_deref()
                                .unwrap_or("main");
                            let path = sidebar_catalog::viewer_path(
                                agent,
                                &catalog.id,
                                &host.host_id,
                                row,
                            );
                            let native_key = row.session_key.clone();
                            let active = native_key.as_ref().is_some_and(|key| {
                                self.chat.selected_session.as_ref() == Some(key)
                            });
                            let label = title.clone();
                            let menu_path = path.clone();
                            let menu_label = label.clone();
                            let view = cx.entity().downgrade();
                            block = block.child(
                                list_row(
                                    SharedString::from(format!("{group_id}:{}", row.thread_id)),
                                    row::SESSION,
                                )
                                .role(Role::Button)
                                .aria_label(title.clone())
                                .h(row::SESSION.min_height)
                                .px(space::WIDGET_INSET)
                                .py(space::NONE)
                                .rounded(radius::WIDGET_MD)
                                .when(active, |el| el.bg(p.hover))
                                .hover(|el| el.bg(p.hover))
                                .child(
                                    icon(
                                        if row.archived {
                                            IconName::Archive
                                        } else {
                                            IconName::Terminal
                                        },
                                        tokens::icon::NORMAL,
                                    )
                                    .text_color(p.muted),
                                )
                                .child(
                                    div()
                                        .flex_1()
                                        .truncate()
                                        .text_size(text::SESSION.size)
                                        .child(title),
                                )
                                .when(live.is_some_and(|row| row.unread), |el| {
                                    el.child(
                                        div().size(tokens::icon::DOT).rounded_full().bg(p.accent),
                                    )
                                })
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    if let Some(key) = &native_key {
                                        this.select_session(key.clone(), window, cx);
                                    } else {
                                        this.open_control_page(&path, &label, window, cx);
                                    }
                                }))
                                .context_menu(move |menu, _, _| {
                                    let view = view.clone();
                                    let path = menu_path.clone();
                                    let title = menu_label.clone();
                                    menu.item(PopupMenuItem::new("Open source viewer…").on_click(
                                        move |_, window, cx| {
                                            let _ = view.update(cx, |this, cx| {
                                                this.open_control_page(&path, &title, window, cx)
                                            });
                                        },
                                    ))
                                }),
                            );
                        }
                        if group.sessions.len() > limit {
                            let id = group_id.clone();
                            block = block.child(
                                Button::new(SharedString::from(format!("catalog-more:{group_id}")))
                                    .ghost()
                                    .small()
                                    .label("Show more")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        *this
                                            .sidebar_state
                                            .catalogs
                                            .limits
                                            .entry(id.clone())
                                            .or_insert(10) += 10;
                                        cx.notify();
                                    })),
                            );
                        }
                    }
                }
                if catalog.hosts.iter().any(|host| host.next_cursor.is_some()) {
                    let id = catalog.id.clone();
                    block = block.child(
                        Button::new(SharedString::from(format!("catalog-load:{}", catalog.id)))
                            .ghost()
                            .small()
                            .label("Load more from source")
                            .disabled(state.loading || state.paging.contains(&catalog.id))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.more_sidebar_catalog(id.clone(), cx)
                            })),
                    );
                }
            }
            content = content.child(block);
        }
        if !prefs.hidden_catalogs.is_empty() {
            content = content.child(
                Button::new("restore-hidden-catalogs")
                    .ghost()
                    .small()
                    .label("Show hidden session sources")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.change_sidebar_preferences(|prefs| prefs.hidden_catalogs.clear(), cx)
                    })),
            );
        }
        content.into_any_element()
    }
}
