use crate::id::{AgentId, ChannelId, SessionId, UserId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// The kind of conversation a session represents.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionKind {
    /// Direct message with a single user.
    Direct,
    /// Group conversation.
    Group,
    /// Channel-wide broadcast.
    Channel,
    /// Internal system session.
    System,
}

/// Lifecycle state of a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionState {
    /// Session is active and processing.
    Active,
    /// Session is idle, waiting for input.
    Idle,
    /// Session is paused by policy.
    Paused,
    /// Session has ended.
    Ended,
}

/// A conversation session binding a channel, users, and an agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: SessionId,
    pub kind: SessionKind,
    pub state: SessionState,
    pub channel: ChannelId,
    pub agent: AgentId,
    pub participants: Vec<UserId>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Number of turns exchanged in this session.
    #[serde(default)]
    pub turn_count: u64,
}
