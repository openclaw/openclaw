//! Transport only: native apps own enrollment, verified destinations, and tunnel framing.
#[cfg(target_os = "android")]
mod android;
mod connection;
mod endpoint;
mod stream;

pub use connection::*;
pub use endpoint::*;
pub use stream::*;

uniffi::setup_scaffolding!();

#[derive(Debug, uniffi::Error)]
pub enum IrohError {
    InvalidArgument { detail: String },
    EndpointClosed,
    Cancelled,
    Transport { detail: String },
    StreamReset { code: i64 },
    StreamStopped { code: i64 },
}

impl std::fmt::Display for IrohError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidArgument { detail } | Self::Transport { detail } => f.write_str(detail),
            Self::EndpointClosed => f.write_str("endpoint closed"),
            Self::Cancelled => f.write_str("operation cancelled"),
            Self::StreamReset { code } => write!(f, "stream reset ({code})"),
            Self::StreamStopped { code } => write!(f, "stream stopped ({code})"),
        }
    }
}
impl std::error::Error for IrohError {}

fn invalid(message: &str) -> IrohError {
    IrohError::InvalidArgument {
        detail: message.into(),
    }
}
fn transport(message: &str) -> IrohError {
    IrohError::Transport {
        detail: message.into(),
    }
}
fn code(value: i64) -> Result<iroh::endpoint::VarInt, IrohError> {
    u64::try_from(value)
        .ok()
        .and_then(|v| iroh::endpoint::VarInt::from_u64(v).ok())
        .ok_or_else(|| invalid("code must be in 0..2^62"))
}

// A dropped owner is cancellation too. Each operation subscribes before entering its select.
async fn cancelled(mut rx: tokio::sync::watch::Receiver<bool>) {
    let _ = rx.wait_for(|value| *value).await;
}

/// Caller-held cancellation for one or more pending operations.
///
/// Swift's generated async calls cannot cancel the Rust future, so callers pass a
/// token and call `cancel()` from their task cancellation handler. Cancelling is
/// idempotent and affects every operation that received this token.
#[derive(uniffi::Object)]
pub struct CancelToken {
    tx: tokio::sync::watch::Sender<bool>,
}
#[uniffi::export]
impl CancelToken {
    #[uniffi::constructor]
    pub fn new() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            tx: tokio::sync::watch::Sender::new(false),
        })
    }
    pub fn cancel(&self) {
        self.tx.send_replace(true);
    }
}
impl CancelToken {
    // Resolves once cancelled; never resolves when no token was supplied.
    async fn wait(token: Option<&std::sync::Arc<Self>>) {
        match token {
            Some(token) => cancelled(token.tx.subscribe()).await,
            None => std::future::pending().await,
        }
    }
}
