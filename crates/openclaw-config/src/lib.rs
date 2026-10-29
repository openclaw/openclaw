//! Configuration loading, validation, and defaults for OpenClaw.
//! Supports both `config.toml` and canonical `~/.openclaw/openclaw.json` files.

pub mod paths;
pub mod schema;

pub use schema::{
    AgentConfig, ChannelAccountConfig, Config, DatabaseConfig, GatewayConfig, LoggingConfig,
    ProviderConfig, TelemetryConfig,
};

use serde_json::Value;
use std::path::Path;
use subtle::ConstantTimeEq;

/// Resolved once at startup, shared by WebSocket and HTTP ingress.
#[derive(Clone)]
pub enum GatewayAuth {
    None,
    Token(String),
}

impl GatewayAuth {
    #[must_use]
    pub fn permits(&self, token: Option<&str>) -> bool {
        match self {
            Self::None => true,
            Self::Token(expected) => token.is_some_and(|token| {
                bool::from(expected.as_bytes().ct_eq(token.as_bytes()))
            }),
        }
    }
}

/// Load configuration from a TOML file.
pub fn load(path: impl AsRef<Path>) -> Result<Config, ConfigError> {
    let path = path.as_ref();
    let raw = std::fs::read_to_string(path)
        .map_err(|error| ConfigError::Read(path.display().to_string(), error.to_string()))?;
    parse(&raw)
}

/// Parse configuration from a TOML string.
pub fn parse(raw: &str) -> Result<Config, ConfigError> {
    toml::from_str(raw).map_err(|error| ConfigError::Parse(error.to_string()))
}

/// Load configuration from a JSON file (`~/.openclaw/openclaw.json`), normalizing
/// both the Rust schema and the upstream TypeScript `openclaw.json` layout.
pub fn load_json(path: impl AsRef<Path>) -> Result<Config, ConfigError> {
    let path = path.as_ref();
    let raw = std::fs::read_to_string(path)
        .map_err(|error| ConfigError::Read(path.display().to_string(), error.to_string()))?;
    let val: Value =
        serde_json::from_str(&raw).map_err(|error| ConfigError::Parse(error.to_string()))?;
    // The Rust schema is a permissive superset: a direct parse succeeds even when
    // upstream-only keys are present, so normalize whenever the upstream layout
    // is detected instead of silently discarding those keys.
    if needs_upstream_normalization(&val) {
        return Ok(normalize_upstream_json(&val));
    }
    serde_json::from_str::<Config>(&raw).map_err(|error| ConfigError::Parse(error.to_string()))
}

/// True when the document uses upstream `openclaw.json` shapes this schema
/// cannot represent directly (nested `gateway.auth`, `agents.defaults`,
/// `channels.<name>.accounts`, ...).
fn needs_upstream_normalization(root: &Value) -> bool {
    contains_key(root, "auth") || contains_key(root, "defaults") || contains_key(root, "accounts")
}

fn contains_key(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|object| {
        object.keys().any(|name| name == key)
            || object.values().any(|nested| contains_key(nested, key))
    })
}

fn normalize_upstream_json(root: &Value) -> Config {
    // Start from the direct parse so sibling sections survive, then overlay the
    // upstream-only shapes this schema cannot represent directly.
    let mut cfg = serde_json::from_value::<Config>(root.clone()).unwrap_or_default();

    if let Some(gw) = root.get("gateway") {
        if let Some(port) = gw.get("port").and_then(Value::as_u64) {
            cfg.gateway.listen = format!("127.0.0.1:{port}");
        }
        if let Some(listen) = gw.get("listen").and_then(Value::as_str) {
            cfg.gateway.listen = listen.to_owned();
        }
        if let Some(auth) = gw.get("auth") {
            if let Some(mode) = auth.get("mode").and_then(Value::as_str) {
                cfg.gateway.auth_mode = mode.to_owned();
            }
            if let Some(token) = auth.get("token").and_then(Value::as_str) {
                cfg.gateway.auth_token = Some(token.to_owned());
            }
            if let Some(password) = auth.get("password").and_then(Value::as_str) {
                cfg.gateway.auth_password = Some(password.to_owned());
            }
        }
        // A non-loopback bind is an explicit operator decision; it never
        // silently downgrades to unauthenticated access.
        if let Some(bind) = gw.get("bind").and_then(Value::as_str) {
            let host = cfg.gateway.listen.rsplit_once(':').map_or(
                cfg.gateway.listen.as_str(),
                |(host, _)| host,
            );
            if bind != "loopback" && matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]") {
                cfg.gateway.listen = cfg.gateway.listen.replacen(host, "0.0.0.0", 1);
            }
        }
    }

    if let Some(channels) = root.get("channels").and_then(Value::as_object) {
        for (ch_name, ch_val) in channels {
            if let Ok(parsed) = serde_json::from_value::<ChannelAccountConfig>(ch_val.clone()) {
                cfg.channels.insert(ch_name.clone(), parsed);
            } else if let Some(obj) = ch_val.as_object() {
                let mut acc = ChannelAccountConfig::default();
                acc.enabled = obj.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                acc.bot_token = obj
                    .get("botToken")
                    .or_else(|| obj.get("token"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if let Some(dm) = obj.get("dmPolicy").and_then(Value::as_str) {
                    acc.dm_policy = dm.to_owned();
                }
                if let Some(allow) = obj.get("allowFrom").and_then(Value::as_array) {
                    acc.allow_from = allow
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect();
                }
                cfg.channels.insert(ch_name.clone(), acc);
            }
        }
    }

    if let Some(providers) = root.get("providers").and_then(Value::as_object) {
        for (p_name, p_val) in providers {
            if let Ok(parsed) = serde_json::from_value::<ProviderConfig>(p_val.clone()) {
                cfg.providers.insert(p_name.clone(), parsed);
            }
        }
    }

    cfg
}

/// Configuration errors.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("failed to read config file {0}: {1}")]
    Read(String, String),

    #[error("failed to parse config: {0}")]
    Parse(String),

    #[error("invalid config: {0}")]
    Invalid(String),
}
