use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_chat_history(
    State(_state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let payload = json!({
        "sessionKey": "placeholder",
        "messages": [
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "Welcome to OpenClaw Gateway (Rust)!"}],
                "timestamp": chrono::Utc::now().timestamp_millis()
            }
        ],
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}

pub async fn handle_chat_send(
    State(_state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    // Extract message if present
    let message = req.params.as_ref()
        .and_then(|p| p.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");

    tracing::info!("Received message: {}", message);

    let payload = json!({
        "runId": uuid::Uuid::new_v4().to_string(),
        "status": "started",
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use crate::models::config::OpenClawConfig;
    use std::sync::Arc;

    #[tokio::test]
    async fn test_handle_chat_send() {
        let state = Arc::new(AppState::new(OpenClawConfig::default()));
        let req = RequestFrame {
            id: "test-id".to_string(),
            method: "chat.send".to_string(),
            params: Some(json!({"message": "hello"})),
        };

        let response = handle_chat_send(State(state), Json(req)).await;
        assert_eq!(response.id, "test-id");
        assert!(response.ok);
        assert!(response.payload.is_some());
    }
}
