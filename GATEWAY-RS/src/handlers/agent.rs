use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_agent_identity_get(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let config = state.config.read().await;

    // Attempt to get the default agent from config
    let agent_id = "default";
    let display_name = config.extra.get("ui")
        .and_then(|ui| ui.get("assistant"))
        .and_then(|asst| asst.get("name"))
        .and_then(|n| n.as_str())
        .unwrap_or("OpenClaw Assistant");

    let payload = json!({
        "agentId": agent_id,
        "displayName": display_name
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
