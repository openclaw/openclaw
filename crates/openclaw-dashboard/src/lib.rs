//! Web dashboard: HTTP server serving the control UI and a REST status API.

pub mod server;
pub mod ui;

pub use server::{DashboardServer, HttpRequest};
