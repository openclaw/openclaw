//! SSE HTTP server entry point and handlers.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use super::dispatch::{handle_jsonrpc, JsonRpcRequest, JsonRpcResponse};
use super::session::*;

async fn sse_handler(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, axum::Error>>> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<Result<Event, axum::Error>>(32);

    if let Some(cfg) = NasConfig::from_headers(&headers) {
        eprintln!("SSE {session_id}: headers auth detected ({}:{})", cfg.host, cfg.port);
        let t = Instant::now();
        match login_with_config(&cfg).await {
            Ok(session) => {
                eprintln!("[timing] SSE auto-login: {:?}", t.elapsed());
                let nas_key = format!("__header_{session_id}__");
                state.nas_sessions.lock().await.insert(nas_key, session);
                state.session_configs.lock().await.insert(session_id.clone(), cfg);
                eprintln!("SSE {session_id}: auto-login successful");
            }
            Err(e) => {
                eprintln!("SSE {session_id}: auto-login failed: {e} (config saved for retry)");
                state.session_configs.lock().await.insert(session_id.clone(), cfg);
            }
        }
    }

    let endpoint_msg = format!("/messages?sessionId={session_id}");
    let _ = tx
        .send(Ok(Event::default().event("endpoint").data(endpoint_msg)))
        .await;

    state.sse_clients.lock().await.insert(
        session_id.clone(),
        SseClient {
            tx,
            created: Instant::now(),
        },
    );

    let stream = ReceiverStream::new(rx);
    let keepalive = tokio_stream::StreamExt::map(
        tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(Duration::from_secs(30))),
        |_| Ok(Event::default().comment("keepalive")),
    );
    let merged = stream.merge(keepalive);

    Sse::new(merged).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

async fn messages_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
    body: String,
) -> impl IntoResponse {
    let session_id = &query.session_id;

    let req: JsonRpcRequest = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => {
            let err = JsonRpcResponse::error(Value::Null, -32700, &format!("Parse error: {e}"));
            return (StatusCode::BAD_REQUEST, axum::Json(serde_json::to_value(err).unwrap()));
        }
    };

    let response = handle_jsonrpc(&state, req, session_id).await;

    let clients = state.sse_clients.lock().await;
    if let Some(client) = clients.get(session_id) {
        let response_json = serde_json::to_string(&response).unwrap_or_default();
        let event = Event::default().event("message").data(response_json);
        let _ = client.tx.send(Ok(event)).await;
    }

    (StatusCode::ACCEPTED, axum::Json(json!({})))
}

async fn health_handler() -> &'static str {
    "ok"
}

pub async fn run_server(host: &str, port: u16) -> anyhow::Result<()> {
    let state = Arc::new(AppState::new());

    tokio::spawn(cleanup_expired_sessions(state.clone()));

    let app = Router::new()
        .route("/sse", get(sse_handler))
        .route("/messages", post(messages_handler))
        .route("/health", get(health_handler))
        .with_state(state);

    let addr = format!("{host}:{port}");
    eprintln!("Synology MCP server listening on {addr}");
    eprintln!("SSE endpoint: http://{addr}/sse");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
