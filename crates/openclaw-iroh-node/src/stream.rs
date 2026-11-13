//! Stream halves. Reads copy the received bytes into a JS-owned Buffer on the JS thread; writes
//! copy the caller's Buffer/Uint8Array once on the JS thread (so JS may reuse it immediately) and
//! then await QUIC flow control off-thread.
//!
//! Each half serializes I/O behind a mutex. `stop` and `reset` first raise the half's cancel
//! signal, which makes a pending read or write give up its lock, so they never wait on a peer
//! that stays silent or withholds flow-control credit.

use std::sync::Arc;

use iroh::endpoint::{self, VarInt};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use tokio::{
    io::AsyncReadExt,
    sync::{Mutex, watch},
};

use crate::js_err;

// Resolves once `stop` or `reset` has been requested for this half. The sender lives as long as
// the half itself, so a dropped sender means nobody can cancel and the wait never resolves.
async fn cancelled(mut rx: watch::Receiver<bool>) {
    if rx.wait_for(|requested| *requested).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Sending half of a bidirectional stream.
#[napi]
pub struct SendStream {
    inner: Arc<Mutex<endpoint::SendStream>>,
    cancel: watch::Sender<bool>,
}

impl SendStream {
    pub(crate) fn new(s: endpoint::SendStream) -> Self {
        Self {
            inner: Arc::new(Mutex::new(s)),
            cancel: watch::Sender::new(false),
        }
    }
}

#[napi]
impl SendStream {
    /// Writes all bytes; resolves when QUIC has accepted them (flow-control backpressure).
    #[napi(ts_return_type = "Promise<void>")]
    pub fn write<'env>(&self, env: &'env Env, data: &[u8]) -> Result<PromiseRaw<'env, ()>> {
        let bytes = data.to_vec();
        let inner = self.inner.clone();
        let cancel = self.cancel.subscribe();
        env.spawn_future(async move {
            // A reset abandons the write; otherwise wait for QUIC to accept every byte.
            tokio::select! {
                biased;
                () = cancelled(cancel) => Err(js_err("stream reset")),
                written = async { inner.lock().await.write_all(&bytes).await } => {
                    written.map_err(js_err)
                }
            }
        })
    }

    /// Ends the send side cleanly (FIN).
    #[napi]
    pub async fn finish(&self) -> Result<()> {
        self.inner.lock().await.finish().map_err(js_err)
    }

    /// Abandons the send side with an application error code. A pending write rejects first, so
    /// the reset is not held up by a peer that withholds flow-control credit.
    #[napi]
    pub async fn reset(&self, code: u32) -> Result<()> {
        self.cancel.send_replace(true);
        self.inner
            .lock()
            .await
            .reset(VarInt::from_u32(code))
            .map_err(js_err)
    }
}

/// Receiving half of a bidirectional stream.
#[napi]
pub struct RecvStream {
    inner: Mutex<endpoint::RecvStream>,
    cancel: watch::Sender<bool>,
}

impl RecvStream {
    pub(crate) fn new(r: endpoint::RecvStream) -> Self {
        Self {
            inner: Mutex::new(r),
            cancel: watch::Sender::new(false),
        }
    }
}

#[napi]
impl RecvStream {
    /// Reads whatever is available (at least 1 byte, at most `max`), gathering every chunk QUIC has
    /// already received so one JS call covers many packets; resolves null at end of stream.
    /// Rejects if the peer reset the stream (message contains the reset code).
    #[napi(ts_return_type = "Promise<Buffer | null>")]
    pub async fn read(&self, max: u32) -> Result<Option<ReadBytes>> {
        if max == 0 {
            return Err(js_err("max must be > 0"));
        }
        // read_buf fills spare capacity without zeroing it; 0 bytes read with room left means EOF.
        let mut buf = Vec::with_capacity(max as usize);
        // A stop abandons the read; otherwise wait for data, end of stream or a peer reset.
        let n = tokio::select! {
            biased;
            () = cancelled(self.cancel.subscribe()) => return Err(js_err("stream stopped")),
            read = async { self.inner.lock().await.read_buf(&mut buf).await } => {
                read.map_err(js_err)?
            }
        };
        Ok((n > 0).then_some(ReadBytes(buf)))
    }

    /// Asks the peer to stop sending, with an application error code. A pending read rejects
    /// first, so STOP_SENDING is not held up by a peer that stays silent.
    #[napi]
    pub async fn stop(&self, code: u32) -> Result<()> {
        self.cancel.send_replace(true);
        self.inner
            .lock()
            .await
            .stop(VarInt::from_u32(code))
            .map_err(js_err)
    }
}

/// Bytes read off the JS thread. Converting them to JS copies them into a JS-owned Buffer and frees
/// the Rust allocation at once, so read buffers never wait for a GC. (An external Buffer over the
/// Vec lives until a later GC; under 8 parallel downloads those late frees left glibc's per-thread
/// arenas holding ~70 MB more RSS.)
pub struct ReadBytes(Vec<u8>);

impl ToNapiValue for ReadBytes {
    unsafe fn to_napi_value(env: sys::napi_env, v: Self) -> Result<sys::napi_value> {
        Ok(BufferSlice::copy_from(&Env::from_raw(env), &v.0)?.raw())
    }
}

impl TypeName for ReadBytes {
    fn type_name() -> &'static str {
        "Buffer"
    }
    fn value_type() -> ValueType {
        ValueType::Object
    }
}
