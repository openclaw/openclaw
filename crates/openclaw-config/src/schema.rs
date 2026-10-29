use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::{ConfigError, GatewayAuth};

/// Top-level OpenClaw configuration (`config.toml` or `~/.openclaw/openclaw.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub gateway: GatewayConfig,
    pub database: DatabaseConfig,
    pub logging: LoggingConfig,
    pub telemetry: TelemetryConfig,
    /// Named model providers keyed by provider id.
    pub providers: HashMap<String, ProviderConfig>,
    /// Named agents keyed by agent id.
    pub agents: HashMap<String, AgentConfig>,
    /// Named channel accounts keyed by "channel:account" or "telegram".
    pub channels: HashMap<String, ChannelAccountConfig>,
}

/// Gateway server configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GatewayConfig {
    /// WebSocket & Control UI listen address.
    pub listen: String,
    /// Whether to require authentication on WebSocket handshake.
    pub require_auth: bool,
    /// Optional shared auth token (`gateway.auth.token`).
    pub auth_token: Option<String>,
    /// Whether the Control UI is served by the Gateway.
    pub control_ui_enabled: bool,
    /// Maximum concurrent client connections.
    pub max_connections: usize,
    /// Maximum inbound frame size in bytes.
    pub max_frame_bytes: usize,
    /// Ping interval in seconds.
    pub ping_interval_secs: u64,
    /// Authentication mode: "token", "password", "none", or "trusted-proxy".
    pub auth_mode: String,
    /// Shared secret selected by password mode.
    pub auth_password: Option<String>,
    /// Ownership mode: "local" when this host owns the Gateway, "remote" otherwise.
    pub mode: String,
}

impl Default for GatewayConfig {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:18789".to_owned(),
            require_auth: false,
            auth_token: None,
            auth_mode: String::new(),
            auth_password: None,
            mode: String::new(),
            control_ui_enabled: true,
            max_connections: 256,
            max_frame_bytes: 16 * 1024 * 1024,
            ping_interval_secs: 30,
        }
    }
}

/// Database configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DatabaseConfig {
    /// Engine: "sqlite" or "postgres".
    pub engine: String,
    /// SQLite file path (when engine is sqlite).
    pub path: String,
    /// Postgres connection URL (when engine is postgres).
    pub url: Option<String>,
    /// Maximum connection pool size.
    pub max_connections: u32,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            engine: "sqlite".to_owned(),
            path: "openclaw.db".to_owned(),
            url: None,
            max_connections: 8,
        }
    }
}

/// Logging configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoggingConfig {
    /// Log level filter (e.g. "info", "debug").
    pub level: String,
    /// Whether to output structured JSON logs.
    pub json: bool,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: "info".to_owned(),
            json: false,
        }
    }
}

/// Telemetry configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TelemetryConfig {
    /// Whether anonymous feature statistics are enabled (opt-in).
    pub anonymous_stats: bool,
    /// Whether to phone home for version checks.
    pub check_on_start: bool,
}

/// A model provider configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ProviderConfig {
    /// Provider type: "anthropic", "openai", "ollama", etc.
    #[serde(rename = "type")]
    pub provider_type: String,
    /// API key (or env var name prefixed with `$`).
    pub api_key: Option<String>,
    /// Base URL override (supports OpenAI-compatible & custom endpoints).
    pub base_url: Option<String>,
    /// Default model id.
    pub model: Option<String>,
    /// Extra provider-specific options.
    pub options: HashMap<String, serde_json::Value>,
}

/// An agent configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentConfig {
    /// System prompt for this agent.
    pub system_prompt: String,
    /// Provider id to use.
    pub provider: String,
    /// Model id override.
    pub model: Option<String>,
    /// Maximum tokens per turn.
    pub max_tokens: Option<u32>,
    /// Sampling temperature.
    pub temperature: Option<f32>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            system_prompt: "You are OpenClaw, a helpful AI assistant running on the user's own hardware.".to_owned(),
            provider: String::new(),
            model: None,
            max_tokens: Some(4096),
            temperature: None,
        }
    }
}

/// A channel account configuration (matches `docs/channels/telegram.md`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChannelAccountConfig {
    /// Whether this account is enabled.
    pub enabled: bool,
    /// Bot token or credential (or env var name prefixed with `$`).
    pub token: Option<String>,
    /// Alias `botToken` from `openclaw.json`.
    pub bot_token: Option<String>,
    /// DM access policy: "pairing" (default), "allowlist", or "open".
    pub dm_policy: String,
    /// Allowed sender IDs or usernames (`allowFrom`).
    pub allow_from: Vec<String>,
    /// Group policy: "allowlist" or "open".
    pub group_policy: String,
    /// Require `@bot` mention in group chats.
    pub require_mention: bool,
    /// Custom Bot API root (e.g. local Bot API server).
    pub api_root: Option<String>,
    /// Extra channel-specific options.
    pub options: HashMap<String, serde_json::Value>,
}

impl Default for ChannelAccountConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            token: None,
            bot_token: None,
            dm_policy: "pairing".to_owned(),
            allow_from: Vec::new(),
            group_policy: "open".to_owned(),
            require_mention: true,
            api_root: None,
            options: HashMap::new(),
        }
    }
}

impl ChannelAccountConfig {
    /// Resolve either `token` or `botToken`.
    #[must_use]
    pub fn resolved_token(&self) -> Option<String> {
        Config::resolve_secret(&self.token).or_else(|| Config::resolve_secret(&self.bot_token))
    }
}

impl GatewayConfig {
    /// Resolve the credential the Gateway enforces for this connection class.
    ///
    /// Precedence follows upstream: an explicit config value wins, otherwise the
    /// documented environment variable supplies it.
    ///
    /// `trusted-proxy` is not implemented in this workspace: the identity-aware
    /// proxy contract is missing, so it fails closed instead of becoming open.
    pub fn resolved_auth(&self) -> Result<GatewayAuth, ConfigError> {
        match self.resolved_auth_mode() {
            "trusted-proxy" => Err(ConfigError::Invalid(
                "gateway.auth.mode 'trusted-proxy' is not implemented yet".to_owned(),
            )),
            "password" => match Config::resolve_secret(&self.auth_password)
                .or_else(|| Config::resolve_env("OPENCLAW_GATEWAY_PASSWORD"))
            {
                Some(password) => Ok(GatewayAuth::Token(password)),
                None => Err(ConfigError::Invalid(
                    "gateway.auth.mode 'password' requires gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD".to_owned(),
                )),
            },
            "none" if self.require_auth || self.auth_token.is_some() => {
                Err(ConfigError::Invalid(
                    "gateway authentication requires a non-empty authToken (or $ENV_VAR)"
                        .to_owned(),
                ))
            }
            "none" => Ok(GatewayAuth::None),
            _ => match Config::resolve_secret(&self.auth_token)
                .or_else(|| Config::resolve_env("OPENCLAW_GATEWAY_TOKEN"))
            {
                Some(token) => Ok(GatewayAuth::Token(token)),
                None => Err(ConfigError::Invalid(
                    "gateway.auth.mode 'token' requires gateway.auth.token or OPENCLAW_GATEWAY_TOKEN".to_owned(),
                )),
            },
        }
    }

    /// Authentication mode after upstream normalization.
    ///
    /// An explicit `mode` wins. Otherwise a configured secret selects its mode,
    /// and finally the documented environment variables do, so a service that
    /// only exports `OPENCLAW_GATEWAY_TOKEN` still authenticates instead of
    /// silently running open.
    #[must_use]
    pub fn resolved_auth_mode(&self) -> &str {
        match self.auth_mode.as_str() {
            "token" | "password" | "none" | "trusted-proxy" => &self.auth_mode,
            _ if self.auth_token.is_some() => "token",
            _ if self.auth_password.is_some() => "password",
            _ if Config::resolve_env("OPENCLAW_GATEWAY_TOKEN").is_some() => "token",
            _ if Config::resolve_env("OPENCLAW_GATEWAY_PASSWORD").is_some() => "password",
            _ => "none",
        }
    }

    /// True when the listener accepts connections from beyond this host.
    #[must_use]
    pub fn binds_beyond_loopback(&self) -> bool {
        let host = self
            .listen
            .rsplit_once(':')
            .map_or(self.listen.as_str(), |(host, _)| host);
        !matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
    }
}

impl Config {
    /// Resolve a non-empty environment variable.
    #[must_use]
    pub fn resolve_env(name: &str) -> Option<String> {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    }

    /// Resolve a secret value: `$ENV_VAR` reads from the environment.
    #[must_use]
    pub fn resolve_secret(value: &Option<String>) -> Option<String> {
        value.as_ref().and_then(|raw| {
            if let Some(var) = raw.strip_prefix('$') {
                Self::resolve_env(var)
            } else if raw.trim().is_empty() {
                None
            } else {
                Some(raw.clone())
            }
        })
    }

    /// Validate the configuration, returning a list of problems.
    #[must_use]
    pub fn validate(&self) -> Vec<String> {
        let mut problems = Vec::new();

        if !matches!(self.database.engine.as_str(), "sqlite" | "postgres") {
            problems.push(format!(
                "database.engine must be 'sqlite' or 'postgres', got '{}'",
                self.database.engine
            ));
        }

        if self.database.engine == "postgres" && self.database.url.is_none() {
            problems.push("database.url is required when engine is 'postgres'".to_owned());
        }

        for (id, agent) in &self.agents {
            if !agent.provider.is_empty() && !self.providers.contains_key(&agent.provider) {
                problems.push(format!(
                    "agent '{id}' references unknown provider '{}'",
                    agent.provider
                ));
            }
        }

        match self.gateway.resolved_auth_mode() {
            "token" => {
                if Config::resolve_secret(&self.gateway.auth_token)
                    .or_else(|| Config::resolve_env("OPENCLAW_GATEWAY_TOKEN"))
                    .is_none()
                {
                    problems.push(
                        "gateway.auth.mode 'token' requires gateway.auth.token or OPENCLAW_GATEWAY_TOKEN".to_owned(),
                    );
                }
            }
            "password" => {
                if Config::resolve_secret(&self.gateway.auth_password)
                    .or_else(|| Config::resolve_env("OPENCLAW_GATEWAY_PASSWORD"))
                    .is_none()
                {
                    problems.push(
                        "gateway.auth.mode 'password' requires gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD".to_owned(),
                    );
                }
                if self.gateway.auth_token.is_some() {
                    problems.push(
                        "gateway.auth.token is mutually exclusive with mode 'password'".to_owned(),
                    );
                }
            }
            "trusted-proxy" => {
                if self.gateway.auth_token.is_some() {
                    problems.push(
                        "gateway.auth.token is mutually exclusive with mode 'trusted-proxy'".to_owned(),
                    );
                }
                if !self.gateway.binds_beyond_loopback() {
                    problems.push(
                        "gateway.auth.mode 'trusted-proxy' requires a non-loopback gateway.listen"
                            .to_owned(),
                    );
                }
            }
            _ => {
                if self.gateway.binds_beyond_loopback() {
                    problems.push(format!(
                        "gateway.listen '{}' accepts remote clients but gateway.auth.mode is 'none'; set a token/password or bind loopback",
                        self.gateway.listen
                    ));
                }
            }
        }

        for (id, channel) in &self.channels {
            if !matches!(
                channel.dm_policy.as_str(),
                "pairing" | "allowlist" | "open" | "disabled"
            ) {
                problems.push(format!(
                    "channel '{id}' has invalid dmPolicy '{}'; expected pairing, allowlist, open, or disabled",
                    channel.dm_policy
                ));
            }
            // `open` is public only when the allowlist contains the wildcard.
            // Concrete entries keep restricting admission at runtime, so a config
            // that looks public but is not (or vice versa) is a footgun.
            if channel.dm_policy == "open" && !channel.allow_from.iter().any(|e| e == "*") {
                problems.push(format!(
                    "channel '{id}' sets dmPolicy 'open' without '*' in allowFrom; add \"*\" to make it public, or use 'allowlist'"
                ));
            }
            if channel.dm_policy == "allowlist" && channel.allow_from.is_empty() {
                problems.push(format!(
                    "channel '{id}' sets dmPolicy 'allowlist' with an empty allowFrom; nobody can reach the bot"
                ));
            }
        }

        problems
    }
}
