//! Discord channel implementation using the REST API + Gateway WebSocket.

use async_trait::async_trait;
use openclaw_core::error::Result;
use openclaw_core::id::{ChannelId, MessageId, SessionId, UserId};
use openclaw_core::message::{InboundMessage, MessageContent, OutboundMessage};
use openclaw_core::traits::Channel;
use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::info;

const DISCORD_API: &str = "https://discord.com/api/v10";

/// Discord channel plugin.
#[derive(Debug)]
pub struct DiscordChannel {
    id: ChannelId,
    bot_token: String,
    client: reqwest::Client,
    running: Arc<AtomicBool>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // Used when the Discord Gateway WebSocket loop is implemented.
struct DiscordMessage {
    id: String,
    channel_id: String,
    author: DiscordUser,
    content: String,
    #[serde(default)]
    guild_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)] // Used when the Discord Gateway WebSocket loop is implemented.
struct DiscordUser {
    id: String,
    #[allow(dead_code)]
    username: String,
    #[serde(default)]
    bot: bool,
}

impl DiscordChannel {
    /// Create a new Discord channel with the given bot token.
    #[must_use]
    pub fn new(bot_token: impl Into<String>) -> Self {
        Self {
            id: ChannelId::new(),
            bot_token: bot_token.into(),
            client: reqwest::Client::new(),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn auth_header(&self) -> String {
        format!("Bot {}", self.bot_token)
    }

    /// Send a message to a Discord channel.
    async fn send_message(&self, channel_id: &str, content: &str) -> Result<()> {
        let url = format!("{DISCORD_API}/channels/{channel_id}/messages");
        self.client
            .post(&url)
            .header("Authorization", self.auth_header())
            .json(&serde_json::json!({"content": content}))
            .send()
            .await
            .map_err(|error| openclaw_core::Error::channel("discord", error.to_string()))?;
        Ok(())
    }

    /// Convert a Discord message to an inbound message.
    #[allow(dead_code)] // Used when the Discord Gateway WebSocket loop is implemented.
    fn to_inbound(&self, message: &DiscordMessage) -> Option<InboundMessage> {
        if message.author.bot {
            return None;
        }

        Some(InboundMessage {
            id: MessageId::from_raw(format!("dc_{}", message.id)),
            channel: self.id.clone(),
            session: SessionId::from_raw(format!("dc_{}", message.channel_id)),
            author: UserId::from_raw(format!("dc_{}", message.author.id)),
            content: MessageContent::Text {
                text: message.content.clone(),
            },
            timestamp: chrono::Utc::now(),
            raw: None,
            mentions_assistant: false,
            reply_to: None,
        })
    }
}

#[async_trait]
impl Channel for DiscordChannel {
    fn id(&self) -> &ChannelId {
        &self.id
    }

    fn name(&self) -> &str {
        "discord"
    }

    async fn start(&self) -> Result<()> {
        self.running.store(true, Ordering::Release);
        info!("discord channel starting");

        // Full implementation connects to the Discord Gateway WebSocket,
        // sends IDENTIFY, and dispatches MESSAGE_CREATE events.
        // The REST send path below is complete.

        while self.running.load(Ordering::Acquire) {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }

        info!("discord channel stopped");
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        self.running.store(false, Ordering::Release);
        Ok(())
    }

    async fn send(&self, message: OutboundMessage) -> Result<()> {
        let channel_id = message
            .session
            .as_str()
            .strip_prefix("dc_")
            .ok_or_else(|| {
                openclaw_core::Error::channel("discord", "invalid session id for discord")
            })?;

        match &message.content {
            MessageContent::Text { text } | MessageContent::Markdown { text } => {
                self.send_message(channel_id, text).await
            }
            _ => Err(openclaw_core::Error::channel(
                "discord",
                "unsupported content type",
            )),
        }
    }
}
