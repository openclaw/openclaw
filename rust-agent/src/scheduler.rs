use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::config::{GroupActivationMode, SessionQueueMode};
use crate::session_key::{parse_session_key, SessionKind};
use crate::types::ActionRequest;

#[derive(Debug, Clone)]
pub enum SubmitOutcome {
    Dispatch(ActionRequest),
    Queued,
    Dropped {
        request_id: String,
        session_id: String,
    },
    IgnoredActivation {
        request_id: String,
        session_id: String,
    },
}

#[derive(Debug, Clone, Copy)]
pub struct SessionSchedulerConfig {
    pub max_pending: usize,
    pub queue_mode: SessionQueueMode,
    pub group_activation_mode: GroupActivationMode,
}

impl SessionSchedulerConfig {
    pub fn new(
        max_pending: usize,
        queue_mode: SessionQueueMode,
        group_activation_mode: GroupActivationMode,
    ) -> Self {
        Self {
            max_pending: max_pending.max(1),
            queue_mode,
            group_activation_mode,
        }
    }
}

pub struct SessionScheduler {
    config: SessionSchedulerConfig,
    inner: Mutex<SessionSchedulerState>,
}

#[derive(Default)]
struct SessionSchedulerState {
    active_sessions: HashSet<String>,
    queues: HashMap<String, VecDeque<ActionRequest>>,
    total_pending: usize,
}

impl SessionScheduler {
    pub fn new(config: SessionSchedulerConfig) -> Self {
        Self {
            config,
            inner: Mutex::new(SessionSchedulerState::default()),
        }
    }

    pub fn session_key(request: &ActionRequest) -> String {
        request
            .session_id
            .clone()
            .unwrap_or_else(|| "global".to_owned())
    }

    pub async fn submit(&self, request: ActionRequest) -> SubmitOutcome {
        self.submit_with_overrides(request, None, None).await
    }

    pub async fn submit_with_overrides(
        &self,
        request: ActionRequest,
        queue_mode_override: Option<SessionQueueMode>,
        group_activation_override: Option<GroupActivationMode>,
    ) -> SubmitOutcome {
        let session_id = Self::session_key(&request);
        let group_activation_mode =
            group_activation_override.unwrap_or(self.config.group_activation_mode);
        if self.should_ignore_for_activation(&request, &session_id, group_activation_mode) {
            return SubmitOutcome::IgnoredActivation {
                request_id: request.id,
                session_id,
            };
        }

        let mut guard = self.inner.lock().await;

        if !guard.active_sessions.contains(&session_id) {
            guard.active_sessions.insert(session_id);
            return SubmitOutcome::Dispatch(request);
        }

        if guard.total_pending >= self.config.max_pending {
            return SubmitOutcome::Dropped {
                request_id: request.id,
                session_id,
            };
        }

        let queue_mode = queue_mode_override.unwrap_or(self.config.queue_mode);
        match queue_mode {
            SessionQueueMode::Followup => {
                let queue = guard.queues.entry(session_id).or_insert_with(VecDeque::new);
                queue.push_back(request);
                guard.total_pending += 1;
            }
            SessionQueueMode::Steer => {
                let dropped = guard
                    .queues
                    .get(&session_id)
                    .map(VecDeque::len)
                    .unwrap_or(0);
                if dropped > 0 {
                    guard.total_pending = guard.total_pending.saturating_sub(dropped);
                }
                let queue = guard.queues.entry(session_id).or_insert_with(VecDeque::new);
                queue.clear();
                queue.push_back(request);
                guard.total_pending += 1;
            }
            SessionQueueMode::SteerBacklog => {
                let queue = guard.queues.entry(session_id).or_insert_with(VecDeque::new);
                queue.push_back(request);
                guard.total_pending += 1;
            }
            SessionQueueMode::Interrupt => {
                let dropped = guard
                    .queues
                    .get(&session_id)
                    .map(VecDeque::len)
                    .unwrap_or(0);
                if dropped > 0 {
                    guard.total_pending = guard.total_pending.saturating_sub(dropped);
                }
                let queue = guard.queues.entry(session_id).or_insert_with(VecDeque::new);
                queue.clear();
                queue.push_back(request);
                guard.total_pending += 1;
            }
            SessionQueueMode::Collect => {
                let queue = guard.queues.entry(session_id).or_insert_with(VecDeque::new);
                if let Some(last) = queue.back_mut() {
                    if collect_prompt_followup(last, &request) {
                        return SubmitOutcome::Queued;
                    }
                }
                queue.push_back(request);
                guard.total_pending += 1;
            }
        }
        SubmitOutcome::Queued
    }

    pub async fn complete(&self, request: &ActionRequest) -> Option<ActionRequest> {
        self.complete_session(&Self::session_key(request)).await
    }

    async fn complete_session(&self, session_id: &str) -> Option<ActionRequest> {
        let mut guard = self.inner.lock().await;
        let mut queue_empty = false;
        let next = if let Some(queue) = guard.queues.get_mut(session_id) {
            let next = queue.pop_front();
            queue_empty = queue.is_empty();
            next
        } else {
            None
        };

        if let Some(next_request) = next {
            guard.total_pending = guard.total_pending.saturating_sub(1);
            if queue_empty {
                guard.queues.remove(session_id);
            }
            return Some(next_request);
        }

        guard.queues.remove(session_id);
        guard.active_sessions.remove(session_id);
        None
    }

    fn should_ignore_for_activation(
        &self,
        request: &ActionRequest,
        session_id: &str,
        group_activation_mode: GroupActivationMode,
    ) -> bool {
        if group_activation_mode == GroupActivationMode::Always {
            return false;
        }
        is_group_context(request, session_id) && !was_mentioned(request)
    }
}

fn collect_prompt_followup(existing: &mut ActionRequest, incoming: &ActionRequest) -> bool {
    if !is_collectable(existing) || !is_collectable(incoming) {
        return false;
    }
    let Some(incoming_prompt) = incoming.prompt.as_deref() else {
        return false;
    };
    let Some(existing_prompt) = existing.prompt.as_mut() else {
        return false;
    };

    if !existing_prompt.trim().is_empty() {
        existing_prompt.push_str("\n\n");
    }
    existing_prompt.push_str(incoming_prompt);
    existing.id = incoming.id.clone();
    true
}

fn is_collectable(request: &ActionRequest) -> bool {
    request.prompt.is_some()
        && request.command.is_none()
        && request.url.is_none()
        && request.file_path.is_none()
}

fn is_group_context(request: &ActionRequest, session_id: &str) -> bool {
    let parsed = parse_session_key(session_id);
    if matches!(parsed.kind, SessionKind::Group | SessionKind::Channel) {
        return true;
    }
    raw_string(
        &request.raw,
        &["chatType", "chat_type", "chat", "roomType", "room_type"],
    )
    .map(|v| matches!(v.as_str(), "group" | "channel" | "room"))
    .unwrap_or(false)
}

fn was_mentioned(request: &ActionRequest) -> bool {
    raw_bool(
        &request.raw,
        &[
            "wasMentioned",
            "WasMentioned",
            "mentioned",
            "isMentioned",
            "requireMentionSatisfied",
        ],
    )
    .unwrap_or(false)
}

fn raw_string(root: &Value, keys: &[&str]) -> Option<String> {
    let map = root.as_object()?;
    keys.iter().find_map(|key| {
        map.get(*key)
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
    })
}

fn raw_bool(root: &Value, keys: &[&str]) -> Option<bool> {
    let map = root.as_object()?;
    keys.iter()
        .find_map(|key| map.get(*key).and_then(value_to_bool))
}

fn value_to_bool(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(v) => Some(*v),
        Value::Number(n) => n.as_i64().map(|v| v != 0),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{SessionScheduler, SessionSchedulerConfig, SubmitOutcome};
    use crate::config::{GroupActivationMode, SessionQueueMode};
    use crate::types::ActionRequest;

    fn scheduler(
        max_pending: usize,
        queue_mode: SessionQueueMode,
        group_activation_mode: GroupActivationMode,
    ) -> SessionScheduler {
        SessionScheduler::new(SessionSchedulerConfig::new(
            max_pending,
            queue_mode,
            group_activation_mode,
        ))
    }

    fn req(id: &str, session_id: Option<&str>, prompt: Option<&str>) -> ActionRequest {
        ActionRequest {
            id: id.to_owned(),
            source: "test".to_owned(),
            session_id: session_id.map(ToOwned::to_owned),
            prompt: prompt.map(ToOwned::to_owned),
            command: None,
            tool_name: None,
            channel: None,
            url: None,
            file_path: None,
            raw: json!({}),
        }
    }

    #[tokio::test]
    async fn dispatches_first_request_per_session() {
        let scheduler = scheduler(32, SessionQueueMode::Followup, GroupActivationMode::Always);
        assert!(matches!(
            scheduler.submit(req("r1", Some("s1"), Some("a"))).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(req("r2", Some("s1"), Some("b"))).await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler.submit(req("r3", Some("s2"), Some("c"))).await,
            SubmitOutcome::Dispatch(_)
        ));
    }

    #[tokio::test]
    async fn drains_session_queue_in_order_on_complete() {
        let scheduler = scheduler(32, SessionQueueMode::Followup, GroupActivationMode::Always);
        let r1 = req("r1", Some("s1"), Some("a"));
        let r2 = req("r2", Some("s1"), Some("b"));
        let r3 = req("r3", Some("s1"), Some("c"));

        assert!(matches!(
            scheduler.submit(r1.clone()).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(r2.clone()).await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler.submit(r3.clone()).await,
            SubmitOutcome::Queued
        ));

        let next = scheduler.complete(&r1).await.expect("next r2");
        assert_eq!(next.id, "r2");
        let next = scheduler.complete(&r2).await.expect("next r3");
        assert_eq!(next.id, "r3");
        assert!(scheduler.complete(&r3).await.is_none());
    }

    #[tokio::test]
    async fn drops_when_pending_capacity_is_exhausted() {
        let scheduler = scheduler(1, SessionQueueMode::Followup, GroupActivationMode::Always);
        assert!(matches!(
            scheduler.submit(req("r1", Some("s1"), Some("a"))).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(req("r2", Some("s1"), Some("b"))).await,
            SubmitOutcome::Queued
        ));

        let dropped = scheduler.submit(req("r3", Some("s1"), Some("c"))).await;
        match dropped {
            SubmitOutcome::Dropped {
                request_id,
                session_id,
            } => {
                assert_eq!(request_id, "r3");
                assert_eq!(session_id, "s1");
            }
            _ => panic!("expected dropped outcome"),
        }
    }

    #[tokio::test]
    async fn steer_mode_keeps_latest_pending_message() {
        let scheduler = scheduler(8, SessionQueueMode::Steer, GroupActivationMode::Always);
        let r1 = req("r1", Some("s1"), Some("a"));
        let r2 = req("r2", Some("s1"), Some("b"));
        let r3 = req("r3", Some("s1"), Some("c"));

        assert!(matches!(
            scheduler.submit(r1.clone()).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(r2.clone()).await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler.submit(r3.clone()).await,
            SubmitOutcome::Queued
        ));

        let next = scheduler.complete(&r1).await.expect("next latest");
        assert_eq!(next.id, "r3");
        assert!(scheduler.complete(&next).await.is_none());
    }

    #[tokio::test]
    async fn collect_mode_merges_prompt_followups() {
        let scheduler = scheduler(8, SessionQueueMode::Collect, GroupActivationMode::Always);
        let r1 = req("r1", Some("s1"), Some("alpha"));
        let r2 = req("r2", Some("s1"), Some("beta"));
        let r3 = req("r3", Some("s1"), Some("gamma"));

        assert!(matches!(
            scheduler.submit(r1.clone()).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(r2.clone()).await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler.submit(r3.clone()).await,
            SubmitOutcome::Queued
        ));

        let merged = scheduler.complete(&r1).await.expect("merged queue item");
        assert_eq!(merged.id, "r3");
        assert_eq!(merged.prompt.as_deref(), Some("beta\n\ngamma"));
    }

    #[tokio::test]
    async fn mention_activation_ignores_non_mentioned_group_message() {
        let scheduler = scheduler(8, SessionQueueMode::Followup, GroupActivationMode::Mention);
        let mut request = req("r1", Some("agent:main:discord:group:g1"), Some("hello"));
        request.raw = json!({"chatType":"group","wasMentioned": false});

        let out = scheduler.submit(request).await;
        assert!(matches!(
            out,
            SubmitOutcome::IgnoredActivation {
                request_id,
                session_id
            } if request_id == "r1" && session_id == "agent:main:discord:group:g1"
        ));
    }

    #[tokio::test]
    async fn mention_activation_accepts_mentioned_group_message() {
        let scheduler = scheduler(8, SessionQueueMode::Followup, GroupActivationMode::Mention);
        let mut request = req("r1", Some("agent:main:discord:group:g1"), Some("hello"));
        request.raw = json!({"chatType":"group","wasMentioned": true});

        assert!(matches!(
            scheduler.submit(request).await,
            SubmitOutcome::Dispatch(_)
        ));
    }

    #[tokio::test]
    async fn submit_with_overrides_allows_activation_override() {
        let scheduler = scheduler(8, SessionQueueMode::Followup, GroupActivationMode::Mention);
        let mut request = req("r1", Some("agent:main:discord:group:g1"), Some("hello"));
        request.raw = json!({"chatType":"group","wasMentioned": false});

        assert!(matches!(
            scheduler
                .submit_with_overrides(request, None, Some(GroupActivationMode::Always))
                .await,
            SubmitOutcome::Dispatch(_)
        ));
    }

    #[tokio::test]
    async fn submit_with_overrides_uses_queue_mode_override() {
        let scheduler = scheduler(8, SessionQueueMode::Followup, GroupActivationMode::Always);
        let r1 = req("r1", Some("s1"), Some("a"));
        let r2 = req("r2", Some("s1"), Some("b"));
        let r3 = req("r3", Some("s1"), Some("c"));

        assert!(matches!(
            scheduler.submit(r1.clone()).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler
                .submit_with_overrides(r2.clone(), Some(SessionQueueMode::Steer), None)
                .await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler
                .submit_with_overrides(r3.clone(), Some(SessionQueueMode::Steer), None)
                .await,
            SubmitOutcome::Queued
        ));

        let next = scheduler.complete(&r1).await.expect("next latest");
        assert_eq!(next.id, "r3");
        assert!(scheduler.complete(&next).await.is_none());
    }

    #[tokio::test]
    async fn steer_backlog_mode_keeps_all_pending_items() {
        let scheduler = scheduler(
            8,
            SessionQueueMode::SteerBacklog,
            GroupActivationMode::Always,
        );
        let r1 = req("r1", Some("s1"), Some("a"));
        let r2 = req("r2", Some("s1"), Some("b"));
        let r3 = req("r3", Some("s1"), Some("c"));

        assert!(matches!(
            scheduler.submit(r1.clone()).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(r2.clone()).await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler.submit(r3.clone()).await,
            SubmitOutcome::Queued
        ));

        let next = scheduler.complete(&r1).await.expect("next r2");
        assert_eq!(next.id, "r2");
        let next = scheduler.complete(&next).await.expect("next r3");
        assert_eq!(next.id, "r3");
        assert!(scheduler.complete(&next).await.is_none());
    }

    #[tokio::test]
    async fn interrupt_mode_replaces_pending_followups() {
        let scheduler = scheduler(8, SessionQueueMode::Interrupt, GroupActivationMode::Always);
        let r1 = req("r1", Some("s1"), Some("a"));
        let r2 = req("r2", Some("s1"), Some("b"));
        let r3 = req("r3", Some("s1"), Some("c"));

        assert!(matches!(
            scheduler.submit(r1.clone()).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(r2.clone()).await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler.submit(r3.clone()).await,
            SubmitOutcome::Queued
        ));

        let next = scheduler.complete(&r1).await.expect("next latest");
        assert_eq!(next.id, "r3");
        assert!(scheduler.complete(&next).await.is_none());
    }

    #[test]
    fn uses_global_session_for_missing_session_id() {
        let request = req("r1", None, Some("x"));
        assert_eq!(SessionScheduler::session_key(&request), "global");
    }
}
