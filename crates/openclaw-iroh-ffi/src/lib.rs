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
            Self::Cancelled => f.write_str("stream operation cancelled"),
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
