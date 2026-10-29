//! Gateway WebSocket server: connection handling, session registry, method dispatch.

pub mod connection;
pub mod dispatch;
pub mod server;
pub mod session_registry;

pub use server::{Gateway, GatewayEvent, GatewayHandle};
pub use session_registry::SessionRegistry;
pub use dispatch::{ConnectionScopes, Dispatcher, TranscriptReader};
