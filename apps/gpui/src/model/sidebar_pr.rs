//! Pushed PR snapshots use the same retained-failure semantics as Control UI.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestSummary {
    pub numbers: Vec<u64>,
    pub state: String,
}
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PullRequest {
    number: u64,
    state: String,
    owner: String,
    repo: String,
    branch: String,
    url: String,
}
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Snapshot {
    status: String,
    pull_requests: Vec<PullRequest>,
    repository: Option<Value>,
    branch: Option<Value>,
}
impl Snapshot {
    fn repository(&self) -> Option<(&str, &str)> {
        if let Some(repository) = self.repository.as_ref().or(self.branch.as_ref()) {
            return Some((
                repository.get("owner")?.as_str()?,
                repository.get("repo")?.as_str()?,
            ));
        }
        self.pull_requests
            .first()
            .map(|pr| (pr.owner.as_str(), pr.repo.as_str()))
    }
    fn branch(&self) -> Option<&str> {
        self.branch
            .as_ref()
            .and_then(|branch| branch.get("branch"))
            .and_then(Value::as_str)
            .or_else(|| self.pull_requests.first().map(|pr| pr.branch.as_str()))
    }
    fn summary(&self) -> Option<PullRequestSummary> {
        let first = ["open", "draft", "merged"]
            .into_iter()
            .find_map(|state| self.pull_requests.iter().find(|pr| pr.state == state))
            .or_else(|| self.pull_requests.first())?;
        // Bound before sorting, matching the released web summary contract.
        let mut numbers = Vec::new();
        for pr in &self.pull_requests {
            if !numbers.contains(&pr.number) && numbers.len() < 20 {
                numbers.push(pr.number);
            }
        }
        numbers.sort_unstable();
        Some(PullRequestSummary {
            numbers,
            state: first.state.clone(),
        })
    }
}

#[derive(Default)]
pub struct PullRequestStore {
    watched: BTreeSet<String>,
    snapshots: BTreeMap<String, Snapshot>,
}
impl PullRequestStore {
    pub fn set_watched(&mut self, keys: Vec<String>) -> bool {
        let watched: BTreeSet<_> = keys
            .into_iter()
            .map(|key| key.trim().to_owned())
            .filter(|key| !key.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .take(200)
            .collect();
        if watched == self.watched {
            return false;
        }
        self.watched = watched;
        self.snapshots.retain(|key, _| self.watched.contains(key));
        true
    }
    pub fn watched_keys(&self) -> Vec<String> {
        self.watched.iter().cloned().collect()
    }
    pub fn apply_changed(&mut self, payload: &Value) -> bool {
        let Some(sessions) = payload.get("sessions").and_then(Value::as_object) else {
            return false;
        };
        let mut changed = false;
        for (key, value) in sessions {
            if !self.watched.contains(key) {
                continue;
            }
            let Ok(mut next) = serde_json::from_value::<Snapshot>(value.clone()) else {
                continue;
            };
            if let Some(current) = self.snapshots.get(key) {
                let same_repository = next
                    .repository()
                    .is_none_or(|repo| Some(repo) == current.repository());
                let same_branch = next.branch.as_ref().is_none()
                    || current.branch().is_none()
                    || next.branch() == current.branch();
                if same_repository
                    && same_branch
                    && matches!(next.status.as_str(), "rate-limited" | "unavailable")
                    && next.pull_requests.is_empty()
                {
                    next.pull_requests = current.pull_requests.clone();
                    next.branch = next.branch.or_else(|| current.branch.clone());
                    next.repository = next.repository.or_else(|| current.repository.clone());
                }
            }
            if self.snapshots.get(key) != Some(&next) {
                self.snapshots.insert(key.clone(), next);
                changed = true;
            }
        }
        changed
    }
    pub fn summary(&self, key: &str) -> Option<PullRequestSummary> {
        self.snapshots.get(key)?.summary()
    }
    pub fn menu_url(&self, key: &str) -> Option<&str> {
        let snapshot = self.snapshots.get(key)?;
        ["open", "draft", "merged", "closed"]
            .into_iter()
            .find_map(|state| {
                snapshot
                    .pull_requests
                    .iter()
                    .find(|pr| pr.state == state && !pr.url.is_empty())
            })
            .map(|pr| pr.url.as_str())
    }
    pub fn clear(&mut self) {
        self.watched.clear();
        self.snapshots.clear();
    }
}

pub fn scoped_key(key: &str, agent: Option<&str>) -> String {
    let key = key.trim();
    if key.is_empty() || key.starts_with("agent:") {
        return key.to_owned();
    }
    match agent.map(str::trim).filter(|agent| !agent.is_empty()) {
        Some(agent) => format!("agent:{}:{key}", agent.to_ascii_lowercase()),
        None => key.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn summaries_prioritize_active_work_and_retire_on_ready_empty_or_branch_change() {
        let mut store = PullRequestStore::default();
        store.set_watched(vec!["s".into()]);
        store.apply_changed(&json!({"sessions":{"s":{"status":"ready","repository":{"owner":"org","repo":"repo"},"pullRequests":[
            {"number":30,"state":"merged","owner":"org","repo":"repo","branch":"main","url":"https://example.test/pull/30"},
            {"number":10,"state":"draft","owner":"org","repo":"repo","branch":"feature"},
            {"number":20,"state":"open","owner":"org","repo":"repo","branch":"feature","url":"https://example.test/pull/20"}
        ]},"unwatched":{"status":"ready","pullRequests":[{"number":99,"state":"open"}]}}}));
        assert_eq!(
            store.summary("s"),
            Some(PullRequestSummary {
                numbers: vec![10, 20, 30],
                state: "open".into()
            })
        );
        assert_eq!(store.menu_url("s"), Some("https://example.test/pull/20"));
        assert!(store.summary("unwatched").is_none());
        store.apply_changed(&json!({"sessions":{"s":{"status":"unavailable","pullRequests":[]}}}));
        assert_eq!(store.summary("s").unwrap().numbers, vec![10, 20, 30]);
        store.apply_changed(&json!({"sessions":{"s":{"status":"rate-limited","branch":{"owner":"org","repo":"repo","branch":"new"},"pullRequests":[]}}}));
        assert!(store.summary("s").is_none());
        store.apply_changed(&json!({"sessions":{"s":{"status":"ready","pullRequests":[{"number":42,"state":"draft"}]}}}));
        assert_eq!(store.summary("s").unwrap().state, "draft");
        store.apply_changed(&json!({"sessions":{"s":{"status":"ready","pullRequests":[]}}}));
        assert!(store.summary("s").is_none());
    }
    #[test]
    fn subscriptions_bound_and_scope_global_identity() {
        let mut store = PullRequestStore::default();
        assert!(store.set_watched((0..205).map(|i| format!("agent:qa:{i:03}")).collect()));
        assert_eq!(store.watched_keys().len(), 200);
        assert!(!store.set_watched(store.watched_keys()));
        assert_eq!(scoped_key("global", Some("QA")), "agent:qa:global");
        assert_eq!(scoped_key("agent:qa:work", Some("other")), "agent:qa:work");
        store.clear();
        assert!(store.watched_keys().is_empty());
    }
}
