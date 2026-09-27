use super::theme::tokens::{radius, shell, space, text};
use super::{AppView, theme::Palette};
use crate::gateway::sessions_rpc::{self as rpc, SearchParams, SearchResults, SearchScope};
use crate::model::{
    sessions::{SessionRow, friendly_session_title},
    web_urls::SIDEBAR_ROUTES,
};
use gpui_kit::{
    component::{
        StyledExt,
        command::{Command, CommandItem},
    },
    prelude::FluentBuilder,
    *,
};

enum SearchTarget {
    Session {
        key: String,
        message_id: Option<String>,
    },
    Page(String),
    Agent(String),
    NewChat,
    Home,
    ToggleSidebar,
    Refresh,
}
struct SearchEntry {
    target: SearchTarget,
    title: String,
    snippet: Option<String>,
}
impl AppView {
    pub(super) fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.sidebar_state.palette_open {
            self.close_palette(window, cx);
            return;
        }
        self.sidebar_state.palette_open = true;
        self.sidebar_state.command_state.update(cx, |state, cx| {
            state.set_query("", window, cx);
            state.focus(window, cx);
        });
        self.search_sessions(cx);
        cx.notify();
    }
    pub(super) fn close_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sidebar_state.palette_open = false;
        self.sidebar_state.search_generation += 1;
        self.composer
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }
    fn search_entries(&self, cx: &App) -> Vec<SearchEntry> {
        let query = self
            .sidebar_state
            .command_state
            .read(cx)
            .query(cx)
            .trim()
            .to_lowercase();
        let mut entries = Vec::new();
        for (title, hint, target) in [
            ("New session", "New chat · ⇧⌘O", SearchTarget::NewChat),
            ("Home", "Open the main conversation", SearchTarget::Home),
            ("Toggle sidebar", "⌘B", SearchTarget::ToggleSidebar),
            (
                "Refresh",
                "Refresh conversations · ⌘R",
                SearchTarget::Refresh,
            ),
        ] {
            if query.is_empty() || format!("{title} {hint}").to_lowercase().contains(&query) {
                entries.push(SearchEntry {
                    title: title.into(),
                    snippet: Some(hint.into()),
                    target,
                });
            }
        }
        for (title, path) in SIDEBAR_ROUTES
            .iter()
            .map(|route| (route.title, route.path))
            .chain([
                ("Settings", "/settings"),
                ("Appearance", "/settings/appearance"),
                ("Profile", "/settings/profile"),
                ("Agent settings", "/settings/agents"),
                ("Models", "/settings/model-providers"),
                ("Channels", "/settings/channels"),
                ("Skills", "/skills"),
                ("About", "/settings/about"),
                ("New agent", "/custodian?intent=new-agent"),
                ("Advanced new session", "/new"),
            ])
        {
            if query.is_empty() || title.to_lowercase().contains(&query) {
                entries.push(SearchEntry {
                    title: title.into(),
                    snippet: Some("Navigation".into()),
                    target: SearchTarget::Page(path.into()),
                });
            }
        }
        for tab in &self.web.control_tabs {
            if query.is_empty() || tab.label.to_lowercase().contains(&query) {
                entries.push(SearchEntry {
                    title: tab.label.clone(),
                    snippet: Some("Plugin".into()),
                    target: SearchTarget::Page(tab.path()),
                });
            }
        }
        for agent in &self.sidebar_state.agents {
            let title = format!("Switch to {}", agent.name());
            if query.is_empty()
                || title.to_lowercase().contains(&query)
                || agent.id.to_lowercase().contains(&query)
            {
                entries.push(SearchEntry {
                    title,
                    snippet: Some("Agent".into()),
                    target: SearchTarget::Agent(agent.id.clone()),
                });
            }
        }
        let sessions = self
            .rows
            .iter()
            .filter(|row| {
                !row.archived && (query.is_empty() || row.title().to_lowercase().contains(&query))
            })
            .take(25)
            .map(|row| SearchEntry {
                title: row.title(),
                snippet: Some("Conversation".into()),
                target: SearchTarget::Session {
                    key: row.key.clone(),
                    message_id: None,
                },
            });
        entries.extend(sessions);
        entries.extend(self.sidebar_state.search_hits.iter().map(|hit| {
            let row = self
                .rows
                .iter()
                .chain(self.sidebar_state.search_rows.iter())
                .find(|row| row.key == hit.session_key);
            SearchEntry {
                title: row
                    .map(SessionRow::title)
                    .unwrap_or_else(|| friendly_session_title(&hit.session_key)),
                snippet: Some(format!("{} · {}", hit.role, hit.snippet)),
                target: SearchTarget::Session {
                    key: hit.session_key.clone(),
                    message_id: Some(hit.message_id.clone()),
                },
            }
        }));
        entries
    }
    pub(super) fn search_sessions(&mut self, cx: &mut Context<Self>) {
        self.sidebar_state.search_generation += 1;
        let generation = self.sidebar_state.search_generation;
        self.sidebar_state.search_hits.clear();
        self.sidebar_state.search_rows.clear();
        self.sidebar_state.search_error = None;
        let query = self
            .sidebar_state
            .command_state
            .read(cx)
            .query(cx)
            .trim()
            .to_owned();
        self.sidebar_state.search_loading = !query.is_empty() && self.session.is_some();
        if !self.sidebar_state.search_loading {
            cx.notify();
            return;
        }
        let selected_agent = self.sidebar_state.selected_agent.clone();
        let all_agents = self.sidebar_state.preferences.all_agents;
        let agent = if all_agents {
            None
        } else {
            selected_agent.clone()
        };
        self.request(
            "sessions.search",
            rpc::params(SearchParams {
                query,
                limit: 25,
                scope: SearchScope {
                    agent_id: agent.clone(),
                },
            }),
            cx,
            move |this, result, _| {
                if this.sidebar_state.search_generation != generation
                    || this.sidebar_state.selected_agent != selected_agent
                    || this.sidebar_state.preferences.all_agents != all_agents
                    || !this.sidebar_state.palette_open
                {
                    return;
                }
                this.sidebar_state.search_loading = false;
                match result.and_then(|value| {
                    serde_json::from_value::<SearchResults>(value)
                        .map_err(|error| error.to_string())
                }) {
                    Ok(result) => {
                        this.sidebar_state.search_hits = result.results;
                        this.sidebar_state.search_rows = result.sessions;
                        if result.indexing {
                            this.sidebar_state.search_error = Some(
                                "Transcript indexing is in progress. Search again shortly.".into(),
                            );
                        }
                    }
                    Err(error) => this.sidebar_state.search_error = Some(error),
                }
            },
        );
        cx.notify();
    }
    pub(super) fn open_search_result(
        &mut self,
        index: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(entry) = self.search_entries(cx).into_iter().nth(index) else {
            return;
        };
        self.close_palette(window, cx);
        match entry.target {
            SearchTarget::Session { key, message_id } => {
                self.sidebar_state.search_target = message_id;
                self.select_session(key, window, cx);
                self.reveal_search_target(cx);
            }
            SearchTarget::Page(path) => self.open_control_page(&path, &entry.title, window, cx),
            SearchTarget::Agent(agent) => {
                self.switch_agent(agent, window, cx);
                self.close_settings(window, cx);
            }
            SearchTarget::NewChat => self.new_chat(window, cx),
            SearchTarget::Home => self.select_session(self.agent_home(), window, cx),
            SearchTarget::ToggleSidebar => self.toggle_sidebar(cx),
            SearchTarget::Refresh => self.manual_refresh(cx),
        }
    }
    pub(super) fn palette_overlay(&self, cx: &mut Context<Self>) -> AnyElement {
        if !self.sidebar_state.palette_open {
            return div().into_any_element();
        }
        let p = Palette::get(cx);
        let query_view = cx.entity().downgrade();
        let confirm_view = query_view.clone();
        let cancel_view = query_view.clone();
        let entries = self.search_entries(cx);
        let items = entries.into_iter().map(|entry| {
            CommandItem::new()
                .label(entry.title.clone())
                .child(move |_, cx| {
                    let p = Palette::get(cx);
                    div()
                        .v_flex()
                        .py(space::REM_XS)
                        .gap(space::REM_XS)
                        .w_full()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(text::NAV.size)
                                .text_color(p.strong)
                                .truncate()
                                .child(entry.title.clone()),
                        )
                        .when_some(entry.snippet.clone(), |el, snippet| {
                            el.child(
                                div()
                                    .text_size(text::WIDGET_XS_SIZE)
                                    .text_color(p.muted)
                                    .truncate()
                                    .child(snippet),
                            )
                        })
                })
        });
        div()
            .id("search-overlay")
            .absolute()
            .inset_0()
            .flex()
            .justify_center()
            .pt(shell::PALETTE_TOP)
            .bg(p.bg.opacity(shell::OVERLAY_OPACITY))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| this.close_palette(window, cx)),
            )
            .child(
                div()
                    .id("search-palette")
                    .w(shell::PALETTE_WIDTH)
                    .max_w(relative(shell::PALETTE_WIDTH_RATIO))
                    .h(shell::PALETTE_HEIGHT)
                    .bg(p.popover)
                    .rounded(radius::WIDGET_XL)
                    .border(space::HAIRLINE)
                    .border_color(p.border_strong)
                    .shadow_lg()
                    .overflow_hidden()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        Command::new(&self.sidebar_state.command_state)
                            .placeholder("Search conversations, pages, and agents…")
                            .filterable(false)
                            .max_h(shell::PALETTE_RESULTS_MAX_HEIGHT)
                            .items(items)
                            .on_query(move |_, _, cx| {
                                let _ = query_view.update(cx, |this, cx| this.search_sessions(cx));
                            })
                            .on_confirm(move |index, window, cx| {
                                let _ = confirm_view.update(cx, |this, cx| {
                                    this.open_search_result(index.row, window, cx)
                                });
                            })
                            .on_cancel(move |window, cx| {
                                let _ = cancel_view
                                    .update(cx, |this, cx| this.close_palette(window, cx));
                            }),
                    )
                    .child(
                        div()
                            .px(space::REM_LG)
                            .py(space::REM_SM)
                            .text_size(text::WIDGET_XS_SIZE)
                            .text_color(if self.sidebar_state.search_error.is_some() {
                                p.danger
                            } else {
                                p.muted
                            })
                            .child(self.sidebar_state.search_error.clone().unwrap_or_else(|| {
                                if self.sidebar_state.search_loading {
                                    "Searching transcripts…".into()
                                } else {
                                    "↑↓ navigate · Return open · Esc close".into()
                                }
                            })),
                    ),
            )
            .into_any_element()
    }
}
