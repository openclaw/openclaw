//! Method dispatch.
//!
//! Scope authorization is applied before any handler runs, mirroring
//! `src/gateway/server-methods/method-authorization.ts`: unknown methods default
//! deny to `operator.admin`.

use crate::session_registry::SessionRegistry;
use openclaw_core::id::{AgentId, ChannelId, UserId};
use openclaw_core::session::SessionKind;
use openclaw_protocol::core_methods::{scope_for, Scope};
use openclaw_protocol::methods::{
    method, ConnectParams, HelloAuth, HelloFeatures, HelloOk, HelloPolicy, HelloServer,
    HelloSnapshot, MessageSendParams, SessionCreateParams, StateVersion,
};
use openclaw_protocol::{ErrorShape, OutgoingFrame, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Instant;

/// Scopes granted to a connection, decided once at connect time.
#[derive(Debug, Clone, Default)]
pub struct ConnectionScopes {
    pub granted: BTreeSet<String>,
}

impl ConnectionScopes {
    /// Full operator access (shared-token authentication).
    #[must_use]
    pub fn operator_full() -> Self {
        Self {
            granted: [
                "operator.read",
                "operator.write",
                "operator.admin",
                "operator.pairing",
                "operator.approvals",
                "operator.questions",
                "operator.talk",
                "operator.talk.secrets",
                "operator.sessions.read",
                "operator.sessions.write",
            ]
            .iter()
            .map(|scope| (*scope).to_owned())
            .collect(),
        }
    }

    /// True when the granted set satisfies the required scope.
    ///
    /// `operator.admin` implies every other operator scope, and
    /// `operator.write` implies the read scopes.
    #[must_use]
    pub fn permits(&self, required: Scope) -> bool {
        if self.granted.contains("operator.admin") {
            return true;
        }
        match required {
            Scope::Read => {
                self.granted.contains("operator.read")
                    || self.granted.contains("operator.write")
            }
            Scope::Write => self.granted.contains("operator.write"),
            Scope::Admin => false,
            Scope::Named(name) => self.granted.contains(name),
        }
    }
}

/// FNV-1a content hash for the config revision guard.
///
/// This is an opaque change-detection token, not a security primitive; clients only
/// compare it for equality to detect concurrent edits.
fn content_hash(raw: &str) -> String {
    let mut hash = 0xcbf2_9ce4_8422_2325_u64;
    for byte in raw.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Dispatches Gateway method calls to handlers.
pub struct Dispatcher {
    registry: Arc<SessionRegistry>,
    started_at: Instant,
    max_payload: u64,
    tick_interval_ms: u64,
    auth_method: String,
    auth_mode: String,
    /// Durable transcript owner, when the caller supplied one.
    state: Option<Arc<dyn TranscriptReader>>,
}

/// Minimal read contract for stored transcripts.
///
/// Kept as a trait so the Gateway does not depend on the concrete SQLite store
/// while still serving `sessions.get` from committed rows.
pub trait TranscriptReader: Send + Sync {
    fn recent_messages(&self, session_id: &str, limit: usize) -> Vec<Value>;
}
impl Dispatcher {
    #[must_use]
    pub fn new(registry: Arc<SessionRegistry>) -> Self {
        Self {
            registry,
            started_at: Instant::now(),
            max_payload: 25 * 1024 * 1024,
            tick_interval_ms: 15_000,
            auth_method: "token".to_owned(),
            auth_mode: "token".to_owned(),
            state: None,
        }
    }

    #[must_use]
    pub fn with_transcripts(mut self, state: Arc<dyn TranscriptReader>) -> Self {
        self.state = Some(state);
        self
    }

    #[must_use]
    pub fn with_auth(mut self, method: &str, mode: &str) -> Self {
        self.auth_method = method.to_owned();
        self.auth_mode = mode.to_owned();
        self
    }

    /// Dispatch a method call and produce a response frame.
    pub async fn dispatch(
        &self,
        id: &str,
        method_name: &str,
        params: Value,
        scopes: &ConnectionScopes,
    ) -> OutgoingFrame {
        // Authorization runs before the handler. `connect` is admitted by the
        // connection layer, which owns the handshake.
        if method_name != method::CONNECT {
            match scope_for(method_name) {
                Some(required) if scopes.permits(required) => {}
                Some(required) => {
                    return OutgoingFrame::err(
                        id,
                        ErrorShape {
                            code: "FORBIDDEN".to_owned(),
                            message: format!("missing required scope: {required:?}"),
                            details: Some(json!({ "code": "MISSING_SCOPE", "required": format!("{required:?}") })),
                            ..Default::default()
                        },
                    );
                }
                None => {
                    // Unknown methods default-deny, as upstream does.
                    return OutgoingFrame::err(
                        id,
                        ErrorShape {
                            code: "INVALID_REQUEST".to_owned(),
                            message: format!("unknown method: {method_name}"),
                            details: Some(json!({ "code": "METHOD_NOT_FOUND" })),
                            ..Default::default()
                        },
                    );
                }
            }
        }

        match method_name {
            method::CONNECT => self.handle_connect(id, params).await,
            method::PING => OutgoingFrame::ok(id, json!({"pong": true})),
            method::HEALTH => OutgoingFrame::ok(
                id,
                json!({
                    "ok": true,
                    "status": "ok",
                    "connections": self.registry.connection_count(),
                    "sessions": self.registry.list().len(),
                    "uptimeMs": self.started_at.elapsed().as_millis() as u64,
                }),
            ),
            method::SESSIONS_LIST => self.handle_sessions_list(id),
            method::SESSIONS_CREATE => self.handle_sessions_create(id, params),
            method::SESSIONS_GET => self.handle_sessions_get(id, params),
            "sessions.describe" => self.handle_sessions_describe(id, params),
            method::SESSIONS_END => self.handle_sessions_end(id, params),
            method::CHANNELS_LIST | "channels.status" => OutgoingFrame::ok(id, json!({"channels": []})),
            method::MESSAGE_SEND => self.handle_message_send(id, params),
            method::CONFIG_GET => self.handle_config_get(id),
            _ => OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "INVALID_REQUEST".to_owned(),
                    message: format!("unknown method: {method_name}"),
                    details: Some(json!({ "code": "METHOD_NOT_FOUND" })),
                    ..Default::default()
                },
            ),
        }
    }

    async fn handle_connect(&self, id: &str, params: Value) -> OutgoingFrame {
        let parsed: std::result::Result<ConnectParams, _> = serde_json::from_value(params);
        let connect = match parsed {
            Ok(connect) => connect,
            Err(error) => {
                return OutgoingFrame::err(
                    id,
                    ErrorShape {
                        code: "INVALID_REQUEST".to_owned(),
                        message: error.to_string(),
                        details: Some(json!({ "code": "INVALID_PARAMS" })),
                        ..Default::default()
                    },
                );
            }
        };

        // Protocol range check. Node clients may go one version lower.
        let (client_min, client_max) = connect.protocol_range();
        let floor = if connect.role() == "node" {
            openclaw_protocol::MIN_NODE_PROTOCOL_VERSION
        } else {
            openclaw_protocol::MIN_CLIENT_PROTOCOL_VERSION
        };
        let server = PROTOCOL_VERSION;
        if client_max < floor || client_min > server {
            return OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "PROTOCOL_MISMATCH".to_owned(),
                    message: format!(
                        "client protocol range {client_min}..{client_max} does not overlap server {server}"
                    ),
                    details: Some(json!({
                        "clientMinProtocol": client_min,
                        "clientMaxProtocol": client_max,
                        "expectedProtocol": server,
                        "minimumProtocol": floor,
                        "reloadRequired": true,
                    })),
                    ..Default::default()
                },
            );
        }

        let role = connect.role().to_owned();
        let scopes: Vec<String> = if connect.scopes.is_empty() {
            // A node with no requested scopes gets none, as documented.
            if role == "node" {
                Vec::new()
            } else {
                vec!["operator.read".to_owned()]
            }
        } else {
            connect.scopes.clone()
        };

        let hello = HelloOk {
            kind: "hello-ok".to_owned(),
            protocol: PROTOCOL_VERSION,
            server: HelloServer {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                conn_id: uuid::Uuid::new_v4().to_string(),
                boot_id: None,
            },
            features: HelloFeatures {
                methods: openclaw_protocol::core_methods::CORE_METHODS
                    .iter()
                    .map(|spec| spec.name.to_owned())
                    .collect(),
                events: vec![
                    "connect.challenge".to_owned(),
                    "tick".to_owned(),
                    "shutdown".to_owned(),
                    "presence".to_owned(),
                    "health".to_owned(),
                    "sessions.changed".to_owned(),
                ],
                capabilities: None,
            },
            snapshot: HelloSnapshot {
                presence: Vec::new(),
                health: json!({ "ok": true }),
                state_version: StateVersion {
                    presence: 0,
                    health: 0,
                },
                uptime_ms: self.started_at.elapsed().as_millis() as u64,
                config_path: openclaw_config::paths::config_path(
                    &openclaw_config::paths::process_env(),
                )
                .map(|path| path.display().to_string()),
                state_dir: openclaw_config::paths::state_dir(
                    &openclaw_config::paths::process_env(),
                )
                .map(|path| path.display().to_string()),
                auth_mode: Some(self.auth_mode.clone()),
            },
            auth: HelloAuth {
                method: Some(self.auth_method.clone()),
                role,
                scopes,
                device_token: None,
                role_allows_admin: Some(true),
            },
            policy: HelloPolicy {
                max_payload: self.max_payload,
                max_buffered_bytes: self.max_payload * 2,
                tick_interval_ms: self.tick_interval_ms,
            },
        };

        OutgoingFrame::ok(id, serde_json::to_value(hello).unwrap_or_default())
    }

    fn handle_sessions_list(&self, id: &str) -> OutgoingFrame {
        // Official rows carry `key` plus `updatedAt`; the Control UI reads `key`
        // and renders `undefined` without it.
        let sessions: Vec<Value> = self
            .registry
            .list()
            .into_iter()
            .map(|session| {
                json!({
                    "key": session.id.as_str(),
                    "sessionId": session.id.as_str(),
                    "kind": session.kind,
                    "state": session.state,
                    "channel": session.channel,
                    "agentId": session.agent,
                    "participants": session.participants,
                    "createdAt": session.created_at.timestamp_millis(),
                    "updatedAt": session.updated_at.timestamp_millis(),
                    "turnCount": session.turn_count,
                })
            })
            .collect();
        OutgoingFrame::ok(id, json!({ "sessions": sessions }))
    }

    fn handle_sessions_create(&self, id: &str, params: Value) -> OutgoingFrame {
        let parsed: std::result::Result<SessionCreateParams, _> = serde_json::from_value(params);
        match parsed {
            Ok(create) => {
                let kind = match create.kind.as_deref() {
                    Some("group") => SessionKind::Group,
                    Some("channel") => SessionKind::Channel,
                    Some("system") => SessionKind::System,
                    _ => SessionKind::Direct,
                };
                let session = self.registry.create(
                    kind,
                    ChannelId::from_raw(create.channel),
                    create.agent.map(AgentId::from_raw).unwrap_or_default(),
                    create.participants.into_iter().map(UserId::from_raw).collect(),
                );
                OutgoingFrame::ok(id, serde_json::to_value(&session).unwrap_or_default())
            }
            Err(error) => OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "INVALID_REQUEST".to_owned(),
                    message: error.to_string(),
                    details: Some(json!({ "code": "INVALID_PARAMS" })),
                    ..Default::default()
                },
            ),
        }
    }

    fn handle_sessions_get(&self, id: &str, params: Value) -> OutgoingFrame {
        // Documented: `sessions.get` returns `{ messages }` from the stored
        // transcript. Metadata belongs to `sessions.describe`.
        let session_id = params.get("id").and_then(Value::as_str).unwrap_or_default();
        match self.registry.get(&openclaw_core::id::SessionId::from_raw(session_id)) {
            Some(_) => {
                let messages = self
                    .state
                    .as_ref()
                    .map(|state| state.recent_messages(session_id, 200))
                    .unwrap_or_default();
                OutgoingFrame::ok(id, json!({ "messages": messages }))
            }
            None => OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "INVALID_REQUEST".to_owned(),
                    message: format!("session {session_id} not found"),
                    details: Some(json!({ "code": "NOT_FOUND" })),
                    ..Default::default()
                },
            ),
        }
    }

    fn handle_sessions_describe(&self, id: &str, params: Value) -> OutgoingFrame {
        let session_id = params.get("id").and_then(Value::as_str).unwrap_or_default();
        match self.registry.get(&openclaw_core::id::SessionId::from_raw(session_id)) {
            Some(session) => OutgoingFrame::ok(id, serde_json::to_value(&session).unwrap_or_default()),
            None => OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "INVALID_REQUEST".to_owned(),
                    message: format!("session {session_id} not found"),
                    details: Some(json!({ "code": "NOT_FOUND" })),
                    ..Default::default()
                },
            ),
        }
    }

    /// Live configuration snapshot plus the conflict-guard hashes.
    ///
    /// Documented: `config.get` returns the snapshot with `hash` (opaque authored
    /// revision for write conflict guards) and `configRevisionHash` (resolved
    /// runtime revision). Returning `{}` left every settings surface blank.
    fn handle_config_get(&self, id: &str) -> OutgoingFrame {
        let env = openclaw_config::paths::process_env();
        let config_path = openclaw_config::paths::config_path(&env);
        let (config, raw) = match &config_path {
            Some(path) => match std::fs::read_to_string(path) {
                Ok(raw) => {
                    let parsed = openclaw_config::load_json(path)
                        .unwrap_or_default();
                    (parsed, raw)
                }
                Err(_) => (openclaw_config::Config::default(), String::new()),
            },
            None => (openclaw_config::Config::default(), String::new()),
        };

        let hash = content_hash(&raw);
        let value = serde_json::to_value(&config).unwrap_or_default();
        OutgoingFrame::ok(
            id,
            json!({
                "config": value,
                "hash": hash,
                "configRevisionHash": hash,
                "path": config_path.map(|path| path.display().to_string()),
            }),
        )
    }

    fn handle_sessions_end(&self, id: &str, params: Value) -> OutgoingFrame {
        let session_id = params.get("id").and_then(Value::as_str).unwrap_or_default();
        match self.registry.end(&openclaw_core::id::SessionId::from_raw(session_id)) {
            Some(session) => OutgoingFrame::ok(id, serde_json::to_value(&session).unwrap_or_default()),
            None => OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "INVALID_REQUEST".to_owned(),
                    message: format!("session {session_id} not found"),
                    details: Some(json!({ "code": "NOT_FOUND" })),
                    ..Default::default()
                },
            ),
        }
    }

    fn handle_message_send(&self, id: &str, params: Value) -> OutgoingFrame {
        let parsed: std::result::Result<MessageSendParams, _> = serde_json::from_value(params);
        match parsed {
            Ok(_) => OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "UNAVAILABLE".to_owned(),
                    message: "message delivery is not wired to a channel transport yet; no message was sent".to_owned(),
                    ..Default::default()
                },
            ),
            Err(error) => OutgoingFrame::err(
                id,
                ErrorShape {
                    code: "INVALID_REQUEST".to_owned(),
                    message: error.to_string(),
                    details: Some(json!({ "code": "INVALID_PARAMS" })),
                    ..Default::default()
                },
            ),
        }
    }
}
