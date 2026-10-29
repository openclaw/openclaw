//! Response shapes must match the documented RPC contracts.
//!
//! Official references:
//!   `docs/gateway/protocol/rpc-session-control.md:117` — "`sessions.get` returns
//!     `{ messages }` ... Use `sessions.describe` for session metadata"
//!   `docs/gateway/protocol/rpc-session-control.md:86` — `sessions.list` rows carry
//!     `key` plus `updatedAt`
//!   `docs/gateway/configuration/config-rpc.md` — `config.get` returns the live
//!     snapshot plus `hash`/`configRevisionHash`
//!
//! The Rust dispatcher returned session metadata from `sessions.get` and `{}` from
//! `config.get`, so an official client rendered blanks.

use futures_util::{SinkExt, StreamExt};
use openclaw_config::GatewayConfig;
use openclaw_gateway::Gateway;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;

async fn connected() -> (openclaw_gateway::GatewayHandle, tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let handle = Gateway::new(GatewayConfig {
        listen: addr.to_string(),
        require_auth: true,
        auth_token: Some("synthetic-shape-token".to_owned()),
        ..Default::default()
    })
    .run()
    .await
    .unwrap();
    let (mut client, _) = tokio_tungstenite::connect_async(format!("ws://{addr}"))
        .await
        .unwrap();
    // Consume connect.challenge.
    let _ = timeout(Duration::from_secs(2), client.next()).await;
    client
        .send(Message::Text(
            json!({"type":"req","id":"c","method":"connect","params":{"minProtocol":4,"maxProtocol":4,"auth":{"token":"synthetic-shape-token"}}})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    let _ = next_response(&mut client).await;
    (handle, client)
}

async fn next_response(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> Value {
    timeout(Duration::from_secs(3), async {
        loop {
            match client.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["type"] == "res" {
                        return value;
                    }
                }
                Some(Ok(_)) => continue,
                _ => panic!("socket closed"),
            }
        }
    })
    .await
    .expect("response within deadline")
}

async fn rpc(
    client: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    method: &str,
    params: Value,
) -> Value {
    client
        .send(Message::Text(
            json!({"type":"req","id":"r","method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    next_response(client).await
}

#[tokio::test]
async fn sessions_get_returns_messages_not_metadata() {
    let (handle, mut client) = connected().await;
    let created = rpc(
        &mut client,
        "sessions.create",
        json!({"channel":"webchat","kind":"direct","participants":["operator"]}),
    )
    .await;
    assert_eq!(created["ok"], true, "{created}");
    let id = created["payload"]["id"].as_str().unwrap().to_owned();

    let got = rpc(&mut client, "sessions.get", json!({"id": id})).await;
    handle.shutdown();

    assert_eq!(got["ok"], true, "{got}");
    assert!(
        got["payload"]["messages"].is_array(),
        "sessions.get must return {{ messages }}: {got}"
    );
    assert!(
        got["payload"].get("kind").is_none(),
        "sessions.get must not return session metadata: {got}"
    );
}

#[tokio::test]
async fn sessions_list_rows_carry_key_and_updated_at() {
    let (handle, mut client) = connected().await;
    let _ = rpc(
        &mut client,
        "sessions.create",
        json!({"channel":"webchat","kind":"direct","participants":[]}),
    )
    .await;
    let listed = rpc(&mut client, "sessions.list", json!({})).await;
    handle.shutdown();

    let rows = listed["payload"]["sessions"].as_array().expect("sessions array");
    assert_eq!(rows.len(), 1, "{listed}");
    let row = &rows[0];
    assert!(
        row["key"].as_str().is_some_and(|k| !k.is_empty()),
        "row must expose `key`: {row}"
    );
    assert!(
        row["updatedAt"].as_u64().is_some() || row["updatedAt"].as_str().is_some(),
        "row must expose `updatedAt`: {row}"
    );
}

#[tokio::test]
async fn config_get_returns_the_live_configuration_and_hash() {
    let (handle, mut client) = connected().await;
    let got = rpc(&mut client, "config.get", json!({})).await;
    handle.shutdown();

    assert_eq!(got["ok"], true, "{got}");
    let payload = &got["payload"];
    assert!(
        payload.get("config").is_some() || payload.get("gateway").is_some(),
        "config.get must return the live config, not an empty object: {got}"
    );
    assert!(
        payload.get("hash").is_some(),
        "config.get must return a `hash` for write conflict guards: {got}"
    );
    assert!(
        payload.get("configRevisionHash").is_some(),
        "config.get must return `configRevisionHash`: {got}"
    );
}

#[tokio::test]
async fn sessions_describe_returns_metadata() {
    let (handle, mut client) = connected().await;
    let created = rpc(
        &mut client,
        "sessions.create",
        json!({"channel":"webchat","kind":"group","participants":["a","b"]}),
    )
    .await;
    let id = created["payload"]["id"].as_str().unwrap().to_owned();
    let described = rpc(&mut client, "sessions.describe", json!({"id": id})).await;
    handle.shutdown();

    assert_eq!(described["ok"], true, "{described}");
    assert!(
        described["payload"]["kind"].as_str().is_some(),
        "sessions.describe must return metadata: {described}"
    );
}
