use crate::gateway::composer_rpc::{AgentRuntime, ContextWindowOption, FastMode, ThinkingLevel};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentStatus {
    pub note: String,
    pub expires_at: u64,
    pub attention: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionRow {
    pub key: String,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub label: Option<String>,
    pub display_name: Option<String>,
    pub derived_title: Option<String>,
    pub last_message_preview: Option<String>,
    pub agent_status: Option<AgentStatus>,
    pub icon: Option<String>,
    pub color: Option<String>,
    pub category: Option<String>,
    pub channel: Option<String>,
    pub channel_avatar_url: Option<String>,
    pub subject: Option<String>,
    pub participants: Vec<Value>,
    pub expanded_participants: Vec<Value>,
    pub participant_count: Option<usize>,
    pub visibility: Option<String>,
    pub sharing_role: Option<String>,
    pub incognito: bool,
    pub has_automation: bool,
    pub hidden_from_involving_me: Option<bool>,
    pub worktree: Option<Value>,
    pub repository: Option<Value>,
    pub placement: Option<Value>,
    pub exec_node: Option<String>,
    pub exec_cwd: Option<String>,
    pub spawned_workspace_dir: Option<String>,
    pub spawned_cwd: Option<String>,
    pub observer_digest: Option<Value>,
    pub active_run_ids: Vec<String>,
    pub last_read_at: Option<f64>,
    pub marked_unread_at: Option<f64>,
    pub created_at: Option<f64>,
    pub started_at: Option<f64>,
    pub ended_at: Option<f64>,
    pub runtime_ms: Option<f64>,
    pub runtime_sampled_at: Option<f64>,
    pub updated_at: Option<f64>,
    pub snapshot_at: Option<f64>,
    pub status: Option<String>,
    pub has_active_run: bool,
    pub has_active_subagent_run: bool,
    pub pinned: bool,
    pub pinned_at: Option<f64>,
    pub owner: Option<Value>,
    pub created_actor: Option<Value>,
    pub kind: Option<String>,
    pub control_owner_session_key: Option<String>,
    pub archived: bool,
    pub archived_by: Option<Value>,
    pub unread: bool,
    pub last_run_error: Option<String>,
    pub parent_session_key: Option<String>,
    pub parent_session_id: Option<String>,
    pub created_via: Option<String>,
    pub spawn_depth: Option<u32>,
    pub fork_source: Option<Value>,
    pub forked_from_parent: bool,
    pub spawned_by: Option<String>,
    pub child_sessions: Vec<String>,
    pub children: Vec<SessionRow>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub active_model: Option<String>,
    pub active_model_provider: Option<String>,
    pub model_override_source: Option<String>,
    pub model_selection_locked: bool,
    pub runtime_selection_locked: bool,
    pub agent_runtime: Option<AgentRuntime>,
    pub thinking_level: Option<String>,
    pub thinking_levels: Option<Vec<ThinkingLevel>>,
    pub thinking_options: Option<Vec<String>>,
    pub thinking_default: Option<String>,
    pub fast_mode: Option<FastMode>,
    pub effective_fast_mode: Option<FastMode>,
    pub context_window: Option<String>,
    pub context_windows: Option<Vec<ContextWindowOption>>,
    pub context_window_default: Option<String>,
    pub permission_mode: Option<String>,
    pub permission_mode_pending: bool,
    pub tool_overrides: Option<Value>,
    pub total_tokens: Option<f64>,
    pub total_tokens_fresh: Option<bool>,
    pub effective_queue_mode: Option<String>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub context_tokens: Option<f64>,
    pub estimated_cost_usd: Option<f64>,
}

impl SessionRow {
    pub fn title(&self) -> String {
        if let Some(title) = [&self.label, &self.display_name, &self.derived_title]
            .into_iter()
            .filter_map(|value| value.as_deref())
            .map(str::trim)
            .find(|value| !value.is_empty() && *value != self.key)
        {
            return title.to_owned();
        }
        if let Some(preview) = self.last_message_preview.as_deref() {
            let preview = preview.split_whitespace().collect::<Vec<_>>().join(" ");
            if !preview.is_empty() && preview != self.key {
                let title: String = preview.chars().take(80).collect();
                return if preview.chars().count() > 80 {
                    format!("{title}…")
                } else {
                    title
                };
            }
        }
        friendly_session_title(&self.key)
    }

    pub fn running(&self) -> bool {
        self.has_active_run || matches!(self.status.as_deref(), Some("running" | "queued"))
    }

    pub fn display_running(&self) -> bool {
        !self.archived && (self.running() || self.has_active_subagent_run)
    }

    pub fn sample_runtime_at(&mut self, now: u64) {
        if self.runtime_ms.is_some() && self.runtime_sampled_at.is_none() {
            self.runtime_sampled_at = Some(now as f64);
        }
    }

    pub fn runtime_duration_ms(&self, now: u64) -> Option<u64> {
        let valid = |value: Option<f64>| value.filter(|value| value.is_finite() && *value >= 0.);
        if let Some(runtime) = valid(self.runtime_ms) {
            let elapsed = if self.running() && !self.archived {
                valid(self.runtime_sampled_at)
                    .map(|sampled| (now as f64 - sampled).max(0.))
                    .unwrap_or(0.)
            } else {
                0.
            };
            return Some((runtime + elapsed) as u64);
        }
        let started = valid(self.started_at)?;
        let end = valid(self.ended_at).unwrap_or(now as f64);
        Some((end - started).max(0.) as u64)
    }

    pub fn agent(&self) -> Option<&str> {
        self.agent_id.as_deref().or_else(|| {
            self.key
                .strip_prefix("agent:")
                .and_then(|key| key.split(':').next())
        })
    }

    pub fn owner_id(&self) -> Option<&str> {
        self.owner.as_ref()?.get("actor")?.get("id")?.as_str()
    }

    pub fn owner_label(&self) -> &str {
        self.owner
            .as_ref()
            .and_then(|owner| owner.get("actor"))
            .and_then(|actor| actor.get("label"))
            .and_then(Value::as_str)
            .filter(|label| !label.trim().is_empty())
            .or_else(|| self.owner_id())
            .unwrap_or("")
    }

    pub fn is_cron(&self) -> bool {
        let key = self.key.trim().to_ascii_lowercase();
        if key.starts_with("cron:") {
            return true;
        }
        let mut segments = key.split(':').filter(|part| !part.is_empty());
        segments.next() == Some("agent")
            && segments.next().is_some()
            && segments.next() == Some("cron")
            && segments.next().is_some()
    }

    pub fn is_system(&self) -> bool {
        if self.is_cron() {
            return false;
        }
        let actor = self
            .created_actor
            .as_ref()
            .and_then(|actor| actor.get("type"))
            .and_then(Value::as_str);
        actor == Some("system")
            || (matches!(self.created_via.as_deref(), Some("run" | "internal"))
                && actor != Some("human")
                && [&self.label, &self.display_name, &self.subject]
                    .iter()
                    .all(|text| text.as_deref().is_none_or(|value| value.trim().is_empty())))
    }

    pub fn work_session(&self) -> bool {
        let key = self.key.trim().to_ascii_lowercase();
        let acp = key.starts_with("acp:")
            || key
                .strip_prefix("agent:")
                .and_then(|tail| tail.split_once(':'))
                .is_some_and(|(_, tail)| tail.starts_with("acp:"));
        self.worktree.is_some() || self.repository.is_some() || self.exec_node.is_some() || acp
    }

    pub fn work_path(&self) -> Option<&str> {
        let repository = self
            .repository
            .as_ref()
            .and_then(|repo| repo.get("url"))
            .and_then(Value::as_str);
        let worktree = self
            .worktree
            .as_ref()
            .and_then(|tree| tree.get("repoRoot"))
            .and_then(Value::as_str);
        let local_paths = if self.exec_node.is_some() {
            [self.exec_cwd.as_deref(), None, None]
        } else {
            [
                worktree,
                self.spawned_workspace_dir.as_deref(),
                self.spawned_cwd.as_deref(),
            ]
        };
        repository
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(|path| path.strip_suffix(".git").unwrap_or(path))
            .or_else(|| {
                local_paths
                    .into_iter()
                    .flatten()
                    .map(str::trim)
                    .find(|path| !path.is_empty())
            })
    }

    pub fn parent(&self) -> Option<&str> {
        self.parent_session_key
            .as_deref()
            .or(self.spawned_by.as_deref())
    }

    pub fn is_subagent(&self) -> bool {
        is_subagent_key(&self.key)
    }

    /// Implicit Home ancestry carries notices; explicit creation/fork ancestry carries nesting.
    pub fn navigation_parent<'a>(
        &'a self,
        main_key: &str,
        listed_parent: Option<&'a str>,
    ) -> Option<&'a str> {
        let parent = self.parent().or(listed_parent)?;
        if parent.eq_ignore_ascii_case(main_key)
            && self.created_via.as_deref() == Some("operator")
            && self.spawn_depth == Some(0)
            && self.parent_session_id.is_none()
            && self.spawned_by.is_none()
            && self.fork_source.is_none()
            && !self.forked_from_parent
            && !self.is_subagent()
        {
            None
        } else {
            Some(parent)
        }
    }

    pub fn can_pin(&self, main_key: &str) -> bool {
        !self.is_subagent()
            && self.spawned_by.is_none()
            && self.parent_session_key.as_ref().is_none_or(|parent| {
                self.agent()
                    .is_some_and(|agent| parent == &format!("agent:{agent}:main"))
            })
            && self.navigation_parent(main_key, None).is_none()
    }

    pub fn apply_patch(&mut self, fields: &Value) {
        let Ok(mut value) = serde_json::to_value(&*self) else {
            return;
        };
        if let (Some(object), Some(patch)) = (value.as_object_mut(), fields.as_object()) {
            object.extend(patch.clone());
            if patch.contains_key("runtimeMs") && !patch.contains_key("runtimeSampledAt") {
                object.remove("runtimeSampledAt");
            }
        }
        if let Ok(row) = serde_json::from_value(value) {
            *self = row;
        }
    }
}

/// Routing keys are identity, not titles, including before the roster arrives.
pub fn friendly_session_title(key: &str) -> String {
    let tail = key
        .strip_prefix("agent:")
        .and_then(|rest| rest.split_once(':'))
        .map(|(_, tail)| tail)
        .unwrap_or(key);
    if tail == "main" || tail == "global" {
        return "Main".into();
    }
    if tail.starts_with("dashboard:") {
        return "New session".into();
    }
    if tail.starts_with("subagent:") {
        return "Subagent".into();
    }
    if tail.starts_with("cron:") {
        return "Automation".into();
    }
    tail.strip_prefix("explicit:").unwrap_or(tail).to_owned()
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionPage {
    pub sessions: Vec<SessionRow>,
    pub has_more: bool,
    pub next_offset: Option<usize>,
    pub owners: Option<Vec<Value>>,
    pub people: Vec<Value>,
}

impl SessionPage {
    pub fn parse(payload: Value) -> Result<Self, serde_json::Error> {
        let mut page: Self = serde_json::from_value(payload)?;
        order_rows(&mut page.sessions);
        Ok(page)
    }
}

pub fn order_rows(rows: &mut [SessionRow]) {
    rows.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| {
                b.updated_at
                    .unwrap_or(0.)
                    .total_cmp(&a.updated_at.unwrap_or(0.))
            })
            .then_with(|| a.key.cmp(&b.key))
    });
}

/// A list owns membership; a newer event receipt still owns that admitted row's facts.
pub fn retain_newer_rows(current: &[SessionRow], incoming: &mut [SessionRow]) {
    for row in incoming {
        if let Some(held) = current.iter().find(|held| held.key == row.key)
            && held.session_id == row.session_id
            && held
                .snapshot_at
                .or(held.updated_at)
                .zip(row.snapshot_at.or(row.updated_at))
                .is_some_and(|(held, next)| held > next)
        {
            *row = held.clone();
        }
    }
}

#[derive(Default, Debug, PartialEq)]
pub struct Reconcile {
    pub changed: bool,
    pub refresh: bool,
}

/// Events can update rows already admitted by a list, but never admit membership.
pub fn reconcile_event(rows: &mut [SessionRow], payload: &Value) -> Reconcile {
    let mut outcome = reconcile_snapshot(rows, payload);
    if let Some(ancestors) = payload.get("ancestorSessions").and_then(Value::as_array) {
        for ancestor in ancestors {
            let result = reconcile_snapshot(
                rows,
                &serde_json::json!({"session":ancestor,"ancestorSessions":[]}),
            );
            outcome.changed |= result.changed;
            outcome.refresh |= result.refresh;
        }
    }
    outcome
}

fn reconcile_snapshot(rows: &mut [SessionRow], payload: &Value) -> Reconcile {
    let mut outcome = Reconcile::default();
    let Some(snapshot) = payload.get("session").and_then(Value::as_object) else {
        outcome.refresh = true;
        return outcome;
    };
    let key = snapshot
        .get("key")
        .and_then(Value::as_str)
        .or_else(|| payload.get("sessionKey").and_then(Value::as_str));
    let Some(current) = rows.iter_mut().find(|row| Some(row.key.as_str()) == key) else {
        outcome.refresh = true;
        return outcome;
    };
    let stamp = snapshot
        .get("snapshotAt")
        .and_then(Value::as_f64)
        .or_else(|| snapshot.get("updatedAt").and_then(Value::as_f64));
    if stamp
        .zip(current.snapshot_at.or(current.updated_at))
        .is_some_and(|(next, previous)| next < previous)
    {
        outcome.refresh = true;
        return outcome;
    }
    let old = current.clone();
    let mut fields = snapshot.clone();
    if let Some(envelope) = payload.as_object() {
        for (field, value) in envelope {
            if value.is_null() && !fields.contains_key(field) {
                fields.insert(field.clone(), value.clone());
            }
        }
    }
    current.apply_patch(&Value::Object(fields));
    let certified = payload.get("ancestorSessions").is_some_and(Value::is_array);
    let reason = payload.get("reason").and_then(Value::as_str);
    outcome.changed = *current != old;
    outcome.refresh = current.pinned != old.pinned
        || current.pinned_at != old.pinned_at
        || current.archived != old.archived
        || current.parent() != old.parent()
        || current.agent() != old.agent()
        || current.session_id != old.session_id
        || current.owner != old.owner
        || current.created_actor != old.created_actor
        || current.kind != old.kind
        || current.control_owner_session_key != old.control_owner_session_key
        || current.child_sessions != old.child_sessions
        || payload.get("catalogChanged").and_then(Value::as_bool) == Some(true)
        || payload.get("phase").and_then(Value::as_str) == Some("reset")
        || reason.is_some_and(|reason| {
            !matches!(
                reason,
                "patch"
                    | "placement"
                    | "send"
                    | "steer"
                    | "agent.run.started"
                    | "agent.input.settled"
                    | "run-capacity"
                    | "chat.title"
            )
        })
        || (!certified && (old.parent().is_some() || !old.child_sessions.is_empty()));
    outcome
}

fn is_subagent_key(key: &str) -> bool {
    let key = key.trim().to_ascii_lowercase();
    key.starts_with("subagent:")
        || key
            .strip_prefix("agent:")
            .and_then(|tail| tail.split_once(':'))
            .is_some_and(|(_, tail)| tail.starts_with("subagent:"))
}

fn direct_child_keys(
    parent_key: &str,
    listed: &[String],
    known: &[&SessionRow],
    main_key: &str,
) -> Vec<String> {
    let mut keys = Vec::new();
    for key in listed {
        let child = known.iter().find(|row| row.key == *key);
        if child.is_none_or(|child| {
            child.navigation_parent(main_key, Some(parent_key)) == Some(parent_key)
        }) && !keys.contains(key)
        {
            keys.push(key.clone());
        }
    }
    for child in known {
        if child.navigation_parent(main_key, None) == Some(parent_key) && !keys.contains(&child.key)
        {
            keys.push(child.key.clone());
        }
    }
    keys
}

/// Runs contribute activity but only persistent descendants take navigation rows.
/// Child-side placement wins, and a visited set bounds malformed subagent cycles.
pub fn visible_child_keys(
    parent: &SessionRow,
    known: &[&SessionRow],
    main_key: &str,
) -> Vec<String> {
    let mut pending = direct_child_keys(&parent.key, &parent.child_sessions, known, main_key);
    pending.reverse();
    let mut visited = HashSet::from([parent.key.clone()]);
    let mut visible = Vec::new();
    while let Some(key) = pending.pop() {
        if !visited.insert(key.clone()) {
            continue;
        }
        let row = known.iter().find(|row| row.key == key).copied();
        if is_subagent_key(&key) {
            let children = direct_child_keys(
                &key,
                row.map(|row| row.child_sessions.as_slice())
                    .unwrap_or_default(),
                known,
                main_key,
            );
            pending.extend(children.into_iter().rev());
        } else if row.is_none_or(|row| {
            row.category
                .as_deref()
                .is_none_or(|category| category.trim().is_empty())
        }) {
            visible.push(key);
        }
    }
    visible
}

/// Each mutable row has its own receipt, so an older failure cannot undo a newer edit.
#[derive(Default)]
pub struct MutationReceipts(HashMap<String, u64>);
impl MutationReceipts {
    pub fn begin(&mut self, key: &str) -> u64 {
        let generation = self.0.entry(key.to_owned()).or_default();
        *generation += 1;
        *generation
    }
    pub fn current(&self, key: &str, generation: u64) -> bool {
        self.0.get(key) == Some(&generation)
    }
}

#[cfg(test)]
mod tests;
