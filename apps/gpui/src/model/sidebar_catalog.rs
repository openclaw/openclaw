//! Plugin session catalog projection; wire owner: schema/sessions-catalog.ts.
use super::{
    sessions::SessionRow,
    sidebar::{Grouping, actor_group_id, fold_worktree_path},
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CatalogSession {
    pub thread_id: String,
    pub source_home_id: Option<String>,
    pub name: Option<String>,
    pub cwd: Option<String>,
    pub custom_group: Option<String>,
    pub session_key: Option<String>,
    pub created_actor: Option<Value>,
    pub archived: bool,
}
impl CatalogSession {
    pub fn title(&self) -> &str {
        self.name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(&self.thread_id)
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CatalogHost {
    pub host_id: String,
    pub label: String,
    pub connected: bool,
    pub pending: bool,
    pub sessions: Vec<CatalogSession>,
    pub next_cursor: Option<String>,
    pub error: Option<CatalogError>,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CatalogCapabilities {
    pub start_terminal: bool,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct CatalogError {
    pub code: String,
    pub message: String,
}
impl CatalogError {
    pub fn label(&self) -> String {
        format!("[{}] {}", self.code, self.message)
    }
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct Catalog {
    pub id: String,
    pub label: String,
    pub capabilities: CatalogCapabilities,
    pub hosts: Vec<CatalogHost>,
    pub error: Option<CatalogError>,
}
#[derive(Default, Deserialize)]
pub struct CatalogResult {
    pub catalogs: Vec<Catalog>,
}

pub struct CatalogGroup<'a> {
    pub key: String,
    pub label: String,
    pub sessions: Vec<&'a CatalogSession>,
}

pub fn grouped_sessions<'a>(
    sessions: &'a [CatalogSession],
    grouping: Grouping,
    owner: Option<&str>,
    live: &[SessionRow],
) -> Vec<CatalogGroup<'a>> {
    let mut groups: Vec<CatalogGroup<'a>> = Vec::new();
    for session in sessions {
        let row = session
            .session_key
            .as_deref()
            .and_then(|key| live.iter().find(|row| row.key == key));
        let actor = row
            .map(|row| row.owner.as_ref().and_then(|owner| owner.get("actor")))
            .unwrap_or(session.created_actor.as_ref());
        if owner.is_some_and(|id| {
            actor
                .and_then(|actor| actor.get("id"))
                .and_then(Value::as_str)
                != Some(id)
        }) {
            continue;
        }
        let (key, label) = match grouping {
            Grouping::Person => session
                .created_actor
                .as_ref()
                .and_then(|actor| {
                    Some((
                        format!("person:{}", actor_group_id(actor)?),
                        actor
                            .get("label")
                            .and_then(Value::as_str)
                            .or_else(|| actor.get("id").and_then(Value::as_str))?
                            .to_owned(),
                    ))
                })
                .unwrap_or_default(),
            Grouping::None => (String::new(), String::new()),
            Grouping::Project | Grouping::Category => {
                if let Some(custom) = session
                    .custom_group
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    (format!("custom:{custom}"), custom.to_owned())
                } else if let Some(path) = session.cwd.as_deref().and_then(fold_worktree_path) {
                    let label = path.rsplit(['/', '\\']).next().unwrap_or(&path).to_owned();
                    (format!("project:{path}"), label)
                } else {
                    (String::new(), String::new())
                }
            }
        };
        if let Some(group) = groups.iter_mut().find(|group| group.key == key) {
            group.sessions.push(session);
        } else {
            groups.push(CatalogGroup {
                key,
                label,
                sessions: vec![session],
            });
        }
    }
    // Web preserves first-seen projects, keeps custom groups first and the flat tail last.
    groups.sort_by(|a, b| {
        let rank = |key: &str| {
            if key.starts_with("custom:") {
                0
            } else if key.is_empty() {
                2
            } else {
                1
            }
        };
        rank(&a.key).cmp(&rank(&b.key)).then_with(|| {
            if grouping == Grouping::Person {
                a.label.to_lowercase().cmp(&b.label.to_lowercase())
            } else {
                std::cmp::Ordering::Equal
            }
        })
    });
    groups
}

/// Only rendered catalogs own adopted keys. Hidden/archived sections cannot suppress native rows.
pub fn adopted_keys(
    catalogs: &[Catalog],
    hidden: &BTreeSet<String>,
    archived_only: bool,
) -> BTreeSet<String> {
    if archived_only {
        return BTreeSet::new();
    }
    catalogs
        .iter()
        .filter(|catalog| !hidden.contains(&catalog.id))
        .flat_map(|catalog| &catalog.hosts)
        .flat_map(|host| &host.sessions)
        .filter_map(|session| session.session_key.clone())
        .collect()
}

/// A paging failure retains the previous page; successful pages replace duplicate identities.
pub fn merge_page(current: &mut Catalog, page: Catalog, cursors: &BTreeMap<String, String>) {
    current.error = page.error;
    for mut host in page.hosts {
        let Some(previous) = current
            .hosts
            .iter_mut()
            .find(|entry| entry.host_id == host.host_id)
        else {
            current.hosts.push(host);
            continue;
        };
        if host.error.is_some() && host.sessions.is_empty() {
            previous.connected = host.connected;
            previous.error = host.error;
            continue;
        }
        let mut sessions = std::mem::take(&mut previous.sessions);
        for row in host.sessions {
            if let Some(existing) = sessions
                .iter_mut()
                .find(|entry| entry.thread_id == row.thread_id)
            {
                *existing = row;
            } else {
                sessions.push(row);
            }
        }
        host.sessions = sessions;
        if host
            .next_cursor
            .as_ref()
            .is_some_and(|next| cursors.get(&host.host_id) == Some(next))
        {
            host.next_cursor = None;
            host.error = Some(CatalogError {
                code: "CURSOR_STALLED".into(),
                message: "The source did not advance. Refresh this catalog to retry.".into(),
            });
        }
        *previous = host;
    }
}

/// Matches route-navigation.ts: catalog viewer overlays the selected agent's main chat route.
pub fn viewer_path(agent: &str, catalog: &str, host: &str, session: &CatalogSession) -> String {
    let mut url = url::Url::parse("https://control.invalid/chat/").expect("constant URL");
    url.path_segments_mut()
        .expect("hierarchical URL")
        .pop_if_empty()
        .push(agent);
    url.query_pairs_mut()
        .append_pair("catalog", catalog)
        .append_pair("host", host)
        .append_pair("thread", &session.thread_id);
    if let Some(source) = &session.source_home_id {
        url.query_pairs_mut().append_pair("sourceHomeId", source);
    }
    format!("{}?{}", url.path(), url.query().unwrap_or_default())
}

pub fn new_session_path(agent: &str, catalog: &str) -> String {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("agent", agent)
        .append_pair("catalog", catalog)
        .finish();
    format!("/new?{query}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn catalog_route_preserves_opaque_identifiers_and_source_home() {
        let row: CatalogSession =
            serde_json::from_value(json!({"threadId":"a:b & c","sourceHomeId":"home/2"})).unwrap();
        let path = viewer_path("qa", "provider/x", "local:one", &row);
        let url = url::Url::parse(&format!("https://control.invalid{path}")).unwrap();
        assert_eq!(url.path(), "/chat/qa");
        assert_eq!(
            url.query_pairs().into_owned().collect::<Vec<_>>(),
            [
                ("catalog".into(), "provider/x".into()),
                ("host".into(), "local:one".into()),
                ("thread".into(), "a:b & c".into()),
                ("sourceHomeId".into(), "home/2".into())
            ]
        );
    }
    #[test]
    fn paging_replaces_duplicates_retains_offline_rows_and_stops_repeated_cursor() {
        let mut current: Catalog = serde_json::from_value(json!({"id":"qa","hosts":[{"hostId":"local","sessions":[{"threadId":"a","name":"Before"}],"nextCursor":"p2"}]})).unwrap();
        let cursors = BTreeMap::from([("local".into(), "p2".into())]);
        let failure: Catalog = serde_json::from_value(json!({"hosts":[{"hostId":"local","error":{"code":"NODE_OFFLINE","message":"Offline"}}]})).unwrap();
        merge_page(&mut current, failure, &cursors);
        assert_eq!(current.hosts[0].sessions[0].title(), "Before");
        assert_eq!(current.hosts[0].next_cursor.as_deref(), Some("p2"));
        let page: Catalog = serde_json::from_value(json!({"hosts":[{"hostId":"local","sessions":[{"threadId":"a","name":"After"},{"threadId":"b"}],"nextCursor":"p2"}]})).unwrap();
        merge_page(&mut current, page, &cursors);
        assert_eq!(current.hosts[0].sessions.len(), 2);
        assert_eq!(current.hosts[0].sessions[0].title(), "After");
        assert!(current.hosts[0].next_cursor.is_none());
        assert_eq!(
            current.hosts[0].error.as_ref().unwrap().code,
            "CURSOR_STALLED"
        );
    }
    #[test]
    fn catalog_grouping_preserves_custom_groups_and_live_owner_authority() {
        let rows: Vec<CatalogSession> = serde_json::from_value(json!([
            {"threadId":"flat"},{"threadId":"work","cwd":"/repo/.claude/worktrees/topic/src"},
            {"threadId":"custom","cwd":"/repo","customGroup":"Release"},
            {"threadId":"adopted","sessionKey":"owned","createdActor":{"id":"old","identity":{"type":"profile","id":"old"}}}
        ])).unwrap();
        let groups = grouped_sessions(&rows, Grouping::Project, None, &[]);
        assert_eq!(
            groups
                .iter()
                .map(|group| group.key.as_str())
                .collect::<Vec<_>>(),
            ["custom:Release", "project:/repo", ""]
        );
        let live: Vec<SessionRow> =
            serde_json::from_value(json!([{"key":"owned","owner":{"actor":{"id":"new"}}}]))
                .unwrap();
        assert!(grouped_sessions(&rows, Grouping::None, Some("old"), &live).is_empty());
        assert_eq!(
            grouped_sessions(&rows, Grouping::None, Some("new"), &live)[0].sessions[0].thread_id,
            "adopted"
        );
        let catalog = Catalog {
            id: "qa".into(),
            hosts: vec![CatalogHost {
                sessions: rows,
                ..Default::default()
            }],
            ..Default::default()
        };
        assert!(
            adopted_keys(
                std::slice::from_ref(&catalog),
                &BTreeSet::from(["qa".into()]),
                false
            )
            .is_empty()
        );
        assert!(adopted_keys(std::slice::from_ref(&catalog), &BTreeSet::new(), true).is_empty());
        assert_eq!(
            adopted_keys(&[catalog], &BTreeSet::new(), false),
            BTreeSet::from(["owned".into()])
        );
    }
}
