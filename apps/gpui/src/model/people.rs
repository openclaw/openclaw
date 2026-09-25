//! Presence projection shared with ui/src/lib/presence-users.ts and person-activity-card.ts.
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

use super::sessions::SessionRow;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
pub struct PersonIdentity {
    #[serde(rename = "type")]
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub identity: Option<PersonIdentity>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

impl Person {
    pub fn key(&self) -> String {
        match &self.identity {
            Some(identity) => format!("{}:{}", identity.kind, identity.id),
            None => format!("raw:{}", self.id),
        }
    }

    pub fn label(&self) -> &str {
        if self.id == "gateway-owner" {
            return "Shared owner";
        }
        clean(self.name.as_deref())
            .or_else(|| clean(self.email.as_deref()))
            .unwrap_or(&self.id)
    }

    pub fn profile_id(&self) -> Option<&str> {
        self.identity
            .as_ref()
            .filter(|identity| identity.kind == "profile")
            .map(|identity| identity.id.as_str())
    }

    pub fn from_actor(value: &Value) -> Option<Self> {
        let mut person: Self = serde_json::from_value(value.clone()).ok()?;
        if person.id.trim().is_empty() {
            person.id = person.identity.as_ref()?.id.clone();
        }
        person.name = value
            .get("label")
            .and_then(Value::as_str)
            .and_then(|label| clean(Some(label)))
            .map(str::to_owned)
            .or(person.name);
        Some(person)
    }
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PresenceEntry {
    pub user: Option<Person>,
    pub instance_id: Option<String>,
    pub reason: Option<String>,
    pub watched_sessions: Vec<String>,
    pub last_input_seconds: Option<u64>,
    pub online_since: Option<u64>,
    pub last_activity_at: Option<u64>,
    pub platform: Option<String>,
    pub device_family: Option<String>,
    pub client_id: Option<String>,
    pub mode: Option<String>,
    pub time_zone: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OnlinePerson {
    pub person: Person,
    pub entries: Vec<PresenceEntry>,
    pub watched_sessions: Vec<String>,
}

impl OnlinePerson {
    pub fn idle(&self) -> bool {
        let recencies: Vec<_> = self
            .entries
            .iter()
            .filter_map(|entry| entry.last_input_seconds)
            .collect();
        !recencies.is_empty() && recencies.iter().all(|seconds| *seconds > 120)
    }

    pub fn online_since(&self) -> Option<u64> {
        self.entries.iter().filter_map(|e| e.online_since).min()
    }

    pub fn last_activity_at(&self) -> Option<u64> {
        self.entries.iter().filter_map(|e| e.last_activity_at).max()
    }

    pub fn connections(&self) -> Vec<String> {
        self.entries
            .iter()
            .map(connection_label)
            .filter(|label| !label.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub fn time_zones(&self) -> Vec<String> {
        self.entries
            .iter()
            .filter_map(|entry| clean(entry.time_zone.as_deref()).map(str::to_owned))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }
}

#[derive(Default)]
pub struct PeopleState {
    pub entries: Vec<PresenceEntry>,
    pub self_user: Option<Person>,
    pub instance_id: Option<String>,
}

impl PeopleState {
    /// Presence events contain a complete snapshot, never an additive client delta.
    pub fn apply_presence(&mut self, payload: &Value) {
        let Some(value) = payload.get("presence").filter(|value| value.is_array()) else {
            return;
        };
        let Ok(entries) = serde_json::from_value::<Vec<PresenceEntry>>(value.clone()) else {
            return;
        };
        if let Some(user) = self.instance_id.as_deref().and_then(|instance| {
            entries
                .iter()
                .find(|entry| {
                    entry.instance_id.as_deref() == Some(instance)
                        && entry.reason.as_deref() != Some("disconnect")
                })
                .and_then(|entry| entry.user.as_ref())
                .filter(|user| !user.id.is_empty())
        }) {
            self.self_user = Some(user.clone());
        }
        // A live user's identity survives older Gateways pruning its presence entry.
        self.entries = entries;
    }

    pub fn apply_self_profile(&mut self, payload: &Value) {
        let Some(profile) = payload.get("profile") else {
            return;
        };
        let Some(id) = profile
            .get("id")
            .and_then(Value::as_str)
            .and_then(|s| clean(Some(s)))
        else {
            return;
        };
        let previous = self.self_user.as_ref().filter(|person| person.id == id);
        self.self_user = Some(Person {
            id: id.to_owned(),
            identity: Some(PersonIdentity {
                kind: "profile".into(),
                id: id.to_owned(),
            }),
            name: profile
                .get("displayName")
                .and_then(Value::as_str)
                .and_then(|s| clean(Some(s)))
                .map(str::to_owned),
            email: profile
                .get("emails")
                .and_then(Value::as_array)
                .and_then(|emails| emails.first())
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| previous.and_then(|person| person.email.clone())),
            avatar_url: Some(format!(
                "/api/users/{}/avatar?v={}",
                percent_encoding::utf8_percent_encode(id, percent_encoding::NON_ALPHANUMERIC),
                profile
                    .get("updatedAt")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            )),
        });
    }

    pub fn online_people(&self) -> Vec<OnlinePerson> {
        let self_key = self.self_user.as_ref().map(Person::key);
        let mut grouped: BTreeMap<String, Vec<PresenceEntry>> = BTreeMap::new();
        for entry in &self.entries {
            let Some(user) = &entry.user else { continue };
            if entry.reason.as_deref() == Some("disconnect")
                || user.id.is_empty()
                || self_key.as_ref() == Some(&user.key())
            {
                continue;
            }
            grouped.entry(user.key()).or_default().push(entry.clone());
        }
        let mut people: Vec<_> = grouped
            .into_values()
            .map(|entries| {
                let mut person = entries[0].user.clone().expect("grouped user");
                let first = |field: fn(&Person) -> &Option<String>| {
                    entries
                        .iter()
                        .filter_map(|entry| {
                            entry
                                .user
                                .as_ref()
                                .and_then(|person| clean(field(person).as_deref()))
                        })
                        .min()
                        .map(str::to_owned)
                };
                person.name = first(|person| &person.name);
                person.email = first(|person| &person.email);
                person.avatar_url = first(|person| &person.avatar_url);
                let watched_sessions = entries
                    .iter()
                    .flat_map(|entry| entry.watched_sessions.iter().cloned())
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                OnlinePerson {
                    person,
                    entries,
                    watched_sessions,
                }
            })
            .collect();
        people.sort_by(|a, b| {
            a.idle()
                .cmp(&b.idle())
                .then_with(|| {
                    a.person
                        .label()
                        .to_lowercase()
                        .cmp(&b.person.label().to_lowercase())
                })
                .then_with(|| a.person.key().cmp(&b.person.key()))
        });
        people
    }
}

/// A hover card can name only sessions already admitted by the roster owner.
pub fn card_sessions(
    person: &OnlinePerson,
    rows: &[SessionRow],
    agent: &str,
) -> (Vec<SessionRow>, Vec<SessionRow>) {
    let watched: BTreeSet<_> = person
        .watched_sessions
        .iter()
        .map(|key| card_session_identity(key, agent))
        .collect();
    let mut admitted: Vec<_> = rows.iter().collect();
    admitted.sort_by(|a, b| {
        b.updated_at
            .unwrap_or(0.)
            .total_cmp(&a.updated_at.unwrap_or(0.))
            .then_with(|| a.key.cmp(&b.key))
    });
    let mut seen = BTreeSet::new();
    let mut viewing = Vec::new();
    let mut recent = Vec::new();
    for row in admitted {
        let key = card_session_identity(&row.key, row.agent().unwrap_or(agent));
        if !seen.insert(key.clone()) {
            continue;
        }
        if watched.contains(&key) {
            if viewing.len() < 3 {
                viewing.push(row.clone());
            }
        } else if person.person.profile_id().is_some_and(|profile| {
            [
                row.owner.as_ref().and_then(|owner| owner.get("actor")),
                row.created_actor.as_ref(),
            ]
            .into_iter()
            .flatten()
            .filter_map(Person::from_actor)
            .any(|actor| actor.profile_id() == Some(profile))
        }) && recent.len() < 3
        {
            recent.push(row.clone());
        }
    }
    (viewing, recent)
}

fn card_session_identity(key: &str, agent: &str) -> String {
    let key = key.trim();
    let scoped =
        if key.to_ascii_lowercase().starts_with("agent:") || key.eq_ignore_ascii_case("global") {
            key.to_owned()
        } else {
            format!("agent:{agent}:{key}")
        };
    let mut parts: Vec<_> = scoped.split(':').map(str::to_owned).collect();
    let scope = if parts
        .first()
        .is_some_and(|part| part.eq_ignore_ascii_case("agent"))
    {
        parts.get(1).map(String::as_str).unwrap_or(agent)
    } else {
        agent
    }
    .to_ascii_lowercase();
    let mut start = 0;
    while parts.len() - start >= 3 && parts[start].eq_ignore_ascii_case("agent") {
        parts[start] = "agent".into();
        parts[start + 1] = parts[start + 1].to_ascii_lowercase();
        start += 2;
    }
    let channel = parts
        .get(start)
        .map(|part| part.to_ascii_lowercase())
        .unwrap_or_default();
    let peer = parts
        .get(start + 1)
        .map(|part| part.to_ascii_lowercase())
        .unwrap_or_default();
    let matrix = channel == "matrix" && matches!(peer.as_str(), "group" | "channel");
    let signal = channel == "signal" && peer == "group";
    let normalized = if channel == "catalog" {
        parts.join(":")
    } else if matrix || signal {
        parts[start] = channel;
        parts[start + 1] = peer;
        if matrix {
            if let Some(index) = (start + 2..parts.len().saturating_sub(1))
                .rev()
                .find(|index| parts[*index].eq_ignore_ascii_case("thread"))
            {
                parts[index] = "thread".into();
            }
        } else {
            if let Some(group) = parts.get_mut(start + 2) {
                *group = group.trim().to_owned();
            }
            for part in parts.iter_mut().skip(start + 3) {
                *part = part.to_ascii_lowercase();
            }
        }
        parts.join(":")
    } else {
        scoped.to_ascii_lowercase()
    };
    format!("{scope}\0{normalized}")
}

fn clean(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn connection_label(entry: &PresenceEntry) -> String {
    let family = clean(entry.device_family.as_deref());
    let platform = clean(entry.platform.as_deref()).unwrap_or("");
    let (platform, architecture) = match platform.to_ascii_lowercase().as_str() {
        "macintel" if family == Some("iPad") => ("iPadOS".to_owned(), None),
        "macintel" | "macos" | "darwin" => ("macOS".into(), None),
        "macarm" | "macarm64" | "arm64-apple-darwin" | "aarch64-apple-darwin" => {
            ("macOS".into(), Some("ARM"))
        }
        "x86_64-apple-darwin" => ("macOS".into(), Some("Intel")),
        "win32" | "win64" | "windows" => ("Windows".into(), None),
        "linux" => ("Linux".into(), None),
        "freebsd" => ("FreeBSD".into(), None),
        "ios" => ("iOS".into(), None),
        "ipados" => ("iPadOS".into(), None),
        "android" => ("Android".into(), None),
        _ => (platform.to_owned(), None),
    };
    let app = match (entry.client_id.as_deref(), entry.mode.as_deref()) {
        (Some("openclaw-tui"), _) => Some("Terminal"),
        (
            Some(
                "openclaw-control-ui"
                | "openclaw-webchat-ui"
                | "openclaw-webchat"
                | "openclaw-browser-copilot",
            ),
            _,
        )
        | (_, Some("webchat")) => Some("Web"),
        (Some("cli"), _) | (_, Some("cli")) => Some("Command line"),
        (_, Some("ui")) => Some("App"),
        _ => None,
    };
    let family_platform = match family {
        Some("Mac") => Some("macOS"),
        Some("iPad") => Some("iPadOS"),
        other => other,
    };
    [
        family,
        (!platform.is_empty() && family_platform != Some(platform.as_str()))
            .then_some(platform.as_str()),
        architecture,
        app,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn snapshots_replace_clients_merge_typed_identity_and_exclude_only_self_namespace() {
        let mut people = PeopleState {
            instance_id: Some("self".into()),
            ..Default::default()
        };
        people.apply_presence(&json!({"presence":[
            {"instanceId":"self","user":{"id":"same","identity":{"type":"profile","id":"same"},"name":"Self"}},
            {"user":{"id":"same","name":"Raw identity"}},
            {"user":{"id":"alice","identity":{"type":"profile","id":"alice"},"name":"Alice"},"watchedSessions":["two"],"lastInputSeconds":130},
            {"user":{"id":"alice","identity":{"type":"profile","id":"alice"},"name":"Renamed"},"watchedSessions":["one","two"],"lastInputSeconds":20},
            {"user":{"id":"bob","name":"Bob"},"lastInputSeconds":121},
            {"reason":"disconnect","user":{"id":"gone","name":"Gone"}}
        ]}));
        let online = people.online_people();
        assert_eq!(
            online.iter().map(|p| p.person.label()).collect::<Vec<_>>(),
            ["Alice", "Raw identity", "Bob"]
        );
        assert_eq!(online[0].watched_sessions, ["one", "two"]);
        assert!(!online[0].idle());
        assert!(online[2].idle());
        people.apply_presence(&json!({"presence":[]}));
        assert!(people.online_people().is_empty());
        assert_eq!(
            people
                .self_user
                .as_ref()
                .and_then(|person| person.name.as_deref()),
            Some("Self")
        );
        people.apply_self_profile(&json!({"profile":{"id":"same","displayName":"Updated profile","emails":["self@example.test"],"updatedAt":7}}));
        assert_eq!(
            people
                .self_user
                .as_ref()
                .and_then(|person| person.name.as_deref()),
            Some("Updated profile")
        );
        assert_eq!(
            people.self_user.unwrap().avatar_url.as_deref(),
            Some("/api/users/same/avatar?v=7")
        );
    }

    #[test]
    fn cards_intersect_watched_hints_with_loaded_sessions_and_qualify_recent_owners() {
        let mut people = PeopleState::default();
        people.apply_presence(&json!({"presence":[{"user":{"id":"alice","identity":{"type":"profile","id":"alice"}},"watchedSessions":["AGENT:main:visible","agent:private:secret-title","agent:main:matrix:group:!Room:example.test"],"onlineSince":10,"lastActivityAt":30},{"user":{"id":"alice","identity":{"type":"profile","id":"alice"}},"onlineSince":20,"lastActivityAt":40}]}));
        let person = &people.online_people()[0];
        let rows: Vec<SessionRow> = serde_json::from_value(json!([
            {"key":"agent:main:visible"},
            {"key":"agent:main:matrix:group:!Room:example.test"},
            {"key":"agent:main:matrix:group:!room:example.test","updatedAt":10},
            {"key":"agent:main:mine","owner":{"actor":{"id":"alice","identity":{"type":"profile","id":"alice"}}}},
            {"key":"agent:main:robot","createdActor":{"id":"alice","identity":{"type":"agent","id":"alice"}}}
        ])).unwrap();
        let (viewing, recent) = card_sessions(person, &rows, "main");
        assert_eq!(
            viewing
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            [
                "agent:main:matrix:group:!Room:example.test",
                "agent:main:visible"
            ]
        );
        assert_eq!(
            recent
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            ["agent:main:mine"]
        );
        assert_eq!(person.online_since(), Some(10));
        assert_eq!(person.last_activity_at(), Some(40));
    }
}
