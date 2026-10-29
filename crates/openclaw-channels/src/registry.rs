//! Channel registry and the canonical list of channel integrations.
//!
//! Upstream ships 27 channel plugins under `extensions/`. This module records the
//! full set so nothing is silently missing, and marks which ones this crate
//! implements natively versus which need a plugin binary.

use openclaw_core::traits::Channel;
use std::collections::HashMap;
use std::sync::Arc;

/// How a channel is provided in this build.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelSupport {
    /// Implemented natively in `openclaw-channels`.
    Native,
    /// Implemented through the generic HTTP webhook channel.
    Webhook,
    /// Requires the upstream Node plugin; not implemented in Rust.
    PluginOnly,
}

/// One entry in the canonical channel catalog.
#[derive(Debug, Clone, Copy)]
pub struct ChannelSpec {
    /// Channel id used in `channels.<id>` config and session keys.
    pub id: &'static str,
    /// Human-readable name.
    pub label: &'static str,
    /// Support level in this build.
    pub support: ChannelSupport,
}

/// Every channel integration upstream ships, with this build's support level.
pub const CHANNEL_CATALOG: &[ChannelSpec] = &[
    ChannelSpec { id: "a2a", label: "Agent-to-Agent", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "clickclack", label: "ClickClack", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "discord", label: "Discord", support: ChannelSupport::Native },
    ChannelSpec { id: "feishu", label: "Feishu / Lark", support: ChannelSupport::Webhook },
    ChannelSpec { id: "googlechat", label: "Google Chat", support: ChannelSupport::Webhook },
    ChannelSpec { id: "imap", label: "Email (IMAP)", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "imessage", label: "iMessage", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "irc", label: "IRC", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "line", label: "LINE", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "matrix", label: "Matrix", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "mattermost", label: "Mattermost", support: ChannelSupport::Webhook },
    ChannelSpec { id: "msteams", label: "Microsoft Teams", support: ChannelSupport::Webhook },
    ChannelSpec { id: "nextcloud-talk", label: "Nextcloud Talk", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "nostr", label: "Nostr", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "reef", label: "Reef", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "signal", label: "Signal", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "slack", label: "Slack", support: ChannelSupport::Webhook },
    ChannelSpec { id: "sms", label: "SMS", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "synology-chat", label: "Synology Chat", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "telegram", label: "Telegram", support: ChannelSupport::Native },
    ChannelSpec { id: "tlon", label: "Tlon", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "twitch", label: "Twitch", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "voice-call", label: "Voice Call", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "webchat", label: "WebChat (Control UI)", support: ChannelSupport::Native },
    ChannelSpec { id: "whatsapp", label: "WhatsApp", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "zalo", label: "Zalo", support: ChannelSupport::PluginOnly },
    ChannelSpec { id: "zalouser", label: "Zalo Personal", support: ChannelSupport::PluginOnly },
];

/// Look up a channel's catalog entry.
#[must_use]
pub fn channel_spec(id: &str) -> Option<&'static ChannelSpec> {
    CHANNEL_CATALOG.iter().find(|spec| spec.id == id)
}

/// Registry of channel plugins available at runtime.
#[derive(Default)]
pub struct ChannelRegistry {
    channels: HashMap<String, Arc<dyn Channel>>,
}

impl std::fmt::Debug for ChannelRegistry {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChannelRegistry")
            .field("channels", &self.list())
            .finish()
    }
}

impl ChannelRegistry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a channel plugin.
    pub fn register(&mut self, channel: Arc<dyn Channel>) {
        self.channels.insert(channel.name().to_owned(), channel);
    }

    /// Look up a channel by name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Arc<dyn Channel>> {
        self.channels.get(name)
    }

    /// List registered channel names, sorted.
    #[must_use]
    pub fn list(&self) -> Vec<&str> {
        let mut names: Vec<&str> = self.channels.keys().map(String::as_str).collect();
        names.sort_unstable();
        names
    }

    /// Number of registered channels.
    #[must_use]
    pub fn len(&self) -> usize {
        self.channels.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.channels.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_lists_every_documented_channel() {
        assert_eq!(CHANNEL_CATALOG.len(), 27, "catalog must cover all 27 channels");
        for id in ["telegram", "discord", "slack", "whatsapp", "signal", "imessage", "matrix"] {
            assert!(channel_spec(id).is_some(), "missing {id}");
        }
    }

    #[test]
    fn native_and_webhook_channels_are_marked_implemented() {
        assert_eq!(channel_spec("telegram").unwrap().support, ChannelSupport::Native);
        assert_eq!(channel_spec("discord").unwrap().support, ChannelSupport::Native);
        assert_eq!(channel_spec("slack").unwrap().support, ChannelSupport::Webhook);
        assert_eq!(channel_spec("feishu").unwrap().support, ChannelSupport::Webhook);
    }

    #[test]
    fn catalog_ids_are_unique() {
        let mut ids: Vec<&str> = CHANNEL_CATALOG.iter().map(|s| s.id).collect();
        ids.sort_unstable();
        let before = ids.len();
        ids.dedup();
        assert_eq!(before, ids.len(), "duplicate channel id");
    }
}
