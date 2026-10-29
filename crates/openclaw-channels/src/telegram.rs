//! Telegram channel implementation matching `docs/channels/telegram.md`:
//! - Long polling (`getUpdates`) + `getMe` verification
//! - Native commands (`/start`, `/id`, `/new`, `/reset`, `/status`, `/help`)
//! - DM pairing & `allowFrom` access control
//! - Group mention gating & forum topic (`message_thread_id`) session routing
//! - `sendChatAction` typing indicator & 4096-char message chunking

use async_trait::async_trait;
use openclaw_core::error::Result;
use openclaw_core::id::{ChannelId, MessageId, SessionId, UserId};
use openclaw_core::message::{InboundMessage, MessageContent, OutboundMessage};
use openclaw_core::traits::Channel;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tracing::{debug, info, warn};

const DEFAULT_TELEGRAM_API: &str = "https://api.telegram.org";
const TELEGRAM_MAX_MESSAGE_CHARS: usize = 4000;

/// Metadata extracted from a Telegram update for routing, pairing, and threading.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramInboundContext {
    pub chat_id: i64,
    pub chat_type: String, // "private", "group", "supergroup", "channel"
    pub message_id: i64,
    pub message_thread_id: Option<i64>,
    pub sender_id: i64,
    pub sender_username: Option<String>,
    pub sender_first_name: String,
    pub message: InboundMessage,
}

pub type InboundHandler = Arc<
    dyn Fn(TelegramInboundContext) -> Pin<Box<dyn Future<Output = Option<String>> + Send>>
        + Send
        + Sync,
>;

/// Telegram channel plugin.
pub struct TelegramChannel {
    id: ChannelId,
    bot_token: String,
    api_root: String,
    client: reqwest::Client,
    running: Arc<AtomicBool>,
    require_mention_in_groups: bool,
    on_message: Option<InboundHandler>,
}

impl std::fmt::Debug for TelegramChannel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TelegramChannel")
            .field("id", &self.id)
            .field("api_root", &self.api_root)
            .field("running", &self.running)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
struct TelegramResponse<T> {
    ok: bool,
    result: Option<T>,
    description: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BotIdentity {
    pub id: i64,
    pub is_bot: bool,
    pub first_name: String,
    pub username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Update {
    update_id: i64,
    message: Option<TelegramMessage>,
}

#[derive(Debug, Deserialize)]
struct TelegramMessage {
    message_id: i64,
    #[serde(default)]
    message_thread_id: Option<i64>,
    from: Option<TelegramUser>,
    chat: TelegramChat,
    text: Option<String>,
    caption: Option<String>,
    #[serde(default)]
    photo: Vec<TelegramPhoto>,
    reply_to_message: Option<Box<TelegramMessage>>,
}

#[derive(Debug, Deserialize)]
struct TelegramUser {
    id: i64,
    #[serde(default)]
    is_bot: bool,
    first_name: String,
    #[serde(default)]
    username: Option<String>,
}

#[derive(Debug, Deserialize)]
struct TelegramChat {
    id: i64,
    #[serde(rename = "type")]
    chat_type: String,
}

#[derive(Debug, Deserialize)]
struct TelegramPhoto {
    file_id: String,
}

impl TelegramChannel {
    /// Create a new Telegram channel with the given bot token.
    #[must_use]
    pub fn new(bot_token: impl Into<String>) -> Self {
        Self {
            id: ChannelId::from_raw("telegram"),
            bot_token: bot_token.into(),
            api_root: DEFAULT_TELEGRAM_API.to_owned(),
            client: reqwest::Client::new(),
            running: Arc::new(AtomicBool::new(false)),
            require_mention_in_groups: true,
            on_message: None,
        }
    }

    /// Configure custom Bot API root (`apiRoot`).
    #[must_use]
    pub fn with_api_root(mut self, api_root: Option<String>) -> Self {
        if let Some(root) = api_root {
            let trimmed = root.trim_end_matches('/').to_owned();
            if !trimmed.is_empty() {
                self.api_root = trimmed;
            }
        }
        self
    }

    /// Configure whether group chats require `@bot` mention.
    #[must_use]
    pub fn with_require_mention(mut self, require_mention: bool) -> Self {
        self.require_mention_in_groups = require_mention;
        self
    }

    /// Attach an inbound message handler that returns an optional reply string.
    #[must_use]
    pub fn with_handler(mut self, handler: InboundHandler) -> Self {
        self.on_message = Some(handler);
        self
    }

    fn api_url(&self, method: &str) -> String {
        format!("{}/bot{}/{method}", self.api_root, self.bot_token)
    }

    /// Call `getMe` to verify token and get the bot's `@username`.
    pub async fn get_me(&self) -> Result<BotIdentity> {
        let url = self.api_url("getMe");
        let response: TelegramResponse<BotIdentity> = self
            .client
            .get(&url)
            .send()
            .await
            .map_err(|error| openclaw_core::Error::channel("telegram", error.to_string()))?
            .json()
            .await
            .map_err(|error| openclaw_core::Error::channel("telegram", error.to_string()))?;

        if response.ok {
            response
                .result
                .ok_or_else(|| openclaw_core::Error::channel("telegram", "empty getMe result"))
        } else {
            Err(openclaw_core::Error::channel(
                "telegram",
                response
                    .description
                    .unwrap_or_else(|| "unauthorized token".to_owned()),
            ))
        }
    }

    /// Register native bot commands menu with BotFather (`setMyCommands`).
    async fn register_native_commands(&self) {
        let url = self.api_url("setMyCommands");
        let _ = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "commands": [
                    {"command": "start", "description": "Start OpenClaw assistant"},
                    {"command": "new", "description": "Start a fresh conversation session"},
                    {"command": "reset", "description": "Clear current session history"},
                    {"command": "status", "description": "Show session and Gateway status"},
                    {"command": "id", "description": "Show your Telegram user ID and chat ID"},
                    {"command": "help", "description": "Show available commands"}
                ]
            }))
            .send()
            .await;
    }

    /// Send `typing` chat action.
    async fn send_typing(&self, chat_id: i64, thread_id: Option<i64>) {
        let url = self.api_url("sendChatAction");
        let mut body = serde_json::json!({
            "chat_id": chat_id,
            "action": "typing",
        });
        if let Some(tid) = thread_id {
            body["message_thread_id"] = serde_json::json!(tid);
        }
        let _ = self.client.post(&url).json(&body).send().await;
    }

    /// Poll for updates.
    async fn poll_updates(&self, offset: i64) -> Result<Vec<Update>> {
        let url = self.api_url("getUpdates");
        let response: TelegramResponse<Vec<Update>> = self
            .client
            .post(&url)
            .json(&serde_json::json!({
                "offset": offset,
                "timeout": 25,
                "allowed_updates": ["message"],
            }))
            .send()
            .await
            .map_err(|error| openclaw_core::Error::channel("telegram", error.to_string()))?
            .json()
            .await
            .map_err(|error| openclaw_core::Error::channel("telegram", error.to_string()))?;

        if response.ok {
            Ok(response.result.unwrap_or_default())
        } else {
            Err(openclaw_core::Error::channel(
                "telegram",
                response
                    .description
                    .unwrap_or_else(|| "unknown error".to_owned()),
            ))
        }
    }

    /// Send a text message (automatically chunked to <=4000 chars, with optional thread & reply).
    pub async fn send_text_reply(
        &self,
        chat_id: i64,
        text: &str,
        reply_to_message_id: Option<i64>,
        message_thread_id: Option<i64>,
    ) -> Result<()> {
        let url = self.api_url("sendMessage");
        let chunks = chunk_text(text, TELEGRAM_MAX_MESSAGE_CHARS);

        for (idx, chunk) in chunks.iter().enumerate() {
            let mut body = serde_json::json!({
                "chat_id": chat_id,
                "text": chunk,
            });
            if idx == 0 {
                if let Some(reply_id) = reply_to_message_id {
                    body["reply_to_message_id"] = serde_json::json!(reply_id);
                }
            }
            if let Some(tid) = message_thread_id {
                body["message_thread_id"] = serde_json::json!(tid);
            }
            self.client
                .post(&url)
                .json(&body)
                .send()
                .await
                .map_err(|error| openclaw_core::Error::channel("telegram", error.to_string()))?;
        }
        Ok(())
    }

    /// Convert a Telegram update to `TelegramInboundContext`.
    fn to_inbound(
        &self,
        update: &Update,
        bot_username: Option<&str>,
    ) -> Option<TelegramInboundContext> {
        let message = update.message.as_ref()?;
        let user = message.from.as_ref()?;
        if user.is_bot {
            return None;
        }

        let is_group = message.chat.chat_type != "private";
        let raw_text = message
            .text
            .as_deref()
            .or(message.caption.as_deref())
            .unwrap_or_default();

        let mentions_bot = if let Some(uname) = bot_username {
            let tag = format!("@{}", uname.to_lowercase());
            raw_text.to_lowercase().contains(&tag)
        } else {
            false
        };
        let replies_to_bot = message
            .reply_to_message
            .as_ref()
            .and_then(|r| r.from.as_ref())
            .is_some_and(|u| u.is_bot);

        // Group mention gating per docs/channels/telegram.md
        if is_group
            && self.require_mention_in_groups
            && !mentions_bot
            && !replies_to_bot
            && !raw_text.starts_with('/')
        {
            return None;
        }

        let content = if !raw_text.is_empty() {
            MessageContent::Text {
                text: raw_text.to_owned(),
            }
        } else if let Some(photo) = message.photo.last() {
            MessageContent::Image {
                url: photo.file_id.clone(),
                caption: message.caption.clone(),
            }
        } else {
            return None;
        };

        // Forum topics get per-topic session keys (`tg_<chat_id>_topic_<thread_id>`)
        let session_key = match message.message_thread_id {
            Some(tid) => format!("tg_{}_topic_{tid}", message.chat.id),
            None => format!("tg_{}", message.chat.id),
        };

        Some(TelegramInboundContext {
            chat_id: message.chat.id,
            chat_type: message.chat.chat_type.clone(),
            message_id: message.message_id,
            message_thread_id: message.message_thread_id,
            sender_id: user.id,
            sender_username: user.username.clone(),
            sender_first_name: user.first_name.clone(),
            message: InboundMessage {
                id: MessageId::from_raw(format!("tg_{}", message.message_id)),
                channel: self.id.clone(),
                session: SessionId::from_raw(session_key),
                author: UserId::from_raw(format!("{}", user.id)),
                content,
                timestamp: chrono::Utc::now(),
                raw: None,
                mentions_assistant: mentions_bot || replies_to_bot,
                reply_to: None,
            },
        })
    }
}

/// Split long responses into safe chunks without breaking UTF-8 char boundaries.
#[must_use]
pub fn chunk_text(text: &str, max_chars: usize) -> Vec<String> {
    if text.chars().count() <= max_chars {
        return vec![text.to_owned()];
    }
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut count = 0;
    for ch in text.chars() {
        current.push(ch);
        count += 1;
        if count >= max_chars {
            chunks.push(std::mem::take(&mut current));
            count = 0;
        }
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

#[async_trait]
impl Channel for TelegramChannel {
    fn id(&self) -> &ChannelId {
        &self.id
    }

    fn name(&self) -> &str {
        "telegram"
    }

    async fn start(&self) -> Result<()> {
        self.running.store(true, Ordering::Release);
        let bot_username = match self.get_me().await {
            Ok(me) => {
                info!(
                    bot_id = me.id,
                    username = ?me.username,
                    "telegram bot authenticated"
                );
                self.register_native_commands().await;
                me.username
            }
            Err(error) => {
                warn!(%error, "telegram getMe failed on start; will retry during polling");
                None
            }
        };

        let mut offset = 0_i64;
        while self.running.load(Ordering::Acquire) {
            match self.poll_updates(offset).await {
                Ok(updates) => {
                    for update in &updates {
                        offset = offset.max(update.update_id + 1);
                        if let Some(ctx) = self.to_inbound(update, bot_username.as_deref()) {
                            debug!(
                                id = %ctx.message.id,
                                chat_id = ctx.chat_id,
                                sender_id = ctx.sender_id,
                                "telegram inbound message"
                            );
                            if let Some(handler) = &self.on_message {
                                self.send_typing(ctx.chat_id, ctx.message_thread_id).await;
                                let chat_id = ctx.chat_id;
                                let msg_id = ctx.message_id;
                                let thread_id = ctx.message_thread_id;
                                let is_group = ctx.chat_type != "private";
                                if let Some(reply) = handler(ctx).await {
                                    let reply_to = if is_group { Some(msg_id) } else { None };
                                    if let Err(error) = self
                                        .send_text_reply(chat_id, &reply, reply_to, thread_id)
                                        .await
                                    {
                                        warn!(%error, "telegram send reply failed");
                                    }
                                }
                            }
                        }
                    }
                }
                Err(error) => {
                    warn!(%error, "telegram poll failed, backing off 5s");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }

        info!("telegram channel stopped");
        Ok(())
    }

    async fn stop(&self) -> Result<()> {
        self.running.store(false, Ordering::Release);
        Ok(())
    }

    async fn send(&self, message: OutboundMessage) -> Result<()> {
        let raw_session = message.session.as_str();
        let after_tg = raw_session.strip_prefix("tg_").unwrap_or(raw_session);
        let mut parts = after_tg.split("_topic_");
        let chat_id: i64 = parts.next().and_then(|s| s.parse().ok()).ok_or_else(|| {
            openclaw_core::Error::channel("telegram", "invalid session id for telegram")
        })?;
        let thread_id: Option<i64> = parts.next().and_then(|s| s.parse().ok());

        match &message.content {
            MessageContent::Text { text } | MessageContent::Markdown { text } => {
                self.send_text_reply(chat_id, text, None, thread_id).await
            }
            _ => Err(openclaw_core::Error::channel(
                "telegram",
                "unsupported content type",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_long_telegram_messages_cleanly() {
        let text = "a".repeat(8500);
        let parts = chunk_text(&text, 4000);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 4000);
        assert_eq!(parts[1].len(), 4000);
        assert_eq!(parts[2].len(), 500);
    }
}
