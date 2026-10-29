use std::fmt;

/// Top-level error type for the OpenClaw Rust rewrite.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("gateway error: {0}")]
    Gateway(String),

    #[error("channel error: {channel}: {message}")]
    Channel { channel: String, message: String },

    #[error("provider error: {provider}: {message}")]
    Provider { provider: String, message: String },

    #[error("state error: {0}")]
    State(String),

    #[error("transport error: {0}")]
    Transport(String),

    #[error("protocol error: {0}")]
    Protocol(String),

    #[error("authentication error: {0}")]
    Auth(String),

    #[error("not found: {entity} {id}")]
    NotFound { entity: &'static str, id: String },

    #[error("rate limited, retry after {retry_after_ms}ms")]
    RateLimited { retry_after_ms: u64 },

    #[error("internal error: {0}")]
    Internal(String),
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    #[must_use]
    pub fn config(msg: impl Into<String>) -> Self {
        Self::Config(msg.into())
    }

    #[must_use]
    pub fn gateway(msg: impl Into<String>) -> Self {
        Self::Gateway(msg.into())
    }

    #[must_use]
    pub fn channel(channel: impl Into<String>, msg: impl Into<String>) -> Self {
        Self::Channel {
            channel: channel.into(),
            message: msg.into(),
        }
    }

    #[must_use]
    pub fn provider(provider: impl Into<String>, msg: impl Into<String>) -> Self {
        Self::Provider {
            provider: provider.into(),
            message: msg.into(),
        }
    }

    #[must_use]
    pub fn state(msg: impl Into<String>) -> Self {
        Self::State(msg.into())
    }

    #[must_use]
    pub fn transport(msg: impl Into<String>) -> Self {
        Self::Transport(msg.into())
    }

    #[must_use]
    pub fn protocol(msg: impl Into<String>) -> Self {
        Self::Protocol(msg.into())
    }

    #[must_use]
    pub fn auth(msg: impl Into<String>) -> Self {
        Self::Auth(msg.into())
    }

    #[must_use]
    pub fn not_found(entity: &'static str, id: impl Into<String>) -> Self {
        Self::NotFound {
            entity,
            id: id.into(),
        }
    }

    #[must_use]
    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    /// Whether this error is transient and the operation may succeed on retry.
    #[must_use]
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Transport(_) | Self::RateLimited { .. } | Self::State(_)
        )
    }
}

/// Gateway error codes matching the TypeScript protocol.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    Unauthorized,
    Forbidden,
    NotFound,
    InvalidParams,
    RateLimited,
    Internal,
    ProtocolMismatch,
    ChannelUnavailable,
    ProviderUnavailable,
}

impl ErrorCode {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unauthorized => "UNAUTHORIZED",
            Self::Forbidden => "FORBIDDEN",
            Self::NotFound => "NOT_FOUND",
            Self::InvalidParams => "INVALID_PARAMS",
            Self::RateLimited => "RATE_LIMITED",
            Self::Internal => "INTERNAL",
            Self::ProtocolMismatch => "PROTOCOL_MISMATCH",
            Self::ChannelUnavailable => "CHANNEL_UNAVAILABLE",
            Self::ProviderUnavailable => "PROVIDER_UNAVAILABLE",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}
