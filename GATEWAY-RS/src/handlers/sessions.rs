use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use crate::sessions::store::{load_session_store, save_session_store};
use crate::sessions::types::SessionEntry;
use serde_json::json;
use chrono::Utc;

pub async fn handle_sessions_list(
    State(_state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    // In a real implementation, we would resolve the store path from config
    let store_path = "sessions.json";
    let sessions = match load_session_store(store_path) {
        Ok(store) => store.sessions.values().cloned().collect::<Vec<SessionEntry>>(),
        Err(_) => Vec::new(),
    };

    let payload = json!({
        "sessions": sessions
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}

pub async fn handle_sessions_create(
    State(_state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let store_path = "sessions.json";
    let mut store = load_session_store(store_path).unwrap_or_default();

    let session_id = uuid::Uuid::new_v4().to_string();
    let session_key = format!("agent:default:{}", session_id);

    let entry = SessionEntry {
        session_id: session_id.clone(),
        updated_at: Utc::now().timestamp_millis() as u64,
        agent_id: Some("default".to_string()),
        ..Default::default()
    };

    store.sessions.insert(session_key.clone(), entry.clone());

    let payload = if save_session_store(store_path, &store).is_ok() {
        json!({
            "sessionKey": session_key,
            "sessionId": session_id,
            "entry": entry
        })
    } else {
        json!({"error": "Failed to save session"})
    };

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
