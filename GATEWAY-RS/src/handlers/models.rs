use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_models_list(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let config = state.config.read().await;

    // Extract models from config
    let models = config.extra.get("models")
        .and_then(|m| m.get("list"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();

    let payload = json!({
        "models": models
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
