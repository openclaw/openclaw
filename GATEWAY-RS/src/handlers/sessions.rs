use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_sessions_list(
    State(_state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let payload = json!({
        "sessions": []
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
    let payload = json!({
        "sessionKey": "new-session-key",
        "sessionId": "new-session-id"
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
