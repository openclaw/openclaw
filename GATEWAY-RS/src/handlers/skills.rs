use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_skills_status(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let config = state.config.read().await;
    let skills = config.extra.get("skills")
        .and_then(|s| s.get("list"))
        .cloned()
        .unwrap_or_else(|| json!([]));

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(json!({"skills": skills})),
        error: None,
    })
}
