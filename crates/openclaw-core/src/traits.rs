use crate::error::Result;
use crate::id::{ChannelId, SessionId};
use crate::message::{InboundMessage, OutboundMessage, ReplyPayload};
use async_trait::async_trait;
use std::fmt::Debug;

/// A messaging channel plugin (Telegram, Discord, Slack, etc.).
#[async_trait]
pub trait Channel: Send + Sync + Debug {
    /// Unique channel identifier.
    fn id(&self) -> &ChannelId;

    /// Human-readable channel name.
    fn name(&self) -> &str;

    /// Start the channel's connection loop. Returns when the channel stops.
    async fn start(&self) -> Result<()>;

    /// Gracefully stop the channel.
    async fn stop(&self) -> Result<()>;

    /// Send an outbound message through this channel.
    async fn send(&self, message: OutboundMessage) -> Result<()>;
}

/// An AI model provider (Claude, OpenAI, local models, etc.).
#[async_trait]
pub trait ModelProvider: Send + Sync + Debug {
    /// Provider identifier (e.g. "anthropic", "openai").
    fn id(&self) -> &str;

    /// Whether this provider is currently healthy.
    async fn health_check(&self) -> Result<()>;

    /// Run a completion and return the full reply.
    async fn complete(&self, request: CompletionRequest) -> Result<ReplyPayload>;

    /// Run a streaming completion, invoking `on_chunk` for each delta.
    async fn complete_stream(
        &self,
        request: CompletionRequest,
        on_chunk: Box<dyn Fn(String) + Send + Sync>,
    ) -> Result<ReplyPayload>;
}

/// A request to a model provider.
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub session: SessionId,
    pub system_prompt: String,
    pub messages: Vec<CompletionMessage>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

/// A single message in a completion request.
#[derive(Debug, Clone)]
pub struct CompletionMessage {
    pub role: CompletionRole,
    pub content: String,
}

/// Role of a message in a completion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionRole {
    System,
    User,
    Assistant,
}

/// Persistent state store for sessions, messages, and configuration.
#[async_trait]
pub trait StateStore: Send + Sync + Debug {
    /// Persist an inbound message.
    async fn save_inbound(&self, message: &InboundMessage) -> Result<()>;

    /// Load recent messages for a session.
    async fn load_history(&self, session: &SessionId, limit: usize) -> Result<Vec<InboundMessage>>;

    /// Persist a reply payload.
    async fn save_reply(&self, session: &SessionId, reply: &ReplyPayload) -> Result<()>;
}
