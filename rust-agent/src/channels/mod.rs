use serde_json::Value;

use crate::types::ActionRequest;

pub trait ChannelDriver: Send + Sync {
    fn extract(&self, frame: &Value) -> Option<ActionRequest>;
}

pub struct DriverRegistry {
    drivers: Vec<Box<dyn ChannelDriver>>,
}

impl DriverRegistry {
    pub fn default_registry() -> Self {
        Self {
            drivers: vec![
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
}

struct GenericDriver;

impl ChannelDriver for GenericDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        ActionRequest::from_gateway_frame(frame)
    }
}

struct DiscordDriver;

impl ChannelDriver for DiscordDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        extract_with_hints(frame, "discord", &["discord"])
    }
}

struct TelegramDriver;

impl ChannelDriver for TelegramDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        extract_with_hints(frame, "telegram", &["telegram", "grammy"])
    }
}

struct SlackDriver;

impl ChannelDriver for SlackDriver {
    fn extract(&self, frame: &Value) -> Option<ActionRequest> {
        extract_with_hints(frame, "slack", &["slack"])
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
}
