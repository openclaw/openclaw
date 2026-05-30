use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;
use std::fs::File;
use std::io::{BufReader, BufRead};
use chrono::Utc;

pub async fn handle_chat_history(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let session_key = req.params.as_ref()
        .and_then(|p| p.get("sessionKey"))
        .and_then(|s| s.as_str())
        .unwrap_or("unknown");

    let store = state.session_manager.load_store().unwrap_or_default();
    let entry = store.sessions.get(session_key);

    let mut messages = Vec::new();

    if let Some(entry) = entry {
        let transcript_path = entry.session_file.as_deref()
            .unwrap_or_else(|| "nonexistent.jsonl");

        if let Ok(file) = File::open(transcript_path) {
            let reader = BufReader::new(file);
            for line in reader.lines().flatten() {
                if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) {
                    messages.push(msg);
                }
            }
        }
    }

    if messages.is_empty() {
        messages.push(json!({
            "role": "assistant",
            "content": [{"type": "text", "text": "OpenClaw Gateway (Rust) transcript is empty."}],
            "timestamp": Utc::now().timestamp_millis()
        }));
    }

    let payload = json!({
        "sessionKey": session_key,
        "messages": messages,
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}

pub async fn handle_chat_send(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let session_key = req.params.as_ref()
        .and_then(|p| p.get("sessionKey"))
        .and_then(|s| s.as_str())
        .unwrap_or("unknown");

    let message = req.params.as_ref()
        .and_then(|p| p.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("");

    tracing::info!("Received message for {}: {}", session_key, message);

    let store = state.session_manager.load_store().unwrap_or_default();
    let entry = store.sessions.get(session_key);

    if let Some(entry) = entry {
        let session_id = &entry.session_id;
        let _ = state.session_manager.append_to_transcript(session_id, "user", message);

        // Simple echo response for now
        let _ = state.session_manager.append_to_transcript(session_id, "assistant", &format!("Echo: {}", message));
    }

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
            params: Some(json!({"message": "hello", "sessionKey": "test:session"})),
        };

        let response = handle_chat_send(State(state), Json(req)).await;
        assert_eq!(response.id, "test-id");
        assert!(response.ok);
        assert!(response.payload.is_some());
    }
}
