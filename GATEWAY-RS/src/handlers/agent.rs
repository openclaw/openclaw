use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_agent_identity_get(
    State(_state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let payload = json!({
        "agentId": "default-agent",
        "displayName": "OpenClaw Assistant"
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
