use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_node_list(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let nodes = state.node_registry.list();
    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(json!({"nodes": nodes})),
        error: None,
    })
}
