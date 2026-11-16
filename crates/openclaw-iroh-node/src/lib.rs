//! openclaw-iroh-node: the smallest iroh surface the tunnel ingress needs, exposed to Node with
//! napi-rs v3. Every byte payload crosses the boundary as a Buffer/Uint8Array (one memcpy), never as
//! a JS number array.

mod conn;
mod endpoint;
mod stream;

pub use conn::*;
pub use endpoint::*;
pub use stream::*;

/// Converts any displayable error into a JS Error.
pub(crate) fn js_err(e: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}
