use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_secrets_reload(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    // Ported logic: Reload configuration from disk
    let config_path = std::env::var("OPENCLAW_CONFIG_PATH").unwrap_or_else(|_| "openclaw.json".to_string());
    let mut config = state.config.write().await;

    let result = if let Ok(content) = std::fs::read_to_string(config_path) {
        if let Ok(new_config) = serde_json::from_str(&content) {
            *config = new_config;
            json!({"ok": true})
        } else {
            json!({"ok": false, "error": "Failed to parse config"})
        }
    } else {
        json!({"ok": false, "error": "Config file not found"})
    };

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(result),
        error: None,
    })
}
