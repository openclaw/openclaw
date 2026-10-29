//! Connect / hello-ok types.
//!
//! Mirrors `packages/gateway-protocol/src/schema/frames.ts` (`ConnectParamsSchema`,
//! `HelloOkSchema`) and `schema/snapshot.ts` (`SnapshotSchema`). Fields are
//! `camelCase` on the wire and every block the official schema marks required is
//! present in [`HelloOk`].

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Gateway method names.
pub mod method {
    pub const CONNECT: &str = "connect";
    pub const PING: &str = "ping";
    pub const DISCONNECT: &str = "disconnect";
    pub const CHANNELS_LIST: &str = "channels.list";
    pub const CHANNELS_STATUS: &str = "channels.status";
    pub const SESSIONS_LIST: &str = "sessions.list";
    pub const SESSIONS_CREATE: &str = "sessions.create";
    pub const SESSIONS_GET: &str = "sessions.get";
    pub const SESSIONS_END: &str = "sessions.end";
    pub const AGENTS_LIST: &str = "agents.list";
    pub const MESSAGE_SEND: &str = "message.send";
    pub const CONFIG_GET: &str = "config.get";
    pub const CONFIG_SET: &str = "config.set";
    pub const HEALTH: &str = "health";
}

/// Gateway event names.
pub mod event {
    pub const CONNECT_CHALLENGE: &str = "connect.challenge";
    pub const TICK: &str = "tick";
    pub const SHUTDOWN: &str = "shutdown";
    pub const PRESENCE: &str = "presence";
    pub const HEALTH: &str = "health";
    pub const SESSIONS_CHANGED: &str = "sessions.changed";
    pub const MESSAGE_INBOUND: &str = "message.inbound";
    pub const MESSAGE_OUTBOUND: &str = "message.outbound";
    pub const SESSION_UPDATED: &str = "session.updated";
    pub const CHANNEL_STATUS: &str = "channel.status";
    pub const AGENT_TURN: &str = "agent.turn";
}

/// Initial client hello/connect payload.
///
/// `minProtocol`/`maxProtocol` are the current form; the deprecated scalar
/// `protocol` is still accepted for one release.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    #[serde(default)]
    pub min_protocol: Option<u32>,
    #[serde(default)]
    pub max_protocol: Option<u32>,
    /// Deprecated pre-v4 scalar form.
    #[serde(default)]
    pub protocol: Option<u32>,
    #[serde(default)]
    pub client: Option<ClientInfo>,
    #[serde(default)]
    pub caps: Vec<String>,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub permissions: std::collections::BTreeMap<String, bool>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default)]
    pub auth: Option<ConnectAuth>,
    #[serde(default)]
    pub device: Option<DeviceAuth>,
    #[serde(default)]
    pub locale: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

impl ConnectParams {
    /// Protocol range this client claims to speak.
    #[must_use]
    pub fn protocol_range(&self) -> (u32, u32) {
        match (self.min_protocol, self.max_protocol) {
            (Some(min), Some(max)) => (min, max),
            // Deprecated scalar form: a single version on both ends.
            (None, None) => self
                .protocol
                .map_or((0, 0), |version| (version, version)),
            (Some(min), None) => (min, min),
            (None, Some(max)) => (max, max),
        }
    }

    /// Role claimed by this connection; defaults to `operator`.
    #[must_use]
    pub fn role(&self) -> &str {
        self.role.as_deref().unwrap_or("operator")
    }
}

/// Client identification sent during connect.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub platform: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub instance_id: Option<String>,
}

/// Authentication payload accepted by `connect`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectAuth {
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub bootstrap_token: Option<String>,
    #[serde(default)]
    pub device_token: Option<String>,
}

impl ConnectAuth {
    /// Any credential the caller presented, in the documented precedence.
    #[must_use]
    pub fn presented(&self) -> Option<&str> {
        self.token
            .as_deref()
            .or(self.password.as_deref())
            .or(self.bootstrap_token.as_deref())
            .or(self.device_token.as_deref())
    }
}

/// Device identity for signed connects.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuth {
    pub id: String,
    pub public_key: String,
    pub signature: String,
    pub signed_at: u64,
    pub nonce: String,
}

/// Payload of the `connect.challenge` event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectChallenge {
    pub nonce: String,
    pub ts: u64,
}

/// `hello-ok` payload. Required blocks per `HelloOkSchema`: `server`, `features`,
/// `snapshot`, `auth`, `policy`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloOk {
    #[serde(rename = "type")]
    pub kind: String,
    pub protocol: u32,
    pub server: HelloServer,
    pub features: HelloFeatures,
    pub snapshot: HelloSnapshot,
    pub auth: HelloAuth,
    pub policy: HelloPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloServer {
    pub version: String,
    pub conn_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloFeatures {
    pub methods: Vec<String>,
    pub events: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloSnapshot {
    pub presence: Vec<Value>,
    pub health: Value,
    pub state_version: StateVersion,
    pub uptime_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StateVersion {
    pub presence: u64,
    pub health: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloAuth {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    pub role: String,
    pub scopes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_allows_admin: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloPolicy {
    pub max_payload: u64,
    pub max_buffered_bytes: u64,
    pub tick_interval_ms: u64,
}

/// Parameters for `message.send` (kept until the channel dispatch surface lands).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSendParams {
    pub channel: String,
    pub session: String,
    pub content: Value,
    #[serde(default)]
    pub reply_to: Option<String>,
}

/// Parameters for `sessions.create`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCreateParams {
    pub channel: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub participants: Vec<String>,
}
