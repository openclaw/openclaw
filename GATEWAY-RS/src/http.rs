use axum::{
    extract::{State, WebSocketUpgrade, ws::{WebSocket, Message}},
    response::IntoResponse,
    routing::{get, post},
    Router,
    Json,
};
use crate::state::SharedState;
use crate::handlers::{chat, health, sessions, agent, models, config, secrets, channels, nodes, skills, tools, tasks};
use crate::models::protocol::{GatewayFrame, ResponseFrame, RequestFrame};
use serde_json::json;
use futures_util::{SinkExt, StreamExt};

pub fn create_router(state: SharedState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/healthz", get(health_handler))
        .route("/ready", get(ready_handler))
        .route("/readyz", get(ready_handler))
        .route("/ws", get(ws_handler))
        .route("/v1/models", get(models_handler))
        .route("/v1/chat/completions", post(chat_completions_handler))
        .route("/api/chat/history", post(chat::handle_chat_history))
        .route("/api/chat/send", post(chat::handle_chat_send))
        .route("/api/health", post(health::handle_health))
        .route("/api/status", post(health::handle_status))
        .with_state(state)
}

async fn health_handler() -> impl IntoResponse {
    Json(json!({ "ok": true, "status": "live" }))
}

async fn ready_handler(State(state): State<SharedState>) -> impl IntoResponse {
    let uptime = state.start_time.elapsed().as_millis();
    Json(json!({ "ready": true, "uptimeMs": uptime }))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let (mut sender, mut receiver) = socket.split();

    while let Some(Ok(msg)) = receiver.next().await {
        if let Message::Text(text) = msg {
            match serde_json::from_str::<GatewayFrame>(&text) {
                Ok(frame) => {
                    match frame {
                        GatewayFrame::Request(req) => {
                            let response = dispatch_rpc(req, state.clone()).await;
                            let res_frame = GatewayFrame::Response(response);
                            if let Ok(res_text) = serde_json::to_string(&res_frame) {
                                let _ = sender.send(Message::Text(res_text.into())).await;
                            }
                        }
                        _ => {}
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to parse WebSocket frame: {}", e);
                }
            }
        }
    }
}

async fn dispatch_rpc(req: RequestFrame, state: SharedState) -> ResponseFrame {
    let method = req.method.clone();
    let id = req.id.clone();
    let axum_json_req = Json(req);
    let axum_state = State(state);

    let res_json = match method.as_str() {
        "chat.send" => chat::handle_chat_send(axum_state, axum_json_req).await,
        "chat.history" => chat::handle_chat_history(axum_state, axum_json_req).await,
        "health" => health::handle_health(axum_state, axum_json_req).await,
        "status" => health::handle_status(axum_state, axum_json_req).await,
        "sessions.list" => sessions::handle_sessions_list(axum_state, axum_json_req).await,
        "sessions.create" => sessions::handle_sessions_create(axum_state, axum_json_req).await,
        "agent.identity.get" => agent::handle_agent_identity_get(axum_state, axum_json_req).await,
        "models.list" => models::handle_models_list(axum_state, axum_json_req).await,
        "config.get" => config::handle_config_get(axum_state, axum_json_req).await,
        "secrets.reload" => secrets::handle_secrets_reload(axum_state, axum_json_req).await,
        "channels.status" => channels::handle_channels_status(axum_state, axum_json_req).await,
        "node.list" => nodes::handle_node_list(axum_state, axum_json_req).await,
        "skills.status" => skills::handle_skills_status(axum_state, axum_json_req).await,
        "tools.catalog" => tools::handle_tools_catalog(axum_state, axum_json_req).await,
        "tasks.list" => tasks::handle_tasks_list(axum_state, axum_json_req).await,
        _ => return ResponseFrame {
            id,
            ok: false,
            payload: None,
            error: Some(crate::models::protocol::ErrorShape {
                code: "METHOD_NOT_FOUND".to_string(),
                message: format!("Method {} not found", method),
                details: None,
                retryable: Some(false),
                retry_after_ms: None,
            }),
        },
    };

    res_json.0
}

async fn models_handler() -> impl IntoResponse {
    Json(json!({ "data": [] }))
}

async fn chat_completions_handler(Json(_payload): Json<serde_json::Value>) -> impl IntoResponse {
    Json(json!({ "id": "chatcmpl-placeholder", "object": "chat.completion", "created": 123456789, "model": "placeholder", "choices": [] }))
}
