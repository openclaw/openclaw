use super::sessions::SessionRow;

/// The route names the channel; delivery metadata alone does not make Home a channel chat.
pub fn channel_label(row: &SessionRow) -> Option<String> {
    let parts: Vec<_> = row.key.split(':').collect();
    let peer_kind = |part: &str| matches!(part, "direct" | "dm" | "group" | "channel" | "thread");
    if !parts.windows(3).any(|parts| peer_kind(parts[1])) {
        return None;
    }
    let route_channel = (parts.len() >= 5
        && parts[0] == "agent"
        && !parts[1].is_empty()
        && !parts[2].is_empty()
        && (peer_kind(parts[3])
            || (parts.len() >= 6 && !parts[3].is_empty() && matches!(parts[4], "direct" | "dm"))))
    .then(|| parts[2]);
    let channel = route_channel
        .or(row.channel.as_deref())?
        .trim()
        .to_lowercase();
    if channel.is_empty() {
        return None;
    }
    Some(match channel.as_str() {
        "imessage" => "iMessage".into(),
        "whatsapp" => "WhatsApp".into(),
        "msteams" => "Microsoft Teams".into(),
        "bluebubbles" => "BlueBubbles".into(),
        "googlechat" => "Google Chat".into(),
        "irc" => "IRC".into(),
        "sms" => "SMS".into(),
        _ => {
            let mut chars = channel.chars();
            chars.next()?.to_uppercase().collect::<String>() + chars.as_str()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durable_peer_routes_name_channels_without_relabeling_home_or_exposing_peer_ids() {
        for (key, metadata, expected) in [
            ("agent:main:discord:group:123", None, Some("Discord")),
            (
                "agent:main:slack:channel:456",
                Some("discord"),
                Some("Slack"),
            ),
            (
                "agent:main:whatsapp:work:direct:789",
                None,
                Some("WhatsApp"),
            ),
            ("agent:main:imessage:dm:789", None, Some("iMessage")),
            ("agent:main:main", Some("discord"), None),
            ("agent:main:custom", Some("discord"), None),
            ("legacy:group:123", Some("googlechat"), Some("Google Chat")),
            ("agent:main:custom:group:123", None, Some("Custom")),
            ("group", None, None),
        ] {
            let row = SessionRow {
                key: key.into(),
                channel: metadata.map(str::to_owned),
                ..Default::default()
            };
            assert_eq!(channel_label(&row).as_deref(), expected, "{key}");
        }
    }
}
