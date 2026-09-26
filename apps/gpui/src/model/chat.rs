use super::{
    attachments::Attachment,
    tools::{
        ToolCall, ToolEvent, apply_tool_event, bridge_has_child, pair_history,
        reconcile_live_history, settle_history_tools,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
mod message;
mod send;
mod time;
pub use time::{exact_time, relative_timestamp};
pub mod notice;
pub use message::{MediaRef, Message, MessageContent, ReplyTarget};

#[derive(Clone, Debug)]
pub struct ChatNote {
    pub text: String,
    pub error: bool,
}

#[derive(Clone, Debug)]
pub struct TurnRecap {
    pub run_id: String,
    pub runtime_ms: u64,
    pub output_tokens: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct ManualCompaction {
    pub operation_id: String,
    pub started_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RequestScope {
    pub session_key: String,
    pub agent_id: Option<String>,
    generation: u64,
}
#[derive(Clone, Debug)]
pub struct HistoryRequest {
    pub scope: RequestScope,
    pub offset: Option<usize>,
    request: u64,
    revision: u64,
    message_count: usize,
}
#[derive(Default, Debug)]
pub struct EventOutcome {
    pub changed: bool,
    pub terminal: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionInfo {
    pub total_tokens: Option<u64>,
    pub context_tokens: Option<u64>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub estimated_cost_usd: Option<f64>,
    pub model: Option<String>,
    pub model_provider: Option<String>,
    pub effective_queue_mode: Option<String>,
    pub thinking_level: Option<String>,
    pub session_id: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct HistoryPayload {
    messages: Option<Vec<Value>>,
    has_more: bool,
    next_offset: Option<usize>,
    in_flight_run: Option<InFlightRun>,
    session_info: Option<SessionInfo>,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct InFlightRun {
    run_id: String,
    text: String,
    started_at: Option<u64>,
    events: Vec<Value>,
}

#[derive(Default)]
pub struct ChatState {
    pub selected_session: Option<String>,
    pub selected_agent: Option<String>,
    pub messages: Vec<Message>,
    pub active_run: Option<String>,
    pub stream_text: String,
    pub stream_thinking: String,
    pub live_tools: Vec<ToolCall>,
    pub note: Option<ChatNote>,
    pub error_detail: Option<String>,
    pub history_error: Option<String>,
    pub loading: bool,
    pub loading_older: bool,
    pub has_more: bool,
    pub next_offset: Option<usize>,
    pub phase_label: String,
    pub started_at: Option<u64>,
    pub output_tokens: u64,
    pub turn_recap: Option<TurnRecap>,
    pub compacting: bool,
    pub manual_compaction: Option<ManualCompaction>,
    pub session_info: SessionInfo,
    pub dirty_from: Option<usize>,
    generation: u64,
    history_request: u64,
    revision: u64,
    sequence: Option<u64>,
    completed_runs: VecDeque<String>,
}

impl ChatState {
    pub fn history_tools(&self, index: usize) -> Vec<ToolCall> {
        self.messages[index]
            .tools
            .iter()
            .filter(|tool| {
                !self.bridge_has_child(tool)
                    && (tool.complete
                        || !self.live_tools.iter().any(|live| live.same_identity(tool)))
            })
            .cloned()
            .collect()
    }

    pub fn streaming_tools(&self) -> Vec<ToolCall> {
        self.live_tools
            .iter()
            .filter(|live| {
                !self.bridge_has_child(live)
                    && !self
                        .messages
                        .iter()
                        .flat_map(|message| &message.tools)
                        .any(|held| held.complete && held.same_identity(live))
            })
            .cloned()
            .collect()
    }

    fn bridge_has_child(&self, tool: &ToolCall) -> bool {
        bridge_has_child(
            tool,
            self.messages
                .iter()
                .flat_map(|message| &message.tools)
                .chain(self.live_tools.iter()),
        )
    }

    pub fn select_context(&mut self, key: String, agent_id: Option<String>) {
        *self = Self {
            selected_session: Some(key),
            selected_agent: agent_id,
            generation: self.generation.wrapping_add(1),
            ..Default::default()
        };
    }
    pub fn scope(&self) -> Option<RequestScope> {
        Some(RequestScope {
            session_key: self.selected_session.clone()?,
            agent_id: self.selected_agent.clone(),
            generation: self.generation,
        })
    }
    pub fn is_current(&self, scope: &RequestScope) -> bool {
        self.selected_session.as_deref() == Some(&scope.session_key)
            && self.selected_agent == scope.agent_id
            && self.generation == scope.generation
    }
    pub fn begin_history(&mut self) -> Option<HistoryRequest> {
        self.begin_history_page(None)
    }
    pub fn begin_older(&mut self) -> Option<HistoryRequest> {
        if self.loading || self.loading_older || !self.has_more {
            return None;
        }
        self.begin_history_page(Some(self.next_offset?))
    }
    fn begin_history_page(&mut self, offset: Option<usize>) -> Option<HistoryRequest> {
        let scope = self.scope()?;
        self.history_request = self.history_request.wrapping_add(1);
        self.loading = offset.is_none();
        self.loading_older = offset.is_some();
        self.history_error = None;
        Some(HistoryRequest {
            scope,
            offset,
            request: self.history_request,
            revision: self.revision,
            message_count: self.messages.len(),
        })
    }
    pub fn apply_history(&mut self, request: &HistoryRequest, payload: &Value) -> bool {
        if !self.is_current(&request.scope) || request.request != self.history_request {
            return false;
        }
        let Ok(payload) = serde_json::from_value::<HistoryPayload>(payload.clone()) else {
            return self.history_failed(request, "Gateway returned invalid chat history".into());
        };
        let Some(values) = payload.messages else {
            return self.history_failed(request, "Gateway returned invalid chat history".into());
        };
        let mut messages: Vec<_> = values
            .iter()
            .filter_map(Message::from_value)
            .filter(Message::visible)
            .collect();
        for tool in messages.iter_mut().flat_map(|message| &mut message.tools) {
            tool.receipt = request.revision;
        }
        pair_history(&mut messages);
        if request.offset.is_some() {
            messages.retain(|message| !self.messages.iter().any(|held| held.same_message(message)));
            messages.append(&mut self.messages);
        } else if self.revision != request.revision {
            let mut current_tools = self
                .messages
                .iter()
                .flat_map(|message| message.tools.iter().cloned())
                .collect();
            reconcile_live_history(&mut messages, &mut current_tools);
            let live = &self.messages[request.message_count.min(self.messages.len())..];
            for message in live {
                if !messages.iter().any(|held| held.same_message(message)) {
                    messages.push(message.clone());
                }
            }
        } else {
            let run = payload
                .in_flight_run
                .as_ref()
                .filter(|run| !self.completed_runs.contains(&run.run_id));
            if self.active_run.as_deref() != run.map(|run| run.run_id.as_str()) || run.is_none() {
                self.clear_stream();
            }
            if run.is_some() && self.active_run.as_deref() != run.map(|run| run.run_id.as_str()) {
                self.turn_recap = None;
            }
            self.active_run = run.map(|run| run.run_id.clone());
            self.stream_text = run.map(|run| run.text.clone()).unwrap_or_default();
            self.started_at = run.and_then(|run| run.started_at);
            self.sequence = None;
        }
        // Unconfirmed input belongs to this client until an authoritative match arrives.
        for pending in &self.messages {
            if pending.send_id.is_some() && !messages.iter().any(|held| held.same_message(pending))
            {
                messages.push(pending.clone());
            }
        }
        pair_history(&mut messages);
        self.messages = messages;
        self.has_more = payload.has_more;
        self.next_offset = payload.next_offset;
        if let Some(info) = payload.session_info {
            self.session_info = info;
        }
        if let Some(run) = payload
            .in_flight_run
            .filter(|run| self.active_run.as_deref() == Some(&run.run_id))
        {
            for event in run.events {
                self.apply_agent_event(&event);
            }
        }
        reconcile_live_history(&mut self.messages, &mut self.live_tools);
        pair_history(&mut self.messages);
        settle_history_tools(&mut self.messages, self.active_run.as_deref());
        self.loading = false;
        self.loading_older = false;
        self.history_error = None;
        true
    }
    pub fn history_failed(&mut self, request: &HistoryRequest, error: String) -> bool {
        if !self.is_current(&request.scope) || request.request != self.history_request {
            return false;
        }
        self.loading = false;
        self.loading_older = false;
        self.history_error = Some(error);
        true
    }
    pub fn apply_event(&mut self, payload: &Value) -> EventOutcome {
        let state = payload
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let mut outcome = EventOutcome::default();
        if !self.event_matches(payload) {
            return outcome;
        }
        let Some(run) = payload.get("runId").and_then(Value::as_str) else {
            return outcome;
        };
        if self.completed_runs.iter().any(|id| id == run)
            || self.active_run.as_deref().is_some_and(|id| id != run)
            || !matches!(state, "status" | "delta" | "final" | "aborted" | "error")
        {
            return outcome;
        }
        if self.active_run.is_none() {
            self.turn_recap = None;
            self.clear_stream();
        }
        let sequence = payload.get("seq").and_then(Value::as_u64);
        if sequence
            .zip(self.sequence)
            .is_some_and(|(next, previous)| next <= previous)
        {
            return outcome;
        }
        self.active_run = Some(run.into());
        self.started_at.get_or_insert_with(now_ms);
        self.sequence = sequence.or(self.sequence);
        self.note = None;
        self.revision += 1;
        for (index, message) in self.messages.iter_mut().enumerate() {
            if message.send_id.as_deref() == Some(run)
                && (message.pending || message.send_error.is_some())
            {
                self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
                message.pending = false;
                message.send_error = None;
            }
        }
        outcome.changed = true;
        outcome.terminal = matches!(state, "final" | "aborted" | "error");
        let snapshot = payload.get("message").and_then(Message::from_value);
        if let Some(thinking) = snapshot
            .as_ref()
            .map(|message| &message.thinking)
            .filter(|text| !text.is_empty())
        {
            self.stream_thinking = thinking.clone();
        }
        if let Some(tokens) = payload
            .pointer("/usage/output")
            .or_else(|| payload.pointer("/usage/outputTokens"))
            .and_then(Value::as_u64)
        {
            self.output_tokens = tokens;
        }
        match state {
            "status" => {
                self.phase_label = phase_label(payload);
            }
            "delta" => {
                self.phase_label = "Working".into();
                let snapshot_text = snapshot.as_ref().map(|message| message.text.as_str());
                if let Some(delta) = payload.get("deltaText").and_then(Value::as_str) {
                    if payload.get("replace").and_then(Value::as_bool) == Some(true) {
                        self.stream_text = delta.into();
                    } else if let Some(text) = snapshot_text {
                        if text.strip_suffix(delta) != Some(self.stream_text.as_str()) {
                            self.stream_text = text.into();
                        } else {
                            self.stream_text.push_str(delta);
                        }
                    } else {
                        self.stream_text.push_str(delta);
                    }
                } else if let Some(text) = snapshot_text {
                    self.stream_text = text.into();
                }
            }
            "final" | "aborted" | "error" => {
                let mut message = snapshot.unwrap_or_else(|| Message {
                    role: "assistant".into(),
                    text: self.stream_text.clone(),
                    thinking: self.stream_thinking.clone(),
                    ..Default::default()
                });
                message.run_id = Some(run.into());
                message.timestamp.get_or_insert_with(now_ms);
                for tool in &mut message.tools {
                    tool.run_id.get_or_insert_with(|| run.into());
                    tool.receipt = self.revision;
                }
                message.tools.extend(
                    self.live_tools
                        .iter()
                        .filter(|tool| tool.run_id.as_deref() == Some(run))
                        .cloned(),
                );
                if message.visible() {
                    self.messages.push(message);
                }
                pair_history(&mut self.messages);
                settle_history_tools(&mut self.messages, None);
                self.dirty_from = Some(0);
                self.note = match state {
                    "aborted" => Some(ChatNote {
                        text: "Stopped".into(),
                        error: false,
                    }),
                    "error" => Some(ChatNote {
                        text: payload
                            .get("errorMessage")
                            .and_then(Value::as_str)
                            .unwrap_or("The assistant could not complete this response")
                            .into(),
                        error: true,
                    }),
                    _ => None,
                };
                self.error_detail = (state == "error").then(|| {
                    format!(
                        "{}\n{}",
                        payload
                            .get("errorKind")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown"),
                        payload
                            .get("errorDetail")
                            .map(|detail| serde_json::to_string_pretty(detail).unwrap_or_default())
                            .unwrap_or_default()
                    )
                });
                self.finish_run();
            }
            _ => {}
        }
        outcome
    }
    pub fn apply_session_operation(&mut self, payload: &Value) -> EventOutcome {
        let mut outcome = EventOutcome::default();
        if self.selected_session.is_none()
            || !self.event_matches(payload)
            || payload.get("operation").and_then(Value::as_str) != Some("compact")
        {
            return outcome;
        }
        let Some(operation_id) = payload
            .get("operationId")
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
        else {
            return outcome;
        };
        match payload.get("phase").and_then(Value::as_str) {
            Some("start") => {
                let Some(started_at) = payload.get("ts").and_then(Value::as_u64) else {
                    return outcome;
                };
                if self.manual_compaction.as_ref().is_some_and(|held| {
                    held.operation_id == operation_id || held.started_at > started_at
                }) {
                    return outcome;
                }
                self.manual_compaction = Some(ManualCompaction {
                    operation_id: operation_id.to_owned(),
                    started_at,
                });
            }
            Some("end") => {
                if self.manual_compaction.is_none() {
                    // The operator may have left and returned while compaction ran.
                    outcome.terminal =
                        payload.get("completed").and_then(Value::as_bool) == Some(true);
                    return outcome;
                }
                if self
                    .manual_compaction
                    .as_ref()
                    .is_none_or(|held| held.operation_id != operation_id)
                {
                    return outcome;
                }
                self.manual_compaction = None;
                outcome.terminal = payload.get("completed").and_then(Value::as_bool) == Some(true);
            }
            _ => return outcome,
        }
        self.dirty_from = Some(
            self.dirty_from
                .map_or(self.messages.len(), |old| old.min(self.messages.len())),
        );
        outcome.changed = true;
        outcome
    }

    fn event_matches(&self, payload: &Value) -> bool {
        self.selected_session.as_deref() == payload.get("sessionKey").and_then(Value::as_str)
            && payload
                .get("agentId")
                .and_then(Value::as_str)
                .is_none_or(|agent| {
                    self.selected_agent
                        .as_deref()
                        .is_none_or(|selected| selected == agent)
                })
    }
    pub fn apply_agent_event(&mut self, payload: &Value) -> bool {
        let Ok(event) = serde_json::from_value::<ToolEvent>(payload.clone()) else {
            return false;
        };
        if event.run_id.is_empty() {
            return false;
        }
        if event.session_key.is_some() {
            if !self.event_matches(payload) {
                return false;
            }
        } else if self.active_run.as_deref() != Some(event.run_id.as_str()) {
            return false;
        }
        if self.completed_runs.iter().any(|run| run == &event.run_id) {
            if event.stream == "usage"
                && let Some(tokens) = event.data.output_tokens
                && let Some(recap) = self.turn_recap.as_mut()
                && recap.run_id == event.run_id
            {
                recap.output_tokens = Some(tokens);
                return true;
            }
            // A late result may settle a known interrupted call without restarting its run.
            if event.stream == "tool"
                && event.data.phase == "result"
                && let Some((index, message)) =
                    self.messages.iter_mut().enumerate().find(|(_, message)| {
                        message.tools.iter().any(|tool| {
                            tool.id == event.data.tool_call_id
                                && tool.run_id.as_deref() == Some(&event.run_id)
                        })
                    })
            {
                let changed = apply_tool_event(&mut message.tools, &event, self.revision + 1);
                if changed {
                    self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
                    self.revision += 1;
                }
                return changed;
            }
            return false;
        }
        if self
            .active_run
            .as_deref()
            .is_some_and(|run| run != event.run_id)
        {
            return false;
        }
        match event.stream.as_str() {
            "tool" => {
                if self
                    .active_run
                    .as_deref()
                    .is_some_and(|run| run != event.run_id)
                {
                    return false;
                }
                if self.active_run.is_none() {
                    self.turn_recap = None;
                    self.clear_stream();
                }
                self.active_run = Some(event.run_id.clone());
                self.started_at.get_or_insert(event.ts);
                let changed = if let Some((index, message)) =
                    self.messages.iter_mut().enumerate().find(|(_, message)| {
                        message.tools.iter().any(|tool| {
                            tool.id == event.data.tool_call_id
                                && tool.run_id.as_deref() == Some(&event.run_id)
                        })
                    }) {
                    self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
                    apply_tool_event(&mut message.tools, &event, self.revision + 1)
                } else {
                    apply_tool_event(&mut self.live_tools, &event, self.revision + 1)
                };
                if changed {
                    if reconcile_live_history(&mut self.messages, &mut self.live_tools) {
                        self.dirty_from = Some(0);
                    }
                    if let Some(parent) = &event.data.parent_tool_call_id
                        && let Some(index) = self.messages.iter().position(|message| {
                            message.tools.iter().any(|tool| {
                                tool.id == *parent && tool.run_id.as_deref() == Some(&event.run_id)
                            })
                        })
                    {
                        self.dirty_from = Some(self.dirty_from.map_or(index, |old| old.min(index)));
                    }
                    self.revision += 1;
                }
                changed
            }
            "usage" => {
                if let Some(tokens) = event.data.output_tokens {
                    self.output_tokens = tokens;
                    true
                } else {
                    false
                }
            }
            "thinking" | "reasoning" => {
                if let Some(text) = event.data.text {
                    self.stream_thinking = text;
                } else if let Some(delta) = event.data.delta {
                    self.stream_thinking.push_str(&delta);
                }
                true
            }
            "compaction" => {
                self.compacting = event.data.phase == "start";
                self.phase_label = if event.data.phase == "start" {
                    "Compacting conversation"
                } else {
                    "Working"
                }
                .into();
                true
            }
            _ => false,
        }
    }
    fn finish_run(&mut self) {
        let recap = self
            .active_run
            .as_ref()
            .zip(self.started_at)
            .map(|(run, start)| TurnRecap {
                run_id: run.clone(),
                runtime_ms: now_ms().saturating_sub(start),
                output_tokens: (self.output_tokens > 0).then_some(self.output_tokens),
            });
        if let Some(run) = self.active_run.take() {
            self.completed_runs.push_back(run);
            if self.completed_runs.len() > 128 {
                self.completed_runs.pop_front();
            }
        }
        self.clear_stream();
        self.turn_recap = if self.note.is_none() { recap } else { None };
    }
    fn clear_stream(&mut self) {
        self.compacting = false;
        self.stream_text.clear();
        self.stream_thinking.clear();
        self.live_tools.clear();
        self.started_at = None;
        self.output_tokens = 0;
        self.phase_label.clear();
        self.sequence = None;
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn phase_label(payload: &Value) -> String {
    if let Some(retry) = payload.get("retry") {
        return format!(
            "Retrying ({}/{})…",
            retry.get("attempt").and_then(Value::as_u64).unwrap_or(1),
            retry
                .get("maxAttempts")
                .and_then(Value::as_u64)
                .unwrap_or(1)
        );
    }
    match payload
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "waiting_for_state" => "Waiting for session",
        "preparing_workspace" => "Preparing workspace",
        "naming_worktree" => "Naming worktree",
        "creating_worktree" => "Creating worktree",
        "running_setup" => "Running setup",
        "provisioning_environment" => "Preparing environment",
        "preparing_context" => "Preparing context",
        "memory_flushing" => "Saving memory",
        "starting_model" => "Starting model",
        _ => "Working",
    }
    .into()
}
#[cfg(test)]
mod tests;
