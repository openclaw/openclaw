use std::collections::{HashMap, HashSet, VecDeque};

use tokio::sync::Mutex;

use crate::types::ActionRequest;

#[derive(Debug, Clone)]
pub enum SubmitOutcome {
    Dispatch(ActionRequest),
    Queued,
    Dropped {
        request_id: String,
        session_id: String,
    },
}

pub struct SessionScheduler {
    max_pending: usize,
    inner: Mutex<SessionSchedulerState>,
}

#[derive(Default)]
struct SessionSchedulerState {
    active_sessions: HashSet<String>,
    queues: HashMap<String, VecDeque<ActionRequest>>,
    total_pending: usize,
}

impl SessionScheduler {
    pub fn new(max_pending: usize) -> Self {
        Self {
            max_pending: max_pending.max(1),
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
        let session_id = Self::session_key(&request);
        let mut guard = self.inner.lock().await;

        if !guard.active_sessions.contains(&session_id) {
            guard.active_sessions.insert(session_id);
            return SubmitOutcome::Dispatch(request);
        }

        if guard.total_pending >= self.max_pending {
            return SubmitOutcome::Dropped {
                request_id: request.id,
                session_id,
            };
        }

        guard
            .queues
            .entry(session_id)
            .or_insert_with(VecDeque::new)
            .push_back(request);
        guard.total_pending += 1;
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
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{SessionScheduler, SubmitOutcome};
    use crate::types::ActionRequest;

    fn req(id: &str, session_id: Option<&str>) -> ActionRequest {
        ActionRequest {
            id: id.to_owned(),
            source: "test".to_owned(),
            session_id: session_id.map(ToOwned::to_owned),
            prompt: Some("ping".to_owned()),
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
        let scheduler = SessionScheduler::new(32);
        assert!(matches!(
            scheduler.submit(req("r1", Some("s1"))).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(req("r2", Some("s1"))).await,
            SubmitOutcome::Queued
        ));
        assert!(matches!(
            scheduler.submit(req("r3", Some("s2"))).await,
            SubmitOutcome::Dispatch(_)
        ));
    }

    #[tokio::test]
    async fn drains_session_queue_in_order_on_complete() {
        let scheduler = SessionScheduler::new(32);
        let r1 = req("r1", Some("s1"));
        let r2 = req("r2", Some("s1"));
        let r3 = req("r3", Some("s1"));

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
        let scheduler = SessionScheduler::new(1);
        assert!(matches!(
            scheduler.submit(req("r1", Some("s1"))).await,
            SubmitOutcome::Dispatch(_)
        ));
        assert!(matches!(
            scheduler.submit(req("r2", Some("s1"))).await,
            SubmitOutcome::Queued
        ));

        let dropped = scheduler.submit(req("r3", Some("s1"))).await;
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

    #[test]
    fn uses_global_session_for_missing_session_id() {
        let request = req("r1", None);
        assert_eq!(SessionScheduler::session_key(&request), "global");
    }
}
