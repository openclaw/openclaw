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
            drivers: vec![Box::new(DiscordDriver), Box::new(GenericDriver)],
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
        let mut request = ActionRequest::from_gateway_frame(frame)?;
        if request.channel.is_some() {
            if request
                .channel
                .as_deref()
                .is_some_and(|channel| normalize(channel) == "discord")
            {
                return Some(request);
            }
            return None;
        }

        let source = frame
            .get("event")
            .and_then(Value::as_str)
            .or_else(|| frame.get("method").and_then(Value::as_str))
            .map(normalize);

        if source.as_deref().is_some_and(|src| src.contains("discord")) {
            request.channel = Some("discord".to_owned());
            return Some(request);
        }

        None
    }
}

fn normalize(input: &str) -> String {
    input.trim().to_ascii_lowercase()
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
}
