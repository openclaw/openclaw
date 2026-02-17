use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::types::{ActionRequest, Decision, DecisionAction};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionState {
    pub session_id: String,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
    pub total_requests: u64,
    pub allowed_count: u64,
    pub review_count: u64,
    pub blocked_count: u64,
    pub last_action: DecisionAction,
    pub last_risk_score: u8,
    pub last_source: String,
    pub last_channel: Option<String>,
}

pub struct SessionStateStore {
    path: PathBuf,
    sessions: RwLock<HashMap<String, SessionState>>,
}

impl SessionStateStore {
    pub async fn new(path: PathBuf) -> Result<Self> {
        let sessions = if path.exists() {
            let text = tokio::fs::read_to_string(&path).await.unwrap_or_default();
            serde_json::from_str::<HashMap<String, SessionState>>(&text).unwrap_or_default()
        } else {
            HashMap::new()
        };

        Ok(Self {
            path,
            sessions: RwLock::new(sessions),
        })
    }

    pub async fn record(&self, request: &ActionRequest, decision: &Decision) -> Result<()> {
        let session_id = request
            .session_id
            .clone()
            .unwrap_or_else(|| "global".to_owned());
        let now = now_ms();
        {
            let mut sessions = self.sessions.write().await;
            let entry = sessions
                .entry(session_id.clone())
                .or_insert_with(|| SessionState {
                    session_id: session_id.clone(),
                    first_seen_ms: now,
                    last_seen_ms: now,
                    total_requests: 0,
                    allowed_count: 0,
                    review_count: 0,
                    blocked_count: 0,
                    last_action: DecisionAction::Allow,
                    last_risk_score: 0,
                    last_source: "unknown".to_owned(),
                    last_channel: None,
                });

            entry.last_seen_ms = now;
            entry.total_requests += 1;
            entry.last_action = decision.action;
            entry.last_risk_score = decision.risk_score;
            entry.last_source = request.source.clone();
            entry.last_channel = request.channel.clone();

            match decision.action {
                DecisionAction::Allow => entry.allowed_count += 1,
                DecisionAction::Review => entry.review_count += 1,
                DecisionAction::Block => entry.blocked_count += 1,
            }
        }
        self.persist().await
    }

    async fn persist(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let snapshot = {
            let sessions = self.sessions.read().await;
            serde_json::to_vec_pretty(&*sessions)?
        };
        tokio::fs::write(&self.path, snapshot).await?;
        Ok(())
    }

    #[cfg(test)]
    async fn get(&self, session_id: &str) -> Option<SessionState> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).cloned()
    }
}

#[derive(Clone)]
struct IdempotencyEntry {
    decision: Decision,
    expires_at_ms: u64,
}

pub struct IdempotencyCache {
    ttl: Duration,
    max_entries: usize,
    entries: Mutex<HashMap<String, IdempotencyEntry>>,
}

impl IdempotencyCache {
    pub fn new(ttl: Duration, max_entries: usize) -> Self {
        Self {
            ttl,
            max_entries: max_entries.max(32),
            entries: Mutex::new(HashMap::new()),
        }
    }

    pub fn key_for_request(request: &ActionRequest) -> String {
        if request.id != "unknown" && !request.id.trim().is_empty() {
            format!("id:{}", request.id)
        } else {
            let mut h = DefaultHasher::new();
            request.session_id.hash(&mut h);
            request.prompt.hash(&mut h);
            request.command.hash(&mut h);
            request.tool_name.hash(&mut h);
            request.channel.hash(&mut h);
            request.url.hash(&mut h);
            request.file_path.hash(&mut h);
            format!("sig:{:x}", h.finish())
        }
    }

    pub async fn get(&self, key: &str) -> Option<Decision> {
        let now = now_ms();
        let mut entries = self.entries.lock().await;
        entries.retain(|_, value| value.expires_at_ms > now);
        entries.get(key).map(|entry| entry.decision.clone())
    }

    pub async fn put(&self, key: String, decision: Decision) {
        let now = now_ms();
        let mut entries = self.entries.lock().await;
        entries.retain(|_, value| value.expires_at_ms > now);

        if entries.len() >= self.max_entries {
            if let Some(oldest_key) = entries
                .iter()
                .min_by_key(|(_, v)| v.expires_at_ms)
                .map(|(k, _)| k.clone())
            {
                entries.remove(&oldest_key);
            }
        }

        entries.insert(
            key,
            IdempotencyEntry {
                decision,
                expires_at_ms: now + self.ttl.as_millis() as u64,
            },
        );
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use std::time::Duration;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{IdempotencyCache, SessionStateStore};
    use crate::types::{ActionRequest, Decision, DecisionAction};

    fn temp_state_path(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        p.push(format!("openclaw-rs-state-{name}-{stamp}.json"));
        p
    }

    #[tokio::test]
    async fn records_session_counters() {
        let store = SessionStateStore::new(temp_state_path("record"))
            .await
            .expect("store");
        let req = ActionRequest {
            id: "req-1".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("s-1".to_owned()),
            prompt: Some("hello".to_owned()),
            command: None,
            tool_name: Some("browser".to_owned()),
            channel: Some("discord".to_owned()),
            url: None,
            file_path: None,
            raw: serde_json::json!({}),
        };
        let decision = Decision {
            action: DecisionAction::Review,
            risk_score: 44,
            reasons: vec!["test".to_owned()],
            tags: vec!["x".to_owned()],
            source: "openclaw-agent-rs".to_owned(),
        };
        store.record(&req, &decision).await.expect("record");
        let state = store.get("s-1").await.expect("state");
        assert_eq!(state.total_requests, 1);
        assert_eq!(state.review_count, 1);
        assert_eq!(state.last_action, DecisionAction::Review);
        assert_eq!(state.last_channel.as_deref(), Some("discord"));
    }

    #[tokio::test]
    async fn reuses_cached_decision_by_request_id() {
        let cache = IdempotencyCache::new(Duration::from_secs(60), 128);
        let req = ActionRequest {
            id: "req-abc".to_owned(),
            source: "agent".to_owned(),
            session_id: Some("s-1".to_owned()),
            prompt: None,
            command: Some("git status".to_owned()),
            tool_name: Some("exec".to_owned()),
            channel: None,
            url: None,
            file_path: None,
            raw: serde_json::json!({}),
        };
        let key = IdempotencyCache::key_for_request(&req);
        let decision = Decision {
            action: DecisionAction::Allow,
            risk_score: 20,
            reasons: vec![],
            tags: vec![],
            source: "openclaw-agent-rs".to_owned(),
        };

        cache.put(key.clone(), decision.clone()).await;
        let cached = cache.get(&key).await.expect("cached");
        assert_eq!(cached.action, decision.action);
        assert_eq!(cached.risk_score, decision.risk_score);
    }
}
