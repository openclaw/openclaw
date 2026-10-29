use crate::dispatch::{ConnectionScopes, Dispatcher};
use crate::server::GatewayEvent;
use crate::session_registry::SessionRegistry;
use futures_util::{SinkExt, StreamExt};
use openclaw_config::GatewayAuth;
use openclaw_protocol::methods::{method, ConnectParams, ConnectChallenge};
use openclaw_protocol::{ErrorShape, IncomingFrame, OutgoingFrame};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

/// Accept same-host browser origins; reject everything else.
///
/// The Control UI is served from the Gateway host, so loopback and `localhost`
/// origins are the legitimate browser case. `OPENCLAW_CONTROL_UI_ORIGIN` adds one
/// explicit operator-configured origin for a reverse proxy or custom domain.
fn origin_allowed(origin: &str) -> bool {
    if let Ok(configured) = std::env::var("OPENCLAW_CONTROL_UI_ORIGIN") {
        if !configured.trim().is_empty() && origin.eq_ignore_ascii_case(configured.trim()) {
            return true;
        }
    }
    let Some((_scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    let host = authority
        .rsplit_once(':')
        .map_or(authority, |(host, _)| host);
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

/// Handle a single WebSocket client connection.
pub async fn handle_connection(
    stream: TcpStream,
    peer: SocketAddr,
    registry: Arc<SessionRegistry>,
    auth: GatewayAuth,
    max_frame_bytes: usize,
    mut events: broadcast::Receiver<GatewayEvent>,
    dispatcher: Arc<Dispatcher>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // WebSocket is not subject to CORS, so the upgrade itself must reject
    // cross-origin browser clients. Native clients send no Origin and are allowed.
    let callback = move |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                         response: tokio_tungstenite::tungstenite::handshake::server::Response|
          -> Result<
        tokio_tungstenite::tungstenite::handshake::server::Response,
        tokio_tungstenite::tungstenite::handshake::server::ErrorResponse,
    > {
        if let Some(origin) = request.headers().get("origin").and_then(|v| v.to_str().ok()) {
            if !origin_allowed(origin) {
                let mut rejection =
                    tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(Some(
                        "origin not allowed".to_owned(),
                    ));
                *rejection.status_mut() =
                    tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                return Err(rejection);
            }
        }
        Ok(response)
    };
    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(Some(max_frame_bytes))
        .max_frame_size(Some(max_frame_bytes));
    let ws = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        tokio_tungstenite::accept_hdr_async_with_config(stream, callback, Some(ws_config)),
    )
    .await??;
    let count = registry.add_connection();
    info!(%peer, connections = count, "client connected");

    let (mut write, mut read) = ws.split();
    let mut connected = false;
    let mut scopes = ConnectionScopes::default();

    // Official handshake: the server sends `connect.challenge` before the client's
    // first frame, so device-auth clients can sign the nonce.
    let challenge = ConnectChallenge {
        nonce: uuid::Uuid::new_v4().to_string(),
        ts: chrono::Utc::now().timestamp_millis().max(0) as u64,
    };
    let challenge_frame = OutgoingFrame::event(
        "connect.challenge",
        serde_json::to_value(&challenge).unwrap_or_default(),
    );
    if write
        .send(Message::Text(
            serde_json::to_string(&challenge_frame)?.into(),
        ))
        .await
        .is_err()
    {
        registry.remove_connection();
        return Ok(());
    }

    loop {
        // Serve both client frames and server-pushed events on one socket.
        let message = tokio::select! {
            incoming = read.next() => match incoming {
                Some(Ok(message)) => message,
                Some(Err(error)) => {
                    debug!(%peer, %error, "read error");
                    break;
                }
                None => break,
            },
            event = events.recv() => {
                let frame = match event {
                    Ok(GatewayEvent::Tick { ts }) => {
                        OutgoingFrame::event("tick", serde_json::json!({ "ts": ts }))
                    }
                    Ok(GatewayEvent::Shutdown { reason }) => {
                        let frame = OutgoingFrame::event(
                            "shutdown",
                            serde_json::json!({ "reason": reason }),
                        );
                        // Best effort: publish then close.
                        let json = serde_json::to_string(&frame)?;
                        let _ = write.send(Message::Text(json.into())).await;
                        break;
                    }
                    // Lagged clients skip missed ticks; the newest tick is enough.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let json = serde_json::to_string(&frame)?;
                if write.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
                continue;
            }
        };

        match message {
            Message::Text(text) => {
                let response = match serde_json::from_str::<IncomingFrame>(&text) {
                    Ok(IncomingFrame::Request { id, method, params }) => {
                        debug!(%peer, %id, %method, "request");
                        if method == method::CONNECT {
                            if connected {
                                OutgoingFrame::err(
                                    &id,
                                    ErrorShape {
                                        code: "INVALID_REQUEST".to_owned(),
                                        message: "connection already initialized".to_owned(),
                                        ..Default::default()
                                    },
                                )
                            } else {
                                match authenticate(&auth, &params) {
                                    Ok(()) => {
                                        let response =
                                            dispatcher.dispatch(&id, &method, params, &scopes).await;
                                        if matches!(
                                            &response,
                                            OutgoingFrame::Response { ok: true, .. }
                                        ) {
                                            connected = true;
                                            scopes = granted_scopes(&auth);
                                        }
                                        response
                                    }
                                    Err(reason) => OutgoingFrame::err(
                                        &id,
                                        ErrorShape {
                                            code: "FORBIDDEN".to_owned(),
                                            message: reason,
                                            details: Some(serde_json::json!({
                                                "code": "AUTH_REQUIRED"
                                            })),
                                            ..Default::default()
                                        },
                                    ),
                                }
                            }
                        } else if !connected {
                            OutgoingFrame::err(
                                &id,
                                ErrorShape {
                                    code: "FORBIDDEN".to_owned(),
                                    message: "successful authenticated connect required".to_owned(),
                                    details: Some(serde_json::json!({ "code": "AUTH_REQUIRED" })),
                                    ..Default::default()
                                },
                            )
                        } else {
                            dispatcher.dispatch(&id, &method, params, &scopes).await
                        }
                    }
                    Err(error) => {
                        warn!(%peer, %error, "invalid frame");
                        OutgoingFrame::err(
                            "unknown",
                            ErrorShape {
                                code: "INVALID_REQUEST".to_owned(),
                                message: error.to_string(),
                                details: Some(serde_json::json!({ "code": "INVALID_FRAME" })),
                                ..Default::default()
                            },
                        )
                    }
                };

                let json = serde_json::to_string(&response)?;
                if write.send(Message::Text(json.into())).await.is_err() {
                    break;
                }
            }
            Message::Ping(payload) => {
                if write.send(Message::Pong(payload)).await.is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            Message::Binary(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }

    registry.remove_connection();
    info!(%peer, "client disconnected");
    Ok(())
}

/// Check the presented credential against the configured policy.
///
/// Official `connect.params.auth` accepts `token`, `password`, `bootstrapToken`,
/// and `deviceToken`; token mode reads `token`, password mode reads `password`.
fn authenticate(auth: &GatewayAuth, params: &serde_json::Value) -> Result<(), String> {
    let parsed: ConnectParams = serde_json::from_value(params.clone())
        .map_err(|error| format!("invalid connect params: {error}"))?;
    let presented = parsed.auth.as_ref().and_then(|auth| auth.presented());
    if auth.permits(presented) {
        Ok(())
    } else {
        Err("authentication required".to_owned())
    }
}

/// Scopes granted to an authenticated connection.
///
/// A shared token is a full operator credential in the official model, so it
/// receives the complete operator scope set. Device/limited credentials will map
/// to narrower sets once device pairing exists.
fn granted_scopes(auth: &GatewayAuth) -> ConnectionScopes {
    match auth {
        GatewayAuth::None => ConnectionScopes::operator_full(),
        GatewayAuth::Token(_) => ConnectionScopes::operator_full(),
    }
}
