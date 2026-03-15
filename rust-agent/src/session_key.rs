use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Main,
    Direct,
    Group,
    Channel,
    Cron,
    Hook,
    Node,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionDescriptor {
    pub key: String,
    pub kind: SessionKind,
    pub agent_id: Option<String>,
    pub channel: Option<String>,
    pub scope_id: Option<String>,
    pub topic_id: Option<String>,
}

pub fn parse_session_key(session_key: &str) -> SessionDescriptor {
    let trimmed = session_key.trim();
    if trimmed.eq_ignore_ascii_case("main") {
        return SessionDescriptor {
            key: trimmed.to_owned(),
            kind: SessionKind::Main,
            agent_id: None,
            channel: None,
            scope_id: None,
            topic_id: None,
        };
    }

    if let Some(rest) = trimmed.strip_prefix("cron:") {
        return SessionDescriptor {
            key: trimmed.to_owned(),
            kind: SessionKind::Cron,
            agent_id: None,
            channel: Some("internal".to_owned()),
            scope_id: Some(rest.to_owned()),
            topic_id: None,
        };
    }

    if let Some(rest) = trimmed.strip_prefix("hook:") {
        return SessionDescriptor {
            key: trimmed.to_owned(),
            kind: SessionKind::Hook,
            agent_id: None,
            channel: Some("internal".to_owned()),
            scope_id: Some(rest.to_owned()),
            topic_id: None,
        };
    }

    if let Some(rest) = trimmed.strip_prefix("node-") {
        return SessionDescriptor {
            key: trimmed.to_owned(),
            kind: SessionKind::Node,
            agent_id: None,
            channel: Some("internal".to_owned()),
            scope_id: Some(rest.to_owned()),
            topic_id: None,
        };
    }

    parse_agent_session_key(trimmed)
}

fn parse_agent_session_key(key: &str) -> SessionDescriptor {
    let mut parts = key.split(':');
    if !matches!(parts.next(), Some("agent")) {
        return SessionDescriptor {
            key: key.to_owned(),
            kind: SessionKind::Other,
            agent_id: None,
            channel: None,
            scope_id: None,
            topic_id: None,
        };
    }

    let agent_id = parts.next().map(ToOwned::to_owned);
    let mut channel = parts.next().map(ToOwned::to_owned);
    let rest: Vec<&str> = parts.collect();

    let (kind, scope_id, topic_id) = if rest.is_empty() {
        if channel
            .as_deref()
            .map(|value| value.eq_ignore_ascii_case("main"))
            .unwrap_or(false)
        {
            channel = None;
            (SessionKind::Main, Some("main".to_owned()), None)
        } else {
            (SessionKind::Other, None, None)
        }
    } else if rest.len() == 1 {
        if rest[0].eq_ignore_ascii_case("main") {
            (SessionKind::Main, Some(rest[0].to_owned()), None)
        } else {
            (SessionKind::Other, Some(rest[0].to_owned()), None)
        }
    } else if rest[0] == "dm" {
        (SessionKind::Direct, Some(rest[1..].join(":")), None)
    } else if rest[0] == "group" {
        parse_group_or_channel_scope(SessionKind::Group, &rest[1..])
    } else if rest[0] == "channel" {
        parse_group_or_channel_scope(SessionKind::Channel, &rest[1..])
    } else {
        (SessionKind::Other, Some(rest.join(":")), None)
    };

    SessionDescriptor {
        key: key.to_owned(),
        kind,
        agent_id,
        channel,
        scope_id,
        topic_id,
    }
}

fn parse_group_or_channel_scope(
    kind: SessionKind,
    rest: &[&str],
) -> (SessionKind, Option<String>, Option<String>) {
    if rest.is_empty() {
        return (kind, None, None);
    }
    let mut topic_id = None;
    if let Some(pos) = rest.windows(2).position(|w| w[0] == "topic") {
        let scope = rest[..pos].join(":");
        topic_id = rest.get(pos + 1).map(|v| (*v).to_owned());
        return (kind, Some(scope), topic_id);
    }
    (kind, Some(rest.join(":")), topic_id)
}

#[cfg(test)]
mod tests {
    use super::{parse_session_key, SessionKind};

    #[test]
    fn parses_main_session() {
        let parsed = parse_session_key("main");
        assert_eq!(parsed.kind, SessionKind::Main);
    }

    #[test]
    fn parses_agent_main_alias() {
        let parsed = parse_session_key("agent:main:main");
        assert_eq!(parsed.kind, SessionKind::Main);
        assert_eq!(parsed.agent_id.as_deref(), Some("main"));
        assert_eq!(parsed.channel, None);
        assert_eq!(parsed.scope_id.as_deref(), Some("main"));
    }

    #[test]
    fn parses_agent_group_with_topic() {
        let parsed = parse_session_key("agent:main:telegram:group:123:topic:44");
        assert_eq!(parsed.kind, SessionKind::Group);
        assert_eq!(parsed.agent_id.as_deref(), Some("main"));
        assert_eq!(parsed.channel.as_deref(), Some("telegram"));
        assert_eq!(parsed.scope_id.as_deref(), Some("123"));
        assert_eq!(parsed.topic_id.as_deref(), Some("44"));
    }

    #[test]
    fn parses_agent_channel() {
        let parsed = parse_session_key("agent:ops:discord:channel:help");
        assert_eq!(parsed.kind, SessionKind::Channel);
        assert_eq!(parsed.channel.as_deref(), Some("discord"));
        assert_eq!(parsed.scope_id.as_deref(), Some("help"));
    }

    #[test]
    fn parses_direct_scope() {
        let parsed = parse_session_key("agent:main:whatsapp:dm:+15551234567");
        assert_eq!(parsed.kind, SessionKind::Direct);
        assert_eq!(parsed.scope_id.as_deref(), Some("+15551234567"));
    }

    #[test]
    fn parses_internal_scopes() {
        assert_eq!(parse_session_key("cron:daily").kind, SessionKind::Cron);
        assert_eq!(parse_session_key("hook:abc").kind, SessionKind::Hook);
        assert_eq!(parse_session_key("node-123").kind, SessionKind::Node);
    }
}
