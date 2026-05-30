use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_channels_status(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let config = state.config.read().await;
    let channels = config.channels.as_ref().cloned().unwrap_or_default();

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(json!({"channels": channels})),
        error: None,
    })
}
