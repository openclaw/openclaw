use super::{ChatState, HistoryRequest};
use serde_json::Value;
use std::{
    collections::VecDeque,
    ops::{Deref, DerefMut},
};

const MAX_SESSIONS: usize = 20;
const MAX_BYTES: usize = 24 * 1024 * 1024;
const MAX_SESSION_BYTES: usize = 12 * 1024 * 1024;

/// The renderer lends its prepared rows and viewport to the transcript owner.
/// Evicting a transcript drops that presentation too, without a second UI LRU.
pub trait Presentation {
    fn approximate_bytes(&self) -> usize;
}

struct Entry<P> {
    state: ChatState,
    presentation: Option<P>,
    bytes: usize,
}

/// One window owns one Gateway profile. Profile changes retire every entry and
/// every request; session IDs and monotonically allocated generations fence reuse.
pub struct Sessions<P> {
    current: ChatState,
    entries: VecDeque<Entry<P>>,
    profile: String,
    authority: Option<Value>,
    identity: Option<String>,
    generation: u64,
    max_sessions: usize,
    max_bytes: usize,
    presentation_bytes: usize,
}

impl<P> Default for Sessions<P> {
    fn default() -> Self {
        Self {
            current: ChatState::default(),
            entries: VecDeque::new(),
            profile: String::new(),
            authority: None,
            identity: None,
            generation: 0,
            max_sessions: MAX_SESSIONS,
            max_bytes: MAX_BYTES,
            presentation_bytes: 0,
        }
    }
}

impl<P> Deref for Sessions<P> {
    type Target = ChatState;
    fn deref(&self) -> &ChatState {
        &self.current
    }
}
impl<P> DerefMut for Sessions<P> {
    fn deref_mut(&mut self) -> &mut ChatState {
        &mut self.current
    }
}

impl<P: Presentation> Sessions<P> {
    pub fn set_profile(&mut self, profile: String) -> bool {
        if self.profile == profile {
            return false;
        }
        self.profile = profile;
        self.authority = None;
        self.identity = None;
        self.clear();
        true
    }

    pub fn set_authority(&mut self, authority: Value) -> bool {
        let changed = self.authority.as_ref().is_some_and(|old| old != &authority);
        if changed {
            self.clear();
        }
        self.authority = Some(authority);
        changed
    }

    pub fn set_identity(&mut self, identity: String) -> bool {
        let changed = self.identity.as_ref().is_some_and(|old| old != &identity);
        if changed {
            self.clear();
        }
        self.identity = Some(identity);
        changed
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.presentation_bytes = 0;
        self.generation = self.generation.max(self.current.generation).wrapping_add(1);
        self.current = ChatState {
            generation: self.generation,
            ..Default::default()
        };
    }

    pub fn reconnect(&mut self) {
        self.generation = self.generation.max(self.current.generation).wrapping_add(1);
        self.current.generation = self.generation;
        self.current.loading = false;
        self.current.loading_older = false;
        self.current.history_pending = false;
        // Keep the cursor paired with the retained transcript; the next read
        // reconciles both missed durable messages and the authoritative live run.
    }

    pub fn switch(
        &mut self,
        key: String,
        agent: Option<String>,
        session_id: Option<&str>,
        presentation: P,
    ) -> Option<P> {
        if matches_context(&self.current, &key, agent.as_deref())
            && session_id
                .is_none_or(|id| self.current.session_info.session_id.as_deref() == Some(id))
        {
            return Some(presentation);
        }
        // Remove the target before admission: a full cache cannot evict the very
        // session the reader is opening while storing the departing transcript.
        let found = self
            .entries
            .iter()
            .position(|entry| matches_context(&entry.state, &key, agent.as_deref()));
        let restored = found
            .and_then(|index| self.entries.remove(index))
            .filter(|entry| {
                session_id
                    .is_none_or(|id| entry.state.session_info.session_id.as_deref() == Some(id))
            });
        self.generation = self.generation.max(self.current.generation).wrapping_add(1);
        let previous = std::mem::take(&mut self.current);
        self.retain(previous, Some(presentation));
        let (mut current, presentation) = restored
            .map(|entry| (entry.state, entry.presentation))
            .unwrap_or_default();
        current.selected_session = Some(key);
        current.selected_agent = agent;
        current.generation = self.generation;
        current.loading = false;
        current.loading_older = false;
        current.history_pending = false;
        self.current = current;
        self.bound_memory(0);
        presentation
    }

    fn retain(&mut self, state: ChatState, presentation: Option<P>) {
        if !state.loaded || state.selected_session.as_deref().is_none_or(str::is_empty) {
            return;
        }
        let bytes = approximate_bytes(&state)
            + presentation
                .as_ref()
                .map_or(0, Presentation::approximate_bytes);
        if bytes > MAX_SESSION_BYTES || bytes > self.max_bytes {
            return;
        }
        self.entries.retain(|entry| {
            entry.state.selected_session != state.selected_session
                || entry.state.selected_agent != state.selected_agent
        });
        self.entries.push_back(Entry {
            state,
            presentation,
            bytes,
        });
    }

    pub fn bound_memory(&mut self, presentation_bytes: usize) {
        self.presentation_bytes = presentation_bytes;
        self.trim();
    }

    fn trim(&mut self) {
        let mut bytes =
            approximate_bytes(&self.current) + self.presentation_bytes + self.cached_bytes();
        while self.entries.len() + 1 > self.max_sessions || bytes > self.max_bytes {
            let Some(entry) = self.entries.pop_front() else {
                break;
            };
            bytes = bytes.saturating_sub(entry.bytes);
        }
    }

    pub fn apply_history(&mut self, request: &HistoryRequest, payload: &Value) -> bool {
        let changed = self.current.apply_history(request, payload);
        if changed {
            self.trim();
        }
        changed
    }

    pub fn cached_count(&self) -> usize {
        self.entries.len()
    }
    pub fn cached_bytes(&self) -> usize {
        self.entries.iter().map(|entry| entry.bytes).sum()
    }
    pub fn contains(&self, key: &str, agent: Option<&str>) -> bool {
        matches_context(&self.current, key, agent)
            || self
                .entries
                .iter()
                .any(|entry| matches_context(&entry.state, key, agent))
    }

    pub fn invalidate(&mut self, key: &str, agent: Option<&str>) -> bool {
        self.invalidate_generation(key, agent, None)
    }

    pub fn invalidate_generation(
        &mut self,
        key: &str,
        agent: Option<&str>,
        session_id: Option<&str>,
    ) -> bool {
        let matches = |state: &ChatState| {
            matches_event(state, key, agent)
                && session_id.is_none_or(|id| {
                    state
                        .session_info
                        .session_id
                        .as_deref()
                        .is_none_or(|held| held == id)
                })
        };
        self.entries.retain(|entry| !matches(&entry.state));
        // Also fence prefetch results, including entries not yet admitted.
        self.generation = self.generation.max(self.current.generation).wrapping_add(1);
        if !matches(&self.current) {
            return false;
        }
        self.current = ChatState {
            selected_session: self.current.selected_session.take(),
            selected_agent: self.current.selected_agent.take(),
            generation: self.generation,
            ..Default::default()
        };
        self.presentation_bytes = 0;
        true
    }

    pub fn deny_history(&mut self, claim: &(super::RequestScope, u64)) -> bool {
        if self.current.history_claim().as_ref() == Some(claim) {
            return self.invalidate(&claim.0.session_key, claim.0.agent_id.as_deref());
        }
        self.entries
            .retain(|entry| entry.state.history_claim().as_ref() != Some(claim));
        false
    }

    /// The selected subscription owns live tool/agent replay. Background entries
    /// retain their last snapshot and cursor and always catch up when reopened.
    pub fn observe_event(&mut self, name: &str, payload: &Value) -> bool {
        let reason = payload.get("reason").and_then(Value::as_str);
        let compacted = name == "session.operation"
            && payload["operation"] == "compact"
            && payload["phase"] == "end"
            && payload["completed"] == true;
        let structural = name == "sessions.changed"
            && (payload["phase"] == "reset"
                || matches!(
                    reason,
                    Some(
                        "delete"
                            | "cleanup"
                            | "new"
                            | "reset"
                            | "compaction"
                            | "compact"
                            | "branch-switch"
                            | "rewind"
                    )
                ));
        let key = payload
            .pointer("/session/key")
            .or_else(|| payload.get("sessionKey"))
            .and_then(Value::as_str);
        let agent = payload.get("agentId").and_then(Value::as_str);
        if matches!(name, "agent" | "session.tool")
            && payload["stream"] == "compaction"
            && payload["data"]["phase"] == "end"
            && payload["data"]["completed"] == true
        {
            let target = std::iter::once(&self.current)
                .chain(self.entries.iter().map(|entry| &entry.state))
                .find(|state| {
                    payload
                        .get("runId")
                        .and_then(Value::as_str)
                        .is_some_and(|run| state.active_run.as_deref() == Some(run))
                        && key.is_none_or(|key| matches_event(state, key, agent))
                })
                .and_then(|state| state.scope());
            if let Some(target) = target {
                return self.invalidate(&target.session_key, target.agent_id.as_deref());
            }
        }
        if name == "sessions.changed"
            && payload["phase"] == "message"
            && payload.get("message").is_none()
            && payload.get("messageId").is_none()
            && payload.get("messageSeq").is_none()
            && let Some(key) = key
        {
            return self.invalidate(key, agent);
        }
        if name == "sessions.changed"
            && matches!(reason, Some("delete" | "cleanup"))
            && let Some(key) = key
        {
            let id = payload
                .get("sessionId")
                .or_else(|| payload.pointer("/session/sessionId"))
                .and_then(Value::as_str);
            return self.invalidate_generation(key, agent, id);
        }
        if name == "sessions.changed" && reason == Some("sharing") {
            if let Some(key) = key {
                return self.invalidate(key, agent);
            }
            self.entries.clear();
            if let Some(key) = self.current.selected_session.clone() {
                return self.invalidate(&key, None);
            }
            self.clear();
        }
        if (compacted || structural)
            && let Some(key) = key
        {
            return self.invalidate(key, agent);
        }
        if name == "sessions.changed"
            && let Some(key) = key
        {
            let id = payload
                .pointer("/session/sessionId")
                .or_else(|| payload.get("sessionId"))
                .and_then(Value::as_str);
            let changed = id.is_some_and(|id| {
                std::iter::once(&self.current)
                    .chain(self.entries.iter().map(|entry| &entry.state))
                    .any(|state| {
                        matches_event(state, key, agent)
                            && state
                                .session_info
                                .session_id
                                .as_deref()
                                .is_some_and(|old| old != id)
                    })
            });
            if changed {
                return self.invalidate(key, agent);
            }
        }
        false
    }

    pub fn prefetch(
        &self,
        key: String,
        agent: Option<String>,
    ) -> Option<(u64, ChatState, HistoryRequest)> {
        if self.contains(&key, agent.as_deref()) || self.entries.len() + 1 >= self.max_sessions {
            return None;
        }
        let mut state = ChatState::default();
        state.select_context(key, agent);
        let mut request = state.begin_history()?;
        request.startup = false;
        Some((self.generation, state, request))
    }

    pub fn finish_prefetch(&mut self, generation: u64, state: ChatState) {
        if generation != self.generation
            || state
                .selected_session
                .as_deref()
                .is_none_or(|key| self.contains(key, state.selected_agent.as_deref()))
        {
            return;
        }
        if self.entries.len() + 1 >= self.max_sessions
            || approximate_bytes(&self.current)
                + self.presentation_bytes
                + self.cached_bytes()
                + approximate_bytes(&state)
                > self.max_bytes
        {
            return;
        }
        let count = self.entries.len();
        self.retain(state, None);
        if self.entries.len() > count
            && let Some(entry) = self.entries.pop_back()
        {
            self.entries.push_front(entry);
        }
    }

    pub fn prefetch_is_current(&self, generation: u64) -> bool {
        generation == self.generation && !self.current.history_pending
    }
}

fn matches_context(state: &ChatState, key: &str, agent: Option<&str>) -> bool {
    state.selected_session.as_deref() == Some(key) && state.selected_agent.as_deref() == agent
}

fn matches_event(state: &ChatState, key: &str, agent: Option<&str>) -> bool {
    state.selected_session.as_deref() == Some(key)
        && agent.is_none_or(|agent| state.selected_agent.as_deref() == Some(agent))
}

fn value_bytes(value: &Value) -> usize {
    std::mem::size_of::<Value>()
        + match value {
            Value::String(s) => s.capacity(),
            Value::Array(items) => items.iter().map(value_bytes).sum(),
            Value::Object(items) => items
                .iter()
                .map(|(key, value)| key.capacity() + value_bytes(value) + 32)
                .sum(),
            _ => 0,
        }
}

fn approximate_bytes(state: &ChatState) -> usize {
    let tools = |tools: &[super::ToolCall]| {
        tools
            .iter()
            .map(|tool| {
                std::mem::size_of_val(tool)
                    + tool.id.capacity()
                    + tool.name.capacity()
                    + tool.output.capacity()
                    + value_bytes(&tool.args)
                    + value_bytes(&tool.result)
            })
            .sum::<usize>()
    };
    std::mem::size_of_val(state)
        + state.stream_text.capacity()
        + state.stream_thinking.capacity()
        + tools(&state.live_tools)
        + state
            .messages
            .iter()
            .map(|message| {
                std::mem::size_of_val(message)
                    + message.text.capacity()
                    + message.thinking.capacity()
                    + tools(&message.tools)
                    + message
                        .content
                        .iter()
                        .map(|content| {
                            std::mem::size_of_val(content)
                                + match content {
                                    super::MessageContent::Text(text) => text.capacity(),
                                    _ => 0,
                                }
                        })
                        .sum::<usize>()
                    + message
                        .attachments
                        .iter()
                        .map(|attachment| {
                            attachment.bytes.len() + attachment.file_name.capacity() + 128
                        })
                        .sum::<usize>()
                    + message
                        .media
                        .iter()
                        .map(|media| {
                            std::mem::size_of_val(media)
                                + [
                                    &media.path,
                                    &media.artifact_id,
                                    &media.url,
                                    &media.content_type,
                                    &media.file_name,
                                    &media.alt,
                                ]
                                .into_iter()
                                .flatten()
                                .map(String::capacity)
                                .sum::<usize>()
                        })
                        .sum::<usize>()
                    + value_bytes(&message.source_clients)
                    + 512
            })
            .sum::<usize>()
}

#[cfg(test)]
mod tests;
