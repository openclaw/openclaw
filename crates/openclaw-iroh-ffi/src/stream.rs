use crate::{IrohError, cancelled, invalid, transport};
use iroh::endpoint::{self, ReadError, WriteError};
use std::sync::Arc;
use tokio::sync::{Mutex, watch};

#[derive(uniffi::Record)]
pub struct BiStream {
    pub send: Arc<SendStream>,
    pub recv: Arc<RecvStream>,
}
impl BiStream {
    pub(crate) fn new(
        send: endpoint::SendStream,
        recv: endpoint::RecvStream,
        shutdown: watch::Receiver<bool>,
    ) -> Self {
        Self {
            send: Arc::new(SendStream {
                inner: Mutex::new(send),
                cancel: watch::Sender::new(false),
                shutdown: shutdown.clone(),
            }),
            recv: Arc::new(RecvStream {
                inner: Mutex::new(recv),
                cancel: watch::Sender::new(false),
                shutdown,
            }),
        }
    }
}
#[derive(uniffi::Object)]
pub struct SendStream {
    inner: Mutex<endpoint::SendStream>,
    cancel: watch::Sender<bool>,
    shutdown: watch::Receiver<bool>,
}
#[uniffi::export(async_runtime = "tokio")]
impl SendStream {
    pub async fn write(&self, data: Vec<u8>) -> Result<(), IrohError> {
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.clone()) => Err(IrohError::EndpointClosed),
            () = cancelled(self.cancel.subscribe()) => Err(IrohError::Cancelled),
            result = async { self.inner.lock().await.write_all(&data).await } => {
                result.map_err(|e| match e {
                    WriteError::Stopped(value) => IrohError::StreamStopped { code: value.into_inner() as i64 },
                    _ => transport("stream write failed"),
                })
            }
        }
    }
    pub async fn finish(&self) -> Result<(), IrohError> {
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.clone()) => Err(IrohError::EndpointClosed),
            () = cancelled(self.cancel.subscribe()) => Err(IrohError::Cancelled),
            result = async { self.inner.lock().await.finish() } => result.map_err(|_| transport("stream finish failed")),
        }
    }
    pub async fn reset(&self, code: i64) -> Result<(), IrohError> {
        let value = crate::code(code)?;
        self.cancel.send_replace(true);
        self.inner
            .lock()
            .await
            .reset(value)
            .map_err(|_| transport("stream reset failed"))
    }
}
#[derive(uniffi::Object)]
pub struct RecvStream {
    inner: Mutex<endpoint::RecvStream>,
    cancel: watch::Sender<bool>,
    shutdown: watch::Receiver<bool>,
}
#[uniffi::export(async_runtime = "tokio")]
impl RecvStream {
    pub async fn read(&self, max: u32) -> Result<Option<Vec<u8>>, IrohError> {
        if max == 0 || max > 1_048_576 {
            return Err(invalid("read max must be 1..1048576 bytes"));
        }
        tokio::select! {
            biased;
            () = cancelled(self.shutdown.clone()) => Err(IrohError::EndpointClosed),
            () = cancelled(self.cancel.subscribe()) => Err(IrohError::Cancelled),
            result = async {
                // Allocate only after obtaining the read lock: queued readers hold no payload buffer.
                let mut inner = self.inner.lock().await;
                let mut bytes = vec![0; max as usize];
                let len = inner.read(&mut bytes).await.map_err(|e| match e {
                    ReadError::Reset(value) => IrohError::StreamReset { code: value.into_inner() as i64 },
                    _ => transport("stream read failed"),
                })?;
                Ok(len.map(|len| { bytes.truncate(len); bytes }))
            } => result,
        }
    }
    pub async fn stop(&self, code: i64) -> Result<(), IrohError> {
        let value = crate::code(code)?;
        self.cancel.send_replace(true);
        self.inner
            .lock()
            .await
            .stop(value)
            .map_err(|_| transport("stream stop failed"))
    }
}
