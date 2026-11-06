//! Connections: admission identity, stream open/accept, close with code + reason.

use iroh::endpoint::{self, ConnectionError, VarInt};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{
    js_err,
    stream::{RecvStream, SendStream},
};

/// How a connection ended, as returned by `Connection.closed()`.
#[napi(object)]
pub struct CloseInfo {
    /// Application close code, when the peer or we closed with one; otherwise null.
    pub code: Option<u32>,
    /// Application close reason (UTF-8, lossy) or the transport error text.
    pub reason: String,
    /// "application", "locally_closed", "timed_out", "reset" or "transport".
    pub kind: String,
}

/// An established QUIC connection.
#[napi]
pub struct Connection(endpoint::Connection);

impl Connection {
    pub(crate) fn new(c: endpoint::Connection) -> Self {
        Self(c)
    }
}

/// Opened/accepted stream halves before they become JS objects.
pub struct RawBi(SendStream, RecvStream);

impl ToNapiValue for RawBi {
    unsafe fn to_napi_value(env: sys::napi_env, v: Self) -> Result<sys::napi_value> {
        let env_w = Env::from_raw(env);
        let mut obj = Object::new(&env_w)?;
        obj.set("send", v.0)?;
        obj.set("recv", v.1)?;
        unsafe { Object::to_napi_value(env, obj) }
    }
}

impl TypeName for RawBi {
    fn type_name() -> &'static str {
        "BiStream"
    }
    fn value_type() -> ValueType {
        ValueType::Object
    }
}

#[napi]
impl Connection {
    /// Remote endpoint id (lowercase hex), authenticated by the TLS handshake.
    #[napi]
    pub fn remote_id(&self) -> String {
        self.0.remote_id().to_string()
    }

    /// Opens a bidirectional stream.
    #[napi(ts_return_type = "Promise<{ send: SendStream, recv: RecvStream }>")]
    pub async fn open_bi(&self) -> Result<RawBi> {
        let (s, r) = self.0.open_bi().await.map_err(js_err)?;
        Ok(RawBi(SendStream::new(s), RecvStream::new(r)))
    }

    /// Accepts the next peer-opened bidirectional stream; rejects once the connection is closed.
    #[napi(ts_return_type = "Promise<{ send: SendStream, recv: RecvStream }>")]
    pub async fn accept_bi(&self) -> Result<RawBi> {
        let (s, r) = self.0.accept_bi().await.map_err(js_err)?;
        Ok(RawBi(SendStream::new(s), RecvStream::new(r)))
    }

    /// Sets how many peer-opened bidi streams may be open at once (QUIC stream credit).
    #[napi]
    pub fn set_max_concurrent_bi_streams(&self, n: u32) {
        self.0.set_max_concurrent_bi_streams(VarInt::from_u32(n));
    }

    /// Closes the connection with an application code and reason (string or bytes).
    #[napi]
    pub fn close(&self, code: u32, reason: Either<String, Uint8Array>) {
        let bytes: Vec<u8> = match reason {
            Either::A(s) => s.into_bytes(),
            Either::B(b) => b.to_vec(),
        };
        self.0.close(VarInt::from_u32(code), &bytes);
    }

    /// Resolves with the numeric close code and reason once the connection ends.
    #[napi]
    pub async fn closed(&self) -> CloseInfo {
        close_info(self.0.closed().await)
    }

    /// "direct" if the selected path is UDP, "relay" if it goes through the relay, else "none".
    #[napi]
    pub fn path_kind(&self) -> String {
        let paths = self.0.paths();
        match paths.iter().find(|p| p.is_selected()) {
            Some(p) if p.is_ip() => "direct".into(),
            Some(p) if p.is_relay() => "relay".into(),
            _ => "none".into(),
        }
    }

    /// Round-trip time of the selected path in milliseconds, if known.
    #[napi]
    pub fn rtt_ms(&self) -> Option<f64> {
        let paths = self.0.paths();
        paths
            .iter()
            .find(|p| p.is_selected())
            .map(|p| p.rtt().as_secs_f64() * 1000.0)
    }
}

// Maps a connection error to a code/reason/kind triple for JS.
fn close_info(e: ConnectionError) -> CloseInfo {
    let (code, reason, kind) = match &e {
        ConnectionError::ApplicationClosed(c) => (
            Some(c.error_code.into_inner() as u32),
            String::from_utf8_lossy(&c.reason).into_owned(),
            "application",
        ),
        ConnectionError::LocallyClosed => (None, e.to_string(), "locally_closed"),
        ConnectionError::TimedOut => (None, e.to_string(), "timed_out"),
        ConnectionError::Reset => (None, e.to_string(), "reset"),
        _ => (None, e.to_string(), "transport"),
    };
    CloseInfo {
        code,
        reason,
        kind: kind.into(),
    }
}
