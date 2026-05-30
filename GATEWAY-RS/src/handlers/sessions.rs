use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_sessions_list(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let agent_id = req.params.as_ref()
        .and_then(|p| p.get("agentId"))
        .and_then(|a| a.as_str());

    let sessions = state.session_manager.list_sessions(agent_id).unwrap_or_default();

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
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let agent_id = req.params.as_ref()
        .and_then(|p| p.get("agentId"))
        .and_then(|a| a.as_str())
        .unwrap_or("default");

    let label = req.params.as_ref()
        .and_then(|p| p.get("label"))
        .and_then(|l| l.as_str());

    match state.session_manager.create_session(agent_id, label) {
        Ok(payload) => Json(ResponseFrame {
            id: req.id,
            ok: true,
            payload: Some(payload),
            error: None,
        }),
        Err(e) => Json(ResponseFrame {
            id: req.id,
            ok: false,
            payload: None,
            error: Some(crate::models::protocol::ErrorShape {
                code: "INTERNAL_ERROR".to_string(),
                message: e.to_string(),
                details: None,
                retryable: Some(false),
                retry_after_ms: None,
            }),
        }),
    }
}
