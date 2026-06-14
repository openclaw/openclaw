//! Pure session-filtering helpers, factored out of `window.rs` so they
//! can be exercised directly by unit tests without a GTK main loop.

use serde_json::Value;

/// A picked session entry, ready to put into the dropdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionChoice {
    pub key: String,
    pub label: String,
}

/// Build the dropdown (keys, labels) for an agent's session list.
///
/// - Server returns sessions pre-sorted by `updatedAt` desc.
/// - We drop system noise: `*:heartbeat` keys and `*:run:*` sub-runs.
/// - We always append a synthetic `agent:<id>:default` row at the end so
///   brand-new conversations have a landing zone.
/// - Label prefers `displayName` → `label` → stripped key prefix.
pub fn build_session_choices(
    agent_id: &str,
    sessions: &[Value],
) -> Vec<SessionChoice> {
    let mut out: Vec<SessionChoice> = Vec::new();
    let prefix = format!("agent:{agent_id}:");

    for sess in sessions {
        let Some(key) = sess.get("key").and_then(|k| k.as_str()) else {
            continue;
        };
        if is_system_noise(key) {
            continue;
        }
        let label = sess
            .get("displayName")
            .and_then(|v| v.as_str())
            .or_else(|| sess.get("label").and_then(|v| v.as_str()))
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                key.strip_prefix(&prefix)
                    .unwrap_or(key)
                    .to_string()
            });
        out.push(SessionChoice {
            key: key.to_string(),
            label,
        });
    }

    // Always include a synthetic default entry if not already present.
    let default_key = format!("{prefix}default");
    if !out.iter().any(|c| c.key == default_key) {
        out.push(SessionChoice {
            key: default_key,
            label: "default (new)".to_string(),
        });
    }

    out
}

/// Session keys that should never surface as user-pickable chats.
fn is_system_noise(key: &str) -> bool {
    key.ends_with(":heartbeat") || key.contains(":run:")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn s(key: &str) -> Value {
        json!({ "key": key })
    }

    #[test]
    fn is_system_noise_filters_heartbeat() {
        // We look for the `:heartbeat` suffix specifically, so a bare
        // `"heartbeat"` or `"heartbeat-ish"` is *not* treated as noise.
        assert!(is_system_noise("agent:alice:main:heartbeat"));
        assert!(is_system_noise("x:heartbeat"));
        assert!(!is_system_noise("heartbeat"));
        assert!(!is_system_noise("agent:alice:heartbeat-ish"));
    }

    #[test]
    fn is_system_noise_filters_cron_subruns() {
        assert!(is_system_noise("agent:alice:cron:abc:run:xyz"));
        assert!(is_system_noise("foo:run:bar"));
        assert!(!is_system_noise("agent:alice:cron:abc"));
    }

    #[test]
    fn build_session_choices_empty_list_adds_default() {
        let choices = build_session_choices("alice", &[]);
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].key, "agent:alice:default");
        assert_eq!(choices[0].label, "default (new)");
    }

    #[test]
    fn build_session_choices_filters_heartbeat_and_runs() {
        let sessions = vec![
            s("agent:alice:main:heartbeat"),
            s("agent:alice:cron:abc:run:xyz"),
            s("agent:alice:telegram:direct:123"),
        ];
        let choices = build_session_choices("alice", &sessions);
        assert_eq!(choices.len(), 2); // telegram + synthetic default
        assert_eq!(choices[0].key, "agent:alice:telegram:direct:123");
    }

    #[test]
    fn build_session_choices_uses_display_name() {
        let sessions = vec![json!({
            "key": "agent:alice:telegram:direct:123",
            "displayName": "Chat with Bob",
        })];
        let choices = build_session_choices("alice", &sessions);
        assert_eq!(choices[0].label, "Chat with Bob");
    }

    #[test]
    fn build_session_choices_falls_back_to_label() {
        let sessions = vec![json!({
            "key": "agent:alice:telegram:direct:123",
            "label": "team",
        })];
        let choices = build_session_choices("alice", &sessions);
        assert_eq!(choices[0].label, "team");
    }

    #[test]
    fn build_session_choices_falls_back_to_stripped_key() {
        let sessions = vec![json!({
            "key": "agent:alice:telegram:direct:123",
        })];
        let choices = build_session_choices("alice", &sessions);
        assert_eq!(choices[0].label, "telegram:direct:123");
    }

    #[test]
    fn build_session_choices_preserves_server_order() {
        let sessions = vec![
            s("agent:alice:telegram:A"),
            s("agent:alice:default"),
            s("agent:alice:whatsapp:B"),
        ];
        let choices = build_session_choices("alice", &sessions);
        assert_eq!(choices[0].key, "agent:alice:telegram:A");
        assert_eq!(choices[1].key, "agent:alice:default");
        assert_eq!(choices[2].key, "agent:alice:whatsapp:B");
    }

    #[test]
    fn build_session_choices_no_duplicate_default() {
        // If the server already returned the default session, don't append
        // a synthetic one on top.
        let sessions = vec![
            s("agent:alice:default"),
            s("agent:alice:telegram:A"),
        ];
        let choices = build_session_choices("alice", &sessions);
        assert_eq!(choices.len(), 2);
        let count_default = choices
            .iter()
            .filter(|c| c.key == "agent:alice:default")
            .count();
        assert_eq!(count_default, 1);
    }

    #[test]
    fn build_session_choices_skips_entry_without_key() {
        let sessions = vec![json!({"noKey": "whoops"}), s("agent:x:default")];
        let choices = build_session_choices("x", &sessions);
        assert_eq!(choices.len(), 1);
    }
}
