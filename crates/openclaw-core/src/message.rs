use crate::id::{ChannelId, MessageId, SessionId, UserId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Content payload of a message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MessageContent {
    /// Plain text body.
    Text { text: String },
    /// Text with markdown formatting.
    Markdown { text: String },
    /// Image attachment (URL or base64 data URL).
    Image { url: String, caption: Option<String> },
    /// File attachment.
    File {
        url: String,
        filename: String,
        mime_type: String,
    },
    /// Audio/voice message.
    Audio { url: String, duration_ms: u64 },
    /// Composite message with multiple parts.
    Composite { parts: Vec<MessageContent> },
}

/// An inbound message received from a channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboundMessage {
    pub id: MessageId,
    pub channel: ChannelId,
    pub session: SessionId,
    pub author: UserId,
    pub content: MessageContent,
    pub timestamp: DateTime<Utc>,
    /// Raw platform-specific payload for channel plugins that need it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw: Option<serde_json::Value>,
    /// Whether the message mentions the assistant.
    #[serde(default)]
    pub mentions_assistant: bool,
    /// Thread/reply context, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageId>,
}

/// An outbound message to be sent through a channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutboundMessage {
    pub channel: ChannelId,
    pub session: SessionId,
    pub content: MessageContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageId>,
}

/// A reply payload produced by an agent turn.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReplyPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<MessageContent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_to: Option<MessageId>,
}
