use super::AppView;
use crate::{
    gateway::sessions_rpc::{self as rpc, Agent, AgentIdentity, Agents, ListParams, SearchHit},
    model::{
        chat::RequestScope,
        sessions::{
            MutationReceipts, SessionPage, SessionRow, order_rows, reconcile_event,
            retain_newer_rows,
        },
    },
};
use gpui_kit::{
    component::{
        WindowExt,
        command::CommandState,
        input::{InputEvent, InputState},
        notification::Notification,
    },
    *,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

pub(super) struct PendingSelection {
    epoch: u64,
    agent_revision: u64,
    source: Option<RequestScope>,
    key: String,
}

pub(super) struct SidebarState {
    pub preferences: crate::model::sidebar::SidebarPreferences,
    pub preference_scope: String,
    pub preference_revision: u64,
    pub preference_writer:
        Option<async_channel::Sender<(String, crate::model::sidebar::SidebarPreferences)>>,
    pub section_limits: HashMap<String, usize>,
    pub created_order: crate::model::sidebar::CreatedOrder,
    pub selection: crate::model::sidebar::Selection,
    pub people: crate::model::people::PeopleState,
    pub avatars: super::components::avatar_cache::AvatarCache,
    pub pull_requests: crate::model::sidebar_pr::PullRequestStore,
    pub pull_request_generation: u64,
    pub activity: crate::model::sidebar_activity::SidebarActivity,
    pub owners: Vec<Value>,
    pub list_focus: FocusHandle,
    pub catalogs: super::sidebar_catalog::SidebarCatalogState,
    pub collapsed: bool,
    pub width: f32,
    pub resizing: bool,
    pub selected_agent: Option<String>,
    pub selected_descriptor: Option<SessionRow>,
    pub agent_revision: u64,
    pub agents: Vec<Agent>,
    /// Bounded cross-agent activity projection; never admits navigation membership.
    pub agent_activity: Vec<SessionRow>,
    agent_activity_generation: u64,
    pub main_key: String,
    pub global_scope: bool,
    pub has_more: bool,
    pub next_offset: usize,
    pub expanded: HashSet<String>,
    pub children: HashMap<String, Vec<SessionRow>>,
    pub child_loading: HashSet<String>,
    pub child_limits: HashMap<String, usize>,
    pub child_errors: HashMap<String, String>,
    pub attention: HashSet<String>,
    pub reconnect_at: Option<Instant>,
    pub status_expiry: Option<u64>,
    pub rename_row: Option<SessionRow>,
    pub rename_in_header: bool,
    pub rename_input: Entity<InputState>,
    pub palette_open: bool,
    pub command_state: Entity<CommandState>,
    pub search_hits: Vec<SearchHit>,
    pub search_rows: Vec<SessionRow>,
    pub search_loading: bool,
    pub search_error: Option<String>,
    pub search_generation: u64,
    pub search_target: Option<String>,
    pub mutation_receipts: MutationReceipts,
    pub notifications: Vec<Notification>,
    pub pending_selection: Option<PendingSelection>,
    pub create_generation: u64,
    pub agents_generation: u64,
    roster_request: u64,
    pub refresh_timer: Option<Task<()>>,
    next_automatic: Option<Instant>,
    refresh_pending: bool,
    _subscriptions: Vec<Subscription>,
}

impl SidebarState {
    pub fn new(window: &mut Window, cx: &mut Context<AppView>) -> Self {
        let rename_input = cx.new(|cx| InputState::new(window, cx).placeholder("Session title"));
        let command_state = cx.new(|cx| CommandState::new(window, cx));
        let subscriptions =
            vec![
                cx.subscribe_in(&rename_input, window, |this, _, event, _, cx| {
                    if matches!(event, InputEvent::PressEnter { .. }) {
                        this.commit_rename(cx);
                    }
                    cx.notify();
                }),
            ];
        Self {
            preferences: Default::default(),
            preference_scope: String::new(),
            preference_revision: 0,
            preference_writer: None,
            section_limits: HashMap::new(),
            created_order: Default::default(),
            selection: Default::default(),
            people: Default::default(),
            avatars: Default::default(),
            pull_requests: Default::default(),
            pull_request_generation: 0,
            activity: Default::default(),
            owners: Vec::new(),
            list_focus: cx.focus_handle(),
            catalogs: Default::default(),
            collapsed: false,
            width: f32::from(super::theme::tokens::sidebar::DEFAULT_WIDTH),
            resizing: false,
            selected_agent: None,
            selected_descriptor: None,
            agent_revision: 0,
            agents: Vec::new(),
            agent_activity: Vec::new(),
            agent_activity_generation: 0,
            main_key: "main".into(),
            global_scope: false,
            has_more: false,
            next_offset: 0,
            expanded: HashSet::new(),
            children: HashMap::new(),
            child_loading: HashSet::new(),
            child_limits: HashMap::new(),
            child_errors: HashMap::new(),
            attention: HashSet::new(),
            reconnect_at: None,
            status_expiry: None,
            rename_row: None,
            rename_in_header: false,
            rename_input,
            palette_open: false,
            command_state,
            search_hits: Vec::new(),
            search_rows: Vec::new(),
            search_loading: false,
            search_error: None,
            search_generation: 0,
            search_target: None,
            mutation_receipts: MutationReceipts::default(),
            notifications: Vec::new(),
            pending_selection: None,
            create_generation: 0,
            agents_generation: 0,
            roster_request: 0,
            refresh_timer: None,
            next_automatic: None,
            refresh_pending: false,
            _subscriptions: subscriptions,
        }
    }
}

impl AppView {
    pub(super) fn sidebar_connected(&mut self, cx: &mut Context<Self>) {
        self.sidebar_state.refresh_timer = None;
        self.sidebar_state.next_automatic = None;
        self.sidebar_state.child_loading.clear();
        self.sidebar_state.children.clear();
        self.sidebar_state.attention.clear();
        self.sidebar_state.pending_selection = None;
        self.sidebar_state.catalogs = Default::default();
        self.sidebar_state.agent_activity.clear();
        self.sidebar_state.agent_activity_generation += 1;
        self.load_sidebar_groups(cx);
        self.load_agents(cx);
    }

    pub(super) fn apply_sidebar_pending(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for note in self.sidebar_state.notifications.drain(..) {
            window.push_notification(note, cx);
        }
        if let Some(pending) = self.sidebar_state.pending_selection.take()
            && pending.epoch == self.epoch
            && pending.agent_revision == self.sidebar_state.agent_revision
            && pending.source == self.chat.scope()
        {
            self.select_session(pending.key, window, cx);
        }
    }

    pub(super) fn queue_session_selection(&mut self, key: String) {
        self.sidebar_state.pending_selection = Some(PendingSelection {
            epoch: self.epoch,
            agent_revision: self.sidebar_state.agent_revision,
            source: self.chat.scope(),
            key,
        });
    }

    pub(super) fn load_agents(&mut self, cx: &mut Context<Self>) {
        self.sidebar_state.agents_generation += 1;
        let generation = self.sidebar_state.agents_generation;
        self.request("agents.list", json!({}), cx, move |this, result, cx| {
            if generation != this.sidebar_state.agents_generation {
                return;
            }
            match result.and_then(|value| {
                serde_json::from_value::<Agents>(value).map_err(|error| error.to_string())
            }) {
                Ok(list) => {
                    this.sidebar_state.main_key = if list.main_key.is_empty() {
                        "main".into()
                    } else {
                        list.main_key
                    };
                    this.sidebar_state.global_scope = list.scope == "global";
                    this.sidebar_state.agents = list.agents;
                    if this.sidebar_state.selected_agent.as_ref().is_none_or(|id| {
                        !this
                            .sidebar_state
                            .agents
                            .iter()
                            .any(|agent| &agent.id == id)
                    }) {
                        this.sidebar_state.selected_agent = Some(list.default_id);
                        this.sidebar_state.agent_revision += 1;
                        this.queue_session_selection(this.agent_home());
                    }
                    let ids: Vec<_> = this
                        .sidebar_state
                        .agents
                        .iter()
                        .map(|agent| agent.id.clone())
                        .collect();
                    for id in ids {
                        this.request(
                            "agent.identity.get",
                            json!({"agentId":id}),
                            cx,
                            move |this, result, cx| {
                                if this.sidebar_state.agents_generation != generation {
                                    return;
                                }
                                if let Ok(identity) = result.and_then(|value| {
                                    serde_json::from_value::<AgentIdentity>(value)
                                        .map_err(|error| error.to_string())
                                }) && let Some(agent) = this
                                    .sidebar_state
                                    .agents
                                    .iter_mut()
                                    .find(|agent| agent.id == id)
                                {
                                    agent.identity = identity;
                                    this.refresh_sidebar_avatars(cx);
                                }
                            },
                        );
                    }
                    this.refresh_sidebar_catalogs(cx);
                    this.refresh_sessions(cx);
                }
                Err(error) => {
                    this.roster_error = Some(error);
                    this.refresh_sessions(cx);
                }
            }
        });
    }

    pub(super) fn load_agent_activity(&mut self, cx: &mut Context<Self>) {
        self.sidebar_state.agent_activity_generation += 1;
        let generation = self.sidebar_state.agent_activity_generation;
        // An unfiltered All Agents read already carries this projection.
        if self.session.is_none()
            || (self.sidebar_state.preferences.all_agents
                && !self.sidebar_state.preferences.filtered())
        {
            return;
        }
        self.request(
            "sessions.list",
            rpc::params(ListParams::activity()),
            cx,
            move |this, result, _| {
                if this.sidebar_state.agent_activity_generation != generation {
                    return;
                }
                match result
                    .and_then(|value| SessionPage::parse(value).map_err(|error| error.to_string()))
                {
                    Ok(mut page) => {
                        retain_newer_rows(&this.sidebar_state.agent_activity, &mut page.sessions);
                        page.sessions.truncate(200);
                        this.sidebar_state.agent_activity = page.sessions;
                    }
                    Err(error) => {
                        this.mutation_error(format!("Could not load agent activity: {error}"))
                    }
                }
            },
        );
    }

    pub(super) fn selected_agent_name(&self) -> String {
        self.sidebar_state
            .agents
            .iter()
            .find(|agent| Some(&agent.id) == self.sidebar_state.selected_agent.as_ref())
            .map(|agent| agent.name().to_owned())
            .unwrap_or_else(|| "OpenClaw".into())
    }
    pub(super) fn selected_agent_avatar(&self) -> String {
        self.sidebar_state
            .agents
            .iter()
            .find(|agent| Some(&agent.id) == self.sidebar_state.selected_agent.as_ref())
            .map(Agent::avatar)
            .unwrap_or_else(|| "◈".into())
    }
    pub(super) fn selected_row(&self) -> Option<&SessionRow> {
        let key = self.chat.selected_session.as_ref()?;
        self.rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .chain(self.sidebar_state.search_rows.iter())
            .chain(self.sidebar_state.selected_descriptor.iter())
            .find(|row| &row.key == key)
    }
    pub(super) fn remember_selected_descriptor(&mut self, key: &str) {
        self.sidebar_state.selected_descriptor = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .chain(self.sidebar_state.search_rows.iter())
            .chain(self.sidebar_state.selected_descriptor.iter())
            .find(|row| row.key == key)
            .cloned();
    }
    pub(super) fn agent_home(&self) -> String {
        if self.sidebar_state.global_scope {
            return "global".into();
        }
        format!(
            "agent:{}:{}",
            self.sidebar_state
                .selected_agent
                .as_deref()
                .unwrap_or("main"),
            self.sidebar_state.main_key
        )
    }
    pub(super) fn switch_agent(&mut self, id: String, window: &mut Window, cx: &mut Context<Self>) {
        if self.sidebar_state.selected_agent.as_ref() == Some(&id) {
            return;
        }
        self.sidebar_state.selected_agent = Some(id);
        self.sidebar_state.agent_revision += 1;
        self.sidebar_state.selected_descriptor = None;
        self.sidebar_state.children.clear();
        self.sidebar_state.child_loading.clear();
        self.sidebar_state.child_errors.clear();
        self.sidebar_state.expanded.clear();
        self.sidebar_state.rename_row = None;
        self.sidebar_state.search_hits.clear();
        self.sidebar_state.search_rows.clear();
        self.sidebar_state.pending_selection = None;
        self.sidebar_state.has_more = false;
        self.rows.clear();
        self.select_session(self.agent_home(), window, cx);
        self.refresh_sidebar_catalogs(cx);
        self.refresh_sessions(cx);
    }
    pub(super) fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_state.collapsed = !self.sidebar_state.collapsed;
        cx.notify();
    }
    pub(super) fn navigate_session(
        &mut self,
        delta: isize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let keys = self.sidebar_visible_keys();
        let rows: Vec<_> = keys
            .iter()
            .filter_map(|key| self.rows.iter().find(|row| &row.key == key))
            .collect();
        if rows.is_empty() {
            return;
        }
        let current = rows
            .iter()
            .position(|row| Some(&row.key) == self.chat.selected_session.as_ref())
            .unwrap_or(0);
        let index = (current as isize + delta).rem_euclid(rows.len() as isize) as usize;
        self.select_session(rows[index].key.clone(), window, cx);
    }

    pub(super) fn invalidate_roster_reads(&mut self) {
        self.sidebar_state.roster_request += 1;
        self.roster_loading = false;
    }

    pub(super) fn refresh_sessions(&mut self, cx: &mut Context<Self>) {
        self.read_roster(false, cx);
    }
    pub(super) fn more_sessions(&mut self, cx: &mut Context<Self>) {
        if !self.roster_loading && self.sidebar_state.has_more {
            self.read_roster(true, cx);
        }
    }
    fn read_roster(&mut self, append: bool, cx: &mut Context<Self>) {
        if self.session.is_none() {
            return;
        }
        if !append {
            self.load_agent_activity(cx);
        }
        self.sidebar_state.refresh_timer = None;
        self.sidebar_state.refresh_pending = false;
        self.sidebar_state.roster_request += 1;
        let generation = self.sidebar_state.roster_request;
        let all_agents = self.sidebar_state.preferences.all_agents;
        let agent = if all_agents {
            None
        } else {
            self.sidebar_state.selected_agent.clone()
        };
        let offset = if append {
            self.sidebar_state.next_offset
        } else {
            0
        };
        let started = Instant::now();
        self.roster_loading = true;
        self.roster_error = None;
        self.request(
            "sessions.list",
            rpc::params(
                ListParams::page(agent.clone(), offset).with_preferences(
                    &self.sidebar_state.preferences,
                    self.sidebar_state
                        .people
                        .self_user
                        .as_ref()
                        .map(|person| person.id.as_str()),
                ),
            ),
            cx,
            move |this, result, cx| {
                if this.sidebar_state.roster_request != generation
                    || this.sidebar_state.preferences.all_agents != all_agents
                    || (!all_agents && this.sidebar_state.selected_agent != agent)
                {
                    return;
                }
                this.roster_loading = false;
                this.sidebar_state.next_automatic = Some(
                    Instant::now()
                        + (started.elapsed() * 3)
                            .clamp(Duration::from_secs(5), Duration::from_secs(15)),
                );
                if let Ok(value) = &result
                    && let Some(owners) = value.get("owners").and_then(Value::as_array)
                {
                    this.sidebar_state.owners = owners.clone();
                }
                match result
                    .and_then(|value| SessionPage::parse(value).map_err(|error| error.to_string()))
                {
                    Ok(mut page) => {
                        retain_newer_rows(&this.rows, &mut page.sessions);
                        let sampled_at = crate::model::chat::now_ms();
                        for row in &mut page.sessions {
                            row.sample_runtime_at(sampled_at);
                        }
                        this.sidebar_state.has_more = page.has_more;
                        this.sidebar_state.next_offset =
                            page.next_offset.unwrap_or(offset + page.sessions.len());
                        if let Some(key) = this.chat.selected_session.clone() {
                            this.remember_selected_descriptor(&key);
                        }
                        if append {
                            for row in page.sessions {
                                if let Some(old) =
                                    this.rows.iter_mut().find(|old| old.key == row.key)
                                {
                                    *old = row;
                                } else {
                                    this.rows.push(row);
                                }
                            }
                            order_rows(&mut this.rows);
                        } else {
                            this.rows = page.sessions;
                        }
                        if all_agents && !this.sidebar_state.preferences.filtered() {
                            this.sidebar_state.agent_activity = this
                                .rows
                                .iter()
                                .filter(|row| !row.is_subagent())
                                .take(200)
                                .cloned()
                                .collect();
                        }
                        this.sidebar_state.created_order.observe(&this.rows);
                        this.refresh_sidebar_avatars(cx);
                        this.sync_sidebar_activity(cx);
                        this.sync_sidebar_pull_requests(cx);
                        if this.chat.selected_session.is_none() {
                            this.queue_session_selection(this.agent_home());
                        }
                    }
                    Err(error) => this.roster_error = Some(error),
                }
                if this.sidebar_state.refresh_pending {
                    this.schedule_refresh(cx);
                }
            },
        );
        cx.notify();
    }
    pub(super) fn schedule_refresh(&mut self, cx: &mut Context<Self>) {
        self.sidebar_state.refresh_pending = true;
        if self.sidebar_state.refresh_timer.is_some() || self.roster_loading {
            return;
        }
        let epoch = self.epoch;
        let delay = self
            .sidebar_state
            .next_automatic
            .map(|next| next.saturating_duration_since(Instant::now()))
            .unwrap_or_default()
            .max(Duration::from_secs(5));
        self.sidebar_state.refresh_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(delay).await;
            let _ = this.update(cx, |this, cx| {
                if this.epoch == epoch {
                    this.refresh_sessions(cx);
                }
            });
        }));
    }
    pub(super) fn apply_sessions_changed(&mut self, payload: &Value, cx: &mut Context<Self>) {
        let watched = self.sidebar_state.pull_requests.watched_keys();
        let bindings: Vec<_> = self
            .rows
            .iter()
            .filter(|row| {
                watched.contains(&crate::model::sidebar_pr::scoped_key(&row.key, row.agent()))
            })
            .map(|row| {
                (
                    row.key.clone(),
                    row.session_id.clone(),
                    row.worktree
                        .as_ref()
                        .and_then(|value| value.get("id"))
                        .cloned(),
                )
            })
            .collect();
        let result = reconcile_event(&mut self.rows, payload);
        let _ = reconcile_event(&mut self.sidebar_state.agent_activity, payload);
        if let Some(row) = self.sidebar_state.selected_descriptor.as_mut() {
            let _ = reconcile_event(std::slice::from_mut(row), payload);
        }
        for rows in self.sidebar_state.children.values_mut() {
            let _ = reconcile_event(rows, payload);
        }
        let sampled_at = crate::model::chat::now_ms();
        for row in self
            .rows
            .iter_mut()
            .chain(self.sidebar_state.children.values_mut().flatten())
            .chain(self.sidebar_state.selected_descriptor.iter_mut())
        {
            row.sample_runtime_at(sampled_at);
        }
        if result.changed {
            order_rows(&mut self.rows);
        }
        if result.refresh || self.roster_loading {
            self.schedule_refresh(cx);
        }
        let structural = matches!(
            payload.get("reason").and_then(Value::as_str),
            Some("new" | "reset" | "branch-switch" | "fork" | "rewind")
        );
        let changed_key = payload
            .pointer("/session/key")
            .or_else(|| payload.get("sessionKey"))
            .and_then(Value::as_str);
        let invalidated = bindings.iter().any(|(key, session_id, worktree_id)| {
            (structural && changed_key == Some(key.as_str()))
                || self
                    .rows
                    .iter()
                    .find(|row| &row.key == key)
                    .is_none_or(|row| {
                        &row.session_id != session_id
                            || row.worktree.as_ref().and_then(|value| value.get("id"))
                                != worktree_id.as_ref()
                    })
        });
        if invalidated {
            self.sidebar_state.pull_requests.clear();
            self.sidebar_state.pull_request_generation += 1;
        }
        self.sync_sidebar_activity(cx);
        self.sync_sidebar_pull_requests(cx);
        self.refresh_sidebar_avatars(cx);
        cx.notify();
    }
    pub(super) fn toggle_children(&mut self, key: String, cx: &mut Context<Self>) {
        if self.sidebar_state.expanded.remove(&key) {
            cx.notify();
            return;
        }
        self.sidebar_state.expanded.insert(key.clone());
        if self.sidebar_state.children.contains_key(&key)
            || self.sidebar_state.child_loading.contains(&key)
        {
            cx.notify();
            return;
        }
        self.sidebar_state.child_loading.insert(key.clone());
        self.sidebar_state.child_errors.remove(&key);
        let agent = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .find(|row| row.key == key)
            .and_then(SessionRow::agent)
            .map(str::to_owned)
            .or_else(|| self.sidebar_state.selected_agent.clone());
        let revision = self.sidebar_state.agent_revision;
        self.request(
            "sessions.list",
            rpc::params(
                ListParams::children(agent.clone(), key.clone()).with_preferences(
                    &self.sidebar_state.preferences,
                    self.sidebar_state
                        .people
                        .self_user
                        .as_ref()
                        .map(|person| person.id.as_str()),
                ),
            ),
            cx,
            move |this, result, cx| {
                if this.sidebar_state.agent_revision != revision {
                    return;
                }
                this.sidebar_state.child_loading.remove(&key);
                match result
                    .and_then(|value| SessionPage::parse(value).map_err(|error| error.to_string()))
                {
                    Ok(mut page) => {
                        let sampled_at = crate::model::chat::now_ms();
                        for row in &mut page.sessions {
                            row.sample_runtime_at(sampled_at);
                        }
                        this.sidebar_state.children.insert(key, page.sessions);
                        this.refresh_sidebar_avatars(cx);
                        this.sync_sidebar_activity(cx);
                    }
                    Err(error) => {
                        this.sidebar_state.child_errors.insert(key, error);
                    }
                }
            },
        );
        cx.notify();
    }
}
