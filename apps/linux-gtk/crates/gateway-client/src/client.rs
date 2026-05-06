use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};

use crate::config::GatewayConfig;
use crate::identity::DeviceIdentity;
use crate::protocol::*;

type PendingMap = HashMap<String, oneshot::Sender<Result<ResponseFrame, ClientError>>>;

#[derive(Error, Debug)]
pub enum ClientError {
    #[error("not connected")]
    NotConnected,
    #[error("request timed out")]
    Timeout,
    #[error("gateway error: {0}")]
    Gateway(String),
    #[error("websocket error: {0}")]
    WebSocket(String),
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("send failed: channel closed")]
    SendFailed,
}

/// Events broadcast to the UI layer.
#[derive(Debug, Clone)]
pub enum GatewayEvent {
    Connected(Box<HelloOk>),
    Disconnected(String),
    Event(EventFrame),
}

/// Command sent from the UI thread to the WebSocket task.
enum WsCommand {
    Send(String),
    Request {
        frame: String,
        id: String,
        reply: oneshot::Sender<Result<ResponseFrame, ClientError>>,
    },
    /// Remove a timed-out request from the pending map so it doesn't
    /// leak memory on long-lived degraded connections.
    Cancel(String),
}

pub struct GatewayClient {
    cmd_tx: mpsc::Sender<WsCommand>,
    event_tx: broadcast::Sender<GatewayEvent>,
    _task: tokio::task::JoinHandle<()>,
}

impl GatewayClient {
    /// Create a new client and start the connection loop.
    pub fn connect(
        config: GatewayConfig,
        identity: DeviceIdentity,
        instance_id: String,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<WsCommand>(256);
        let (event_tx, _) = broadcast::channel::<GatewayEvent>(512);
        let event_tx2 = event_tx.clone();

        let task = tokio::spawn(async move {
            connection_loop(config, identity, instance_id, cmd_rx, event_tx2).await;
        });

        Self {
            cmd_tx,
            event_tx,
            _task: task,
        }
    }

    /// Subscribe to gateway events (connected, disconnected, protocol events).
    pub fn subscribe(&self) -> broadcast::Receiver<GatewayEvent> {
        self.event_tx.subscribe()
    }

    /// Send an RPC request and wait for the response.
    pub async fn request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, ClientError> {
        self.request_with_timeout(method, params, Duration::from_secs(30)).await
    }

    /// Send an RPC request with a custom timeout.
    ///
    /// The timeout uses a background OS thread + oneshot channel so it
    /// works regardless of whether the caller is on a tokio runtime or
    /// the GLib main loop (`glib::spawn_future_local`). On timeout, a
    /// `Cancel` command removes the dead sender from the pending map.
    pub async fn request_with_timeout(
        &self,
        method: &str,
        params: serde_json::Value,
        timeout: Duration,
    ) -> Result<serde_json::Value, ClientError> {
        let id = uuid::Uuid::new_v4().to_string();
        let frame = RequestFrame::new(id.clone(), method, params);
        let json = serde_json::to_string(&frame)?;

        let (reply_tx, reply_rx) = oneshot::channel();

        self.cmd_tx
            .try_send(WsCommand::Request {
                frame: json,
                id: id.clone(),
                reply: reply_tx,
            })
            .map_err(|_| ClientError::SendFailed)?;

        // Use a oneshot + background thread for the timeout so we don't
        // require an entered tokio runtime on the polling thread. This
        // matters because callers include `glib::spawn_future_local`
        // which runs on the GLib main loop, not a tokio executor.
        let (timeout_tx, timeout_rx) = oneshot::channel::<()>();
        std::thread::Builder::new()
            .name("rpc-timeout".into())
            .spawn(move || {
                std::thread::sleep(timeout);
                let _ = timeout_tx.send(());
            })
            .map_err(|_| ClientError::SendFailed)?;

        use futures_util::future::Either;
        let mut reply_fut = Box::pin(reply_rx);
        let mut timeout_fut = Box::pin(timeout_rx);
        let result = futures_util::future::select(
            reply_fut.as_mut(),
            timeout_fut.as_mut(),
        )
        .await;

        match result {
            Either::Left((reply_result, _)) => {
                let result = reply_result.map_err(|_| ClientError::SendFailed)?;
                match result {
                    Ok(resp) if resp.ok => Ok(resp.payload),
                    Ok(resp) => {
                        let msg = resp
                            .error
                            .as_ref()
                            .map(|e| e.message.clone())
                            .unwrap_or_else(|| "unknown error".into());
                        Err(ClientError::Gateway(msg))
                    }
                    Err(e) => Err(e),
                }
            }
            Either::Right(_) => {
                let _ = self.cmd_tx.try_send(WsCommand::Cancel(id));
                Err(ClientError::Timeout)
            }
        }
    }

    /// Send a fire-and-forget message (no response tracking).
    pub fn send_raw(&self, json: String) -> Result<(), ClientError> {
        self.cmd_tx
            .try_send(WsCommand::Send(json))
            .map_err(|_| ClientError::SendFailed)
    }
}

/// Main connection loop with auto-reconnect.
async fn connection_loop(
    config: GatewayConfig,
    identity: DeviceIdentity,
    instance_id: String,
    mut cmd_rx: mpsc::Receiver<WsCommand>,
    event_tx: broadcast::Sender<GatewayEvent>,
) {
    let mut backoff_ms: u64 = 800;
    let mut cached_token: Option<String> = config.token.clone();

    loop {
        info!("connecting to gateway at {}", config.url);

        match try_connect(
            &config,
            &identity,
            &instance_id,
            cached_token.as_deref(),
            &mut cmd_rx,
            &event_tx,
        )
        .await
        {
            Ok(token) => {
                // Connection succeeded and then closed cleanly or errored
                if let Some(t) = token {
                    cached_token = Some(t);
                }
                backoff_ms = 800; // reset backoff on successful connection
                let _ = event_tx.send(GatewayEvent::Disconnected("connection closed".into()));
            }
            Err(e) => {
                warn!("connection failed: {e}");
                let _ = event_tx.send(GatewayEvent::Disconnected(e.to_string()));
            }
        }

        info!("reconnecting in {backoff_ms}ms");
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms as f64 * 1.7) as u64;
        if backoff_ms > 15_000 {
            backoff_ms = 15_000;
        }
    }
}

/// Attempt a single WebSocket session. Returns the device token if received.
async fn try_connect(
    config: &GatewayConfig,
    identity: &DeviceIdentity,
    instance_id: &str,
    token: Option<&str>,
    cmd_rx: &mut mpsc::Receiver<WsCommand>,
    event_tx: &broadcast::Sender<GatewayEvent>,
) -> Result<Option<String>, ClientError> {
    let url = url::Url::parse(&config.url)
        .map_err(|e| ClientError::WebSocket(format!("invalid URL: {e}")))?;

    let (ws_stream, _) = if config.tls_accept_invalid && url.scheme() == "wss" {
        // Build a rustls connector that accepts any certificate
        // Accept any certificate for local development
        let tls_config = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(std::sync::Arc::new(NoVerifier))
            .with_no_client_auth();
        let connector = tokio_tungstenite::Connector::Rustls(std::sync::Arc::new(tls_config));
        tokio_tungstenite::connect_async_tls_with_config(
            url.as_str(),
            None,
            false,
            Some(connector),
        )
        .await
        .map_err(|e| ClientError::WebSocket(e.to_string()))?
    } else {
        tokio_tungstenite::connect_async(url.as_str())
            .await
            .map_err(|e| ClientError::WebSocket(e.to_string()))?
    };

    let (mut ws_write, mut ws_read) = ws_stream.split();

    // Step 1: Wait for connect.challenge event
    let challenge = loop {
        match ws_read.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Ok(InboundFrame::Event(evt)) = serde_json::from_str::<InboundFrame>(&text)
                    && evt.event == "connect.challenge"
                {
                    let payload: ChallengePayload =
                        serde_json::from_value(evt.payload)
                            .map_err(ClientError::Serde)?;
                    break payload;
                }
            }
            Some(Ok(Message::Ping(data))) => {
                let _ = ws_write.send(Message::Pong(data)).await;
            }
            Some(Err(e)) => return Err(ClientError::WebSocket(e.to_string())),
            None => return Err(ClientError::WebSocket("connection closed during handshake".into())),
            _ => {}
        }
    };

    debug!("received challenge nonce={}", challenge.nonce);

    // Step 2: Build and send connect request
    let signed_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;

    let auth_payload = identity.build_auth_payload(
        CLIENT_ID,
        CLIENT_MODE,
        CLIENT_ROLE,
        CLIENT_SCOPES,
        signed_at_ms,
        token.unwrap_or(""),
        &challenge.nonce,
    );
    let signature = identity.sign(&auth_payload);

    let connect_id = uuid::Uuid::new_v4().to_string();
    let connect_params = ConnectParams {
        min_protocol: PROTOCOL_VERSION,
        max_protocol: PROTOCOL_VERSION,
        client: ClientInfo {
            id: CLIENT_ID.to_string(),
            display_name: "OpenClaw Linux".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            platform: "linux".to_string(),
            mode: CLIENT_MODE.to_string(),
            instance_id: instance_id.to_string(),
        },
        role: CLIENT_ROLE.to_string(),
        scopes: CLIENT_SCOPES.iter().map(|s| s.to_string()).collect(),
        device: DeviceAuth {
            id: identity.device_id().to_string(),
            public_key: identity.public_key_b64(),
            signature,
            signed_at: signed_at_ms,
            nonce: challenge.nonce,
        },
        auth: token.map(|t| AuthToken {
            token: t.to_string(),
        }),
        locale: "en-US".to_string(),
    };

    let connect_frame = RequestFrame::new(
        connect_id.clone(),
        "connect",
        serde_json::to_value(&connect_params).map_err(ClientError::Serde)?,
    );
    let connect_json = serde_json::to_string(&connect_frame).map_err(ClientError::Serde)?;
    ws_write
        .send(Message::Text(connect_json.into()))
        .await
        .map_err(|e| ClientError::WebSocket(e.to_string()))?;

    // Step 3: Wait for connect response
    let hello_ok: HelloOk = loop {
        match ws_read.next().await {
            Some(Ok(Message::Text(text))) => {
                if let Ok(frame) = serde_json::from_str::<InboundFrame>(&text) {
                    match frame {
                        InboundFrame::Response(resp) if resp.id == connect_id => {
                            if resp.ok {
                                let hello: HelloOk =
                                    serde_json::from_value(resp.payload)
                                        .map_err(ClientError::Serde)?;
                                break hello;
                            } else {
                                let msg = resp
                                    .error
                                    .map(|e| e.message)
                                    .unwrap_or_else(|| "connect rejected".into());
                                return Err(ClientError::Gateway(msg));
                            }
                        }
                        _ => {} // ignore other frames during handshake
                    }
                }
            }
            Some(Ok(Message::Ping(data))) => {
                let _ = ws_write.send(Message::Pong(data)).await;
            }
            Some(Err(e)) => return Err(ClientError::WebSocket(e.to_string())),
            None => {
                return Err(ClientError::WebSocket(
                    "connection closed during auth".into(),
                ))
            }
            _ => {}
        }
    };

    let device_token = hello_ok.auth.as_ref().and_then(|a| a.device_token.clone());
    info!(
        "connected to gateway v{} (protocol {})",
        hello_ok.server.version, hello_ok.protocol
    );

    let _ = event_tx.send(GatewayEvent::Connected(Box::new(hello_ok)));

    // Step 4: Main message loop
    let pending: Arc<Mutex<PendingMap>> = Arc::new(Mutex::new(HashMap::new()));

    loop {
        tokio::select! {
            // Incoming WebSocket messages
            msg = ws_read.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<InboundFrame>(&text) {
                            Ok(InboundFrame::Response(resp)) => {
                                let mut map = pending.lock().await;
                                if let Some(tx) = map.remove(&resp.id) {
                                    let _ = tx.send(Ok(resp));
                                }
                            }
                            Ok(InboundFrame::Event(evt)) => {
                                let _ = event_tx.send(GatewayEvent::Event(evt));
                            }
                            Err(e) => {
                                debug!("failed to parse inbound frame: {e}");
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        let _ = ws_write.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        info!("websocket closed");
                        break;
                    }
                    Some(Err(e)) => {
                        error!("websocket error: {e}");
                        break;
                    }
                    _ => {}
                }
            }

            // Outbound commands from UI
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(WsCommand::Send(json)) => {
                        if let Err(e) = ws_write.send(Message::Text(json.into())).await {
                            error!("failed to send: {e}");
                            break;
                        }
                    }
                    Some(WsCommand::Request { frame, id, reply }) => {
                        // Skip stale requests whose caller already timed out
                        // and dropped the receiver. This prevents replaying
                        // mutating RPCs (chat.send, sessions.patch) after
                        // reconnect when the user already saw a timeout.
                        if reply.is_closed() {
                            debug!("skipping stale request {id} (caller timed out)");
                        } else if let Err(e) = ws_write.send(Message::Text(frame.into())).await {
                            let _ = reply.send(Err(ClientError::WebSocket(e.to_string())));
                        } else {
                            pending.lock().await.insert(id, reply);
                        }
                    }
                    Some(WsCommand::Cancel(id)) => {
                        pending.lock().await.remove(&id);
                    }
                    None => {
                        info!("command channel closed, shutting down");
                        break;
                    }
                }
            }
        }
    }

    // Cancel any pending requests
    let mut map = pending.lock().await;
    for (_, tx) in map.drain() {
        let _ = tx.send(Err(ClientError::NotConnected));
    }

    Ok(device_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_command_variant_holds_request_id() {
        let id = "req-abc-123".to_string();
        let cmd = WsCommand::Cancel(id.clone());
        match cmd {
            WsCommand::Cancel(cancel_id) => assert_eq!(cancel_id, "req-abc-123"),
            _ => panic!("expected Cancel variant"),
        }
    }

    #[test]
    fn client_error_display_messages() {
        let err = ClientError::NotConnected;
        assert_eq!(err.to_string(), "not connected");

        let err = ClientError::Timeout;
        assert_eq!(err.to_string(), "request timed out");

        let err = ClientError::Gateway("bad request".into());
        assert_eq!(err.to_string(), "gateway error: bad request");

        let err = ClientError::SendFailed;
        assert_eq!(err.to_string(), "send failed: channel closed");
    }

    #[test]
    fn ws_command_send_variant() {
        let cmd = WsCommand::Send(r#"{"type":"req","id":"1"}"#.to_string());
        match cmd {
            WsCommand::Send(json) => assert!(json.contains("req")),
            _ => panic!("expected Send variant"),
        }
    }

    #[test]
    fn ws_command_request_variant() {
        let (tx, _rx) = oneshot::channel();
        let cmd = WsCommand::Request {
            frame: r#"{"type":"req"}"#.to_string(),
            id: "r1".to_string(),
            reply: tx,
        };
        match cmd {
            WsCommand::Request { id, frame, .. } => {
                assert_eq!(id, "r1");
                assert!(frame.contains("req"));
            }
            _ => panic!("expected Request variant"),
        }
    }
}

/// TLS certificate verifier that accepts any certificate (for local dev with self-signed certs).
#[derive(Debug)]
struct NoVerifier;

impl rustls::client::danger::ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        vec![
            rustls::SignatureScheme::RSA_PKCS1_SHA256,
            rustls::SignatureScheme::RSA_PKCS1_SHA384,
            rustls::SignatureScheme::RSA_PKCS1_SHA512,
            rustls::SignatureScheme::ECDSA_NISTP256_SHA256,
            rustls::SignatureScheme::ECDSA_NISTP384_SHA384,
            rustls::SignatureScheme::ECDSA_NISTP521_SHA512,
            rustls::SignatureScheme::ED25519,
            rustls::SignatureScheme::RSA_PSS_SHA256,
            rustls::SignatureScheme::RSA_PSS_SHA384,
            rustls::SignatureScheme::RSA_PSS_SHA512,
        ]
    }
}
