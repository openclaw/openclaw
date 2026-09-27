//! Literal session paths follow packages/session-url-contract/src/{index,parse}.ts.
use super::web_urls::control_base_url;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};

pub fn session_link(
    gateway: &str,
    key: &str,
    fallback_agent: Option<&str>,
    main_key: &str,
    preview: bool,
) -> Result<String, String> {
    let (agent, rest) = if let Some(tail) = key.strip_prefix("agent:") {
        tail.split_once(':').ok_or("Invalid session key")?
    } else {
        (fallback_agent.ok_or("Session agent is not available")?, key)
    };
    if key == "unknown" || agent.is_empty() || rest.split(':').any(str::is_empty) {
        return Err("This session does not have an addressable link.".into());
    }
    let namespace = if preview { "share/chat" } else { "chat" };
    let mut route = format!("{namespace}/{}", encode_segment(agent));
    if rest != main_key && !(key == "main" || key == "global") {
        // Explicit literal routing avoids short-ID/slug ambiguity for every session key.
        route.push_str("/~key/");
        route.push_str(
            &rest
                .split(':')
                .map(encode_segment)
                .collect::<Vec<_>>()
                .join("/"),
        );
    }
    control_base_url(gateway)?
        .join(&route)
        .map(String::from)
        .map_err(|error| error.to_string())
}

fn encode_segment(segment: &str) -> String {
    match segment {
        "." => "~dot".into(),
        ".." => "~dotdot".into(),
        _ if segment.starts_with('~') => {
            format!("~~{}", utf8_percent_encode(&segment[1..], NON_ALPHANUMERIC))
        }
        _ => utf8_percent_encode(segment, NON_ALPHANUMERIC).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_links_preserve_mount_literal_keys_and_reserved_segments_without_credentials() {
        assert_eq!(
            session_link(
                "wss://gateway.example/control",
                "agent:qa:work:.::bad",
                None,
                "main",
                false
            )
            .unwrap_err(),
            "This session does not have an addressable link."
        );
        assert_eq!(
            session_link(
                "wss://gateway.example/control",
                "agent:qa:main",
                None,
                "main",
                false
            )
            .unwrap(),
            "https://gateway.example/control/chat/qa"
        );
        assert_eq!(
            session_link(
                "wss://gateway.example/control",
                "agent:qa:deadbeef",
                None,
                "main",
                true
            )
            .unwrap(),
            "https://gateway.example/control/share/chat/qa/~key/deadbeef"
        );
        assert_eq!(
            session_link(
                "ws://127.0.0.1:19471/control",
                "agent:qa:room:..:file.js:~dot:a/b",
                None,
                "main",
                false
            )
            .unwrap(),
            "http://127.0.0.1:19471/control/chat/qa/~key/room/~dotdot/file%2Ejs/~~dot/a%2Fb"
        );
        assert!(
            session_link(
                "https://user:secret@gateway.example",
                "agent:qa:test",
                None,
                "main",
                false
            )
            .is_err()
        );
    }
}
