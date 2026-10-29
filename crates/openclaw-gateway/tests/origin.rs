//! WebSocket upgrades must reject cross-origin browser clients.
//!
//! WebSocket is not subject to CORS, so without an Origin check any web page can
//! open `ws://127.0.0.1:18789` and drive the control plane. Official reference:
//! `src/gateway/origin-check.ts` + `docs/gateway/security.md`. The Rust upgrade
//! accepted every request unconditionally.

use futures_util::{SinkExt, StreamExt};
use openclaw_config::GatewayConfig;
use openclaw_gateway::Gateway;
use serde_json::json;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

async fn start() -> (openclaw_gateway::GatewayHandle, String) {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let handle = Gateway::new(GatewayConfig {
        listen: addr.to_string(),
        require_auth: true,
        auth_token: Some("synthetic-origin-token".to_owned()),
        ..Default::default()
    })
    .run()
    .await
    .unwrap();
    (handle, format!("ws://{addr}"))
}

#[tokio::test]
async fn cross_origin_browser_upgrade_is_rejected() {
    let (handle, url) = start().await;
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "https://evil.example".parse().unwrap());

    let result = tokio_tungstenite::connect_async(request).await;
    handle.shutdown();
    assert!(
        result.is_err(),
        "a cross-origin page was allowed to open a Gateway WebSocket"
    );
}

#[tokio::test]
async fn loopback_origin_is_allowed() {
    let (handle, url) = start().await;
    let mut request = url.clone().into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", "http://127.0.0.1:18790".parse().unwrap());

    let result = tokio_tungstenite::connect_async(request).await;
    handle.shutdown();
    assert!(result.is_ok(), "same-host Control UI origin must be allowed: {result:?}");
}

#[tokio::test]
async fn native_clients_without_an_origin_header_still_connect() {
    let (handle, url) = start().await;
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    client
        .send(Message::Text(
            json!({"type":"req","id":"1","method":"connect","params":{"protocol":4,"auth":{"token":"synthetic-origin-token"}}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let reply = timeout(Duration::from_secs(2), async {
        loop {
            if let Some(Ok(Message::Text(text))) = client.next().await {
                let value: serde_json::Value = serde_json::from_str(&text).unwrap();
                // The server sends `connect.challenge` first; skip events.
                if value["type"] == "res" {
                    return value;
                }
            }
        }
    })
    .await
    .expect("gateway must answer");
    handle.shutdown();
    assert_eq!(reply["ok"], true, "native client was rejected: {reply}");
}
