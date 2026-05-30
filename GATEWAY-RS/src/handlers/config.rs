use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_config_get(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let config = state.config.read().await;
    let payload = json!({
        "config": *config
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
