mod roster;

use super::AppView;
use crate::{
    gateway::sessions_rpc::{self as rpc, Agent, AgentIdentity, Agents, ListParams, SearchHit},
    model::{
        chat::RequestScope,
        sessions::{MutationReceipts, SessionPage, SessionRow, retain_newer_rows},
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
    time::Instant,
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
    owners_known: bool,
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
            owners_known: false,
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
        self.sidebar_state.owners.clear();
        self.sidebar_state.owners_known = false;
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
        if self.new_session.active {
            return Some(&self.new_session.toolbar_row);
        }
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
        self.sidebar_state.owners.clear();
        self.sidebar_state.owners_known = false;
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
        if self.web.settings_open {
            if let Some(surface) = &self.web.settings {
                if delta < 0 {
                    surface.back();
                } else {
                    surface.forward();
                }
            }
            cx.notify();
            return;
        }
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

    pub(super) fn sidebar_owners(&self) -> crate::model::sidebar::SidebarOwners {
        crate::model::sidebar::SidebarOwners::project(
            self.sidebar_state
                .owners_known
                .then_some(self.sidebar_state.owners.as_slice()),
            self.sidebar_state.people.self_user.as_ref(),
            self.rows
                .iter()
                .chain(self.sidebar_state.children.values().flatten()),
        )
    }
}
