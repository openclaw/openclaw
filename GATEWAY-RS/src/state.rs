use std::sync::Arc;
use tokio::sync::RwLock;
use crate::models::config::OpenClawConfig;
use crate::registry::NodeRegistry;
use crate::auth::AuthRateLimiter;

pub struct AppState {
    pub config: RwLock<OpenClawConfig>,
    pub start_time: std::time::Instant,
    pub node_registry: NodeRegistry,
    pub rate_limiter: AuthRateLimiter,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    pub fn new(config: OpenClawConfig) -> Self {
        Self {
            config: RwLock::new(config),
            start_time: std::time::Instant::now(),
            node_registry: NodeRegistry::new(),
            rate_limiter: AuthRateLimiter::new(10, 60), // Default 10 attempts per minute
        }
    }
}
