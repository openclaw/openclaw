use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_health(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let uptime = state.start_time.elapsed().as_millis();
    let payload = json!({
        "ok": true,
        "status": "live",
        "uptimeMs": uptime,
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}

pub async fn handle_status(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let uptime = state.start_time.elapsed().as_millis();
    let payload = json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "uptimeMs": uptime,
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
