//! MCP (Model Context Protocol) server for Synology API.
//!
//! Exposes Synology NAS operations as MCP tools over SSE or stdio transport.

mod dispatch;
mod session;
mod sse;
mod stdio;
mod tools;

pub use sse::run_server;
pub use stdio::run_stdio;
