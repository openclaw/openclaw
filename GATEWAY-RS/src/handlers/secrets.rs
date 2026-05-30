use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_secrets_reload(
    State(_state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(json!({"ok": true})),
        error: None,
    })
}
