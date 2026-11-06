use crate::{BiStream, IrohError, cancelled, transport};
use iroh::endpoint::{self, ConnectionError, VarInt};
use std::sync::Arc;
use tokio::sync::watch;

#[derive(Debug, PartialEq, Eq, uniffi::Enum)]
pub enum CloseKind {
    Application,
    LocallyClosed,
    TimedOut,
    Reset,
    Transport,
}
#[derive(Debug, uniffi::Record)]
pub struct CloseInfo {
    pub kind: CloseKind,
    pub code: Option<i64>,
    pub reason: String,
}

#[derive(uniffi::Object)]
pub struct Connection {
    inner: endpoint::Connection,
    shutdown: watch::Receiver<bool>,
}
impl Connection {
    pub(crate) fn new(inner: endpoint::Connection, shutdown: watch::Receiver<bool>) -> Arc<Self> {
        Arc::new(Self { inner, shutdown })
    }
}
// Last foreign handle release must not leave a live connection awaiting idle timeout.
impl Drop for Connection {
    fn drop(&mut self) {
        self.inner.close(VarInt::from_u32(0), b"");
    }
}
#[uniffi::export(async_runtime = "tokio")]
impl Connection {
    pub fn remote_id(&self) -> String {
        self.inner.remote_id().to_string()
    }
    pub async fn open_bi(&self) -> Result<BiStream, IrohError> {
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.clone()) => Err(IrohError::EndpointClosed),
            result = self.inner.open_bi() => {
                let (send, recv) = result.map_err(|_| transport("open stream failed"))?;
                Ok(BiStream::new(send, recv, self.shutdown.clone()))
            }
        }
    }
    pub async fn accept_bi(&self) -> Result<BiStream, IrohError> {
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.clone()) => Err(IrohError::EndpointClosed),
            result = self.inner.accept_bi() => {
                let (send, recv) = result.map_err(|_| transport("accept stream failed"))?;
                Ok(BiStream::new(send, recv, self.shutdown.clone()))
            }
        }
    }
    pub fn set_max_concurrent_bi_streams(&self, count: u32) {
        self.inner
            .set_max_concurrent_bi_streams(VarInt::from_u32(count));
    }
    pub fn close(&self, code: i64, reason: Vec<u8>) -> Result<(), IrohError> {
        self.inner.close(crate::code(code)?, &reason);
        Ok(())
    }
    pub async fn closed(&self) -> CloseInfo {
        let error = self.inner.closed().await;
        match error {
            ConnectionError::ApplicationClosed(close) => CloseInfo {
                kind: CloseKind::Application,
                // VarInt is bounded to 62 bits: every legal code fits in signed 64 bits.
                code: Some(close.error_code.into_inner() as i64),
                reason: String::from_utf8_lossy(&close.reason).into_owned(),
            },
            other => CloseInfo {
                kind: match other {
                    ConnectionError::LocallyClosed => CloseKind::LocallyClosed,
                    ConnectionError::TimedOut => CloseKind::TimedOut,
                    ConnectionError::Reset => CloseKind::Reset,
                    _ => CloseKind::Transport,
                },
                code: None,
                reason: other.to_string(),
            },
        }
    }
}
