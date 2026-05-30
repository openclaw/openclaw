use axum::{extract::State, Json};
use crate::state::SharedState;
use crate::models::protocol::{RequestFrame, ResponseFrame};
use serde_json::json;

pub async fn handle_tools_catalog(
    State(state): State<SharedState>,
    Json(req): Json<RequestFrame>,
) -> Json<ResponseFrame> {
    let config = state.config.read().await;

    // Simplified logic: list tools from config if present, or provide defaults
    let tools = config.extra.get("tools")
        .and_then(|t| t.get("list"))
        .cloned()
        .unwrap_or_else(|| json!([
            {"id": "bash", "label": "Bash", "description": "Execute shell commands", "source": "core"},
            {"id": "python", "label": "Python", "description": "Execute python code", "source": "core"}
        ]));

    let payload = json!({
        "agentId": "default",
        "groups": [
            {
                "id": "core",
                "label": "Core Tools",
                "source": "core",
                "tools": tools
            }
        ]
    });

    Json(ResponseFrame {
        id: req.id,
        ok: true,
        payload: Some(payload),
        error: None,
    })
}
