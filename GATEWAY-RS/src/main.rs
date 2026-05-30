pub mod auth;
pub mod models;
pub mod state;
pub mod http;
pub mod handlers;
pub mod registry;
pub mod sessions;
pub mod tasks;
pub mod llm;

use std::net::SocketAddr;
use crate::models::config::OpenClawConfig;
use crate::state::AppState;
use crate::llm::OpenAIClient;
use std::sync::Arc;
use anyhow::Result;
use std::fs;

async fn load_config() -> OpenClawConfig {
    let config_path = std::env::var("OPENCLAW_CONFIG_PATH").unwrap_or_else(|_| "openclaw.json".to_string());
    if let Ok(content) = fs::read_to_string(config_path) {
        if let Ok(config) = serde_json::from_str(&content) {
            return config;
        }
    }
    OpenClawConfig::default()
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt::init();

    let config = load_config().await;

    // Setup LLM client
    let api_key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
    let llm_client = Arc::new(OpenAIClient {
        api_key,
        base_url: "https://api.openai.com/v1".to_string(),
        client: reqwest::Client::new(),
    });

    let state = Arc::new(AppState::new(config, llm_client));

    let app = http::create_router(state);

    let port = std::env::var("OPENCLAW_GATEWAY_PORT")
        .unwrap_or_else(|_| "18789".to_string())
        .parse::<u16>()?;

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    tracing::info!("listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
