use super::AppView;
use crate::{
    gateway::sessions_rpc::{self as rpc, ListParams},
    model::sessions::{SessionPage, SessionRow, order_rows, reconcile_event, retain_newer_rows},
};
use gpui_kit::*;
use serde_json::Value;
use std::time::{Duration, Instant};

impl AppView {
    pub(in crate::ui) fn invalidate_roster_reads(&mut self) {
        self.sidebar_state.owners_known = false;
        self.sidebar_state.roster_request += 1;
        self.roster_loading = false;
    }

    pub(in crate::ui) fn refresh_sessions(&mut self, cx: &mut Context<Self>) {
        self.read_roster(false, cx);
    }
    pub(in crate::ui) fn more_sessions(&mut self, cx: &mut Context<Self>) {
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
                match result
                    .and_then(|value| SessionPage::parse(value).map_err(|error| error.to_string()))
                {
                    Ok(mut page) => {
                        this.sidebar_state.owners_known = page.owners.is_some();
                        this.sidebar_state.owners = page.owners.take().unwrap_or_default();
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
                        if this.chat.selected_session.is_none() && !this.new_session.active {
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
    pub(in crate::ui) fn schedule_refresh(&mut self, cx: &mut Context<Self>) {
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
    pub(in crate::ui) fn apply_sessions_changed(
        &mut self,
        payload: &Value,
        cx: &mut Context<Self>,
    ) {
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
    pub(in crate::ui) fn toggle_children(&mut self, key: String, cx: &mut Context<Self>) {
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
