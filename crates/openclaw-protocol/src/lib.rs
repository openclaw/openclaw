//! Gateway protocol types, matching `packages/gateway-protocol/src/schema/`.
//!
//! Version 4 is the current wire version; `MIN_CLIENT_PROTOCOL_VERSION` is 4 and
//! `MIN_NODE_PROTOCOL_VERSION` is 3, per
//! `packages/gateway-protocol/src/version.ts`.

pub mod core_methods;
pub mod frame;
pub mod methods;

pub use frame::{ErrorShape, Frame, IncomingFrame, OutgoingFrame};

/// Current gateway protocol version emitted by modern clients and servers.
pub const PROTOCOL_VERSION: u32 = 4;

/// Lowest general client protocol version accepted by the gateway.
pub const MIN_CLIENT_PROTOCOL_VERSION: u32 = 4;

/// Lowest authenticated node protocol version accepted by the gateway.
pub const MIN_NODE_PROTOCOL_VERSION: u32 = 3;

/// Lowest lightweight probe protocol version accepted by the gateway.
pub const MIN_PROBE_PROTOCOL_VERSION: u32 = 3;
