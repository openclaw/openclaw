use serde_json::Value;

use crate::types::ActionRequest;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChannelCapabilities {
    pub name: &'static str,
    pub supports_edit: bool,
    pub supports_delete: bool,
    pub supports_reactions: bool,
    pub supports_threads: bool,
    pub supports_polls: bool,
    pub supports_media: bool,
    pub default_dm_pairing: bool,
}

pub trait ChannelDriver: Send + Sync {
    fn extract(&self, frame: &Value) -> Option<ActionRequest>;
    fn capabilities(&self) -> ChannelCapabilities;
}

pub struct DriverRegistry {
    drivers: Vec<Box<dyn ChannelDriver>>,
}

impl DriverRegistry {
    pub fn default_registry() -> Self {
        Self {
            drivers: vec![
                Box::new(WhatsAppDriver),
                Box::new(TelegramDriver),
                Box::new(SlackDriver),
                Box::new(DiscordDriver),
                Box::new(GenericDriver),
            ],
        }
    }

    pub fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        for driver in &self.drivers {
            if let Some(request) = driver.extract(frame) {
                return Some(request);
            }
        }
        None
    }

    pub fn capabilities(&self) -> Vec<ChannelCapabilities> {
        self.drivers.iter().map(|d| d.capabilities()).collect()
    }
}

struct GenericDriver;

impl ChannelDriver for GenericDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        ActionRequest::from_gateway_frame(frame)
    }

    fn capabilities(&self) -> ChannelCapabilities {
        ChannelCapabilities {
            name: "generic",
            supports_edit: false,
            supports_delete: false,
            supports_reactions: false,
            supports_threads: false,
            supports_polls: false,
            supports_media: true,
            default_dm_pairing: true,
        }
    }
}

struct DiscordDriver;

impl ChannelDriver for DiscordDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        extract_with_hints(frame, "discord", &["discord"])
    }

    fn capabilities(&self) -> ChannelCapabilities {
        ChannelCapabilities {
            name: "discord",
            supports_edit: true,
            supports_delete: true,
            supports_reactions: true,
            supports_threads: true,
            supports_polls: true,
            supports_media: true,
            default_dm_pairing: true,
        }
    }
}

struct TelegramDriver;

impl ChannelDriver for TelegramDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        extract_with_hints(frame, "telegram", &["telegram", "grammy"])
    }

    fn capabilities(&self) -> ChannelCapabilities {
        ChannelCapabilities {
            name: "telegram",
            supports_edit: true,
            supports_delete: true,
            supports_reactions: true,
            supports_threads: false,
            supports_polls: true,
            supports_media: true,
            default_dm_pairing: true,
        }
    }
}

struct SlackDriver;

impl ChannelDriver for SlackDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        extract_with_hints(frame, "slack", &["slack"])
    }

    fn capabilities(&self) -> ChannelCapabilities {
        ChannelCapabilities {
            name: "slack",
            supports_edit: true,
            supports_delete: true,
            supports_reactions: true,
            supports_threads: true,
            supports_polls: false,
            supports_media: true,
            default_dm_pairing: true,
        }
    }
}

struct WhatsAppDriver;

impl ChannelDriver for WhatsAppDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        extract_with_hints(frame, "whatsapp", &["whatsapp", "baileys"])
    }

    fn capabilities(&self) -> ChannelCapabilities {
        ChannelCapabilities {
            name: "whatsapp",
            supports_edit: false,
            supports_delete: false,
            supports_reactions: true,
            supports_threads: false,
            supports_polls: true,
            supports_media: true,
            default_dm_pairing: true,
        }
    }
}

fn normalize(input: &str) -> String {
    input.trim().to_ascii_lowercase()
}

fn extract_with_hints(
    frame: &Value,
    canonical_channel: &str,
    hints: &[&str],
) -> Option<ActionRequest> {
    let mut request = ActionRequest::from_gateway_frame(frame)?;
    if let Some(channel) = request.channel.as_deref() {
        if normalize(channel) == canonical_channel {
            return Some(request);
        }
        return None;
    }

    let source = frame
        .get("event")
        .and_then(Value::as_str)
        .or_else(|| frame.get("method").and_then(Value::as_str))
        .map(normalize);

    let matched = source
        .as_deref()
        .is_some_and(|src| hints.iter().any(|hint| src.contains(hint)));

    if matched {
        request.channel = Some(canonical_channel.to_owned());
        return Some(request);
    }

    None
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::DriverRegistry;

    #[test]
    fn discord_driver_sets_channel_from_event_name() {
        let registry = DriverRegistry::default_registry();
        let frame = json!({
            "type": "event",
            "event": "discord.message",
            "payload": {
                "id": "req-1",
                "command": "git status",
                "tool": "exec"
            }
        });
        let request = registry.extract(&frame).expect("request");
        assert_eq!(request.channel.as_deref(), Some("discord"));
    }

    #[test]
    fn generic_driver_fallback_still_extracts() {
        let registry = DriverRegistry::default_registry();
        let frame = json!({
            "type": "event",
            "event": "agent",
            "payload": {
                "id": "req-2",
                "tool": "exec",
                "command": "git status"
            }
        });
        let request = registry.extract(&frame).expect("request");
        assert_eq!(request.id, "req-2");
    }

    #[test]
    fn telegram_driver_detects_source() {
        let registry = DriverRegistry::default_registry();
        let frame = json!({
            "type": "event",
            "event": "telegram.message",
            "payload": {
                "id": "req-3",
                "tool": "exec",
                "command": "git status"
            }
        });
        let request = registry.extract(&frame).expect("request");
        assert_eq!(request.channel.as_deref(), Some("telegram"));
    }

    #[test]
    fn slack_driver_detects_source() {
        let registry = DriverRegistry::default_registry();
        let frame = json!({
            "type": "event",
            "event": "slack.message",
            "payload": {
                "id": "req-4",
                "tool": "exec",
                "command": "git status"
            }
        });
        let request = registry.extract(&frame).expect("request");
        assert_eq!(request.channel.as_deref(), Some("slack"));
    }

    #[test]
    fn whatsapp_driver_detects_source() {
        let registry = DriverRegistry::default_registry();
        let frame = json!({
            "type": "event",
            "event": "whatsapp.message",
            "payload": {
                "id": "req-5",
                "tool": "exec",
                "command": "git status"
            }
        });
        let request = registry.extract(&frame).expect("request");
        assert_eq!(request.channel.as_deref(), Some("whatsapp"));
    }

    #[test]
    fn exposes_channel_capabilities() {
        let registry = DriverRegistry::default_registry();
        let caps = registry.capabilities();
        assert!(caps
            .iter()
            .any(|c| c.name == "discord" && c.supports_threads));
        assert!(caps
            .iter()
            .any(|c| c.name == "telegram" && c.supports_polls));
        assert!(caps.iter().any(|c| c.name == "slack" && c.supports_threads));
        assert!(caps
            .iter()
            .any(|c| c.name == "whatsapp" && c.supports_media));
    }
}
