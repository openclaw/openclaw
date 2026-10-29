//! Gateway handshake must match the official protocol.
//!
//! Official references (pinned checkout):
//!   `packages/gateway-protocol/src/version.ts` — PROTOCOL_VERSION = 4,
//!     MIN_CLIENT_PROTOCOL_VERSION = 4
//!   `packages/gateway-protocol/src/schema/frames.ts` — ConnectParamsSchema,
//!     HelloOkSchema
//!   `packages/gateway-protocol/src/schema/snapshot.ts` — SnapshotSchema
//!   `docs/gateway/protocol/handshake.md` — connect.challenge, hello-ok shape
//!
//! The Rust build used a scalar `protocol: 1` field, never sent a challenge, and
//! returned a `hello-ok` with only `type`/`protocol`/`serverVersion`, so an
//! official client could not connect at all.

use futures_util::{SinkExt, StreamExt};
use openclaw_config::GatewayConfig;
use openclaw_gateway::Gateway;
use serde_json::{json, Value};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;

async fn start() -> (openclaw_gateway::GatewayHandle, String) {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let handle = Gateway::new(GatewayConfig {
        listen: addr.to_string(),
        require_auth: true,
        auth_token: Some("synthetic-handshake-token".to_owned()),
        ..Default::default()
    })
    .run()
    .await
    .unwrap();
    (handle, format!("ws://{addr}"))
}

type Client = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Read the next frame of any kind (used for the unsolicited challenge).
async fn next_frame(client: &mut Client) -> Value {
    timeout(Duration::from_secs(3), async {
        loop {
            match client.next().await {
                Some(Ok(Message::Text(text))) => {
                    return serde_json::from_str(&text).expect("frame is JSON");
                }
                Some(Ok(_)) => continue,
                Some(Err(error)) => panic!("socket error: {error}"),
                None => panic!("socket closed before a frame arrived"),
            }
        }
    })
    .await
    .expect("Gateway must send a frame within the deadline")
}

/// Read the next response frame, skipping server-pushed events such as `tick`.
async fn next_response(client: &mut Client) -> Value {
    timeout(Duration::from_secs(3), async {
        loop {
            match client.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).expect("frame is JSON");
                    if value["type"] == "res" {
                        return value;
                    }
                }
                Some(Ok(_)) => continue,
                Some(Err(error)) => panic!("socket error: {error}"),
                None => panic!("socket closed before a response arrived"),
            }
        }
    })
    .await
    .expect("Gateway must answer within the deadline")
}

async fn send(client: &mut Client, value: Value) {
    client
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

/// The documented connect frame, copied from docs/gateway/protocol/handshake.md.
fn official_connect(token: &str) -> Value {
    json!({
        "type": "req",
        "id": "handshake-1",
        "method": "connect",
        "params": {
            "minProtocol": 4,
            "maxProtocol": 4,
            "client": {
                "id": "cli",
                "version": "1.2.3",
                "platform": "linux",
                "mode": "operator"
            },
            "role": "operator",
            "scopes": ["operator.read", "operator.write"],
            "caps": [],
            "commands": [],
            "permissions": {},
            "auth": { "token": token },
            "locale": "en-US",
            "userAgent": "openclaw-cli/1.2.3"
        }
    })
}

#[tokio::test]
async fn server_sends_connect_challenge_before_any_client_frame() {
    let (handle, url) = start().await;
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    // No client frame has been sent yet: the challenge must arrive unsolicited.
    let frame = next_frame(&mut client).await;
    handle.shutdown();

    assert_eq!(frame["type"], "event", "expected an event frame: {frame}");
    assert_eq!(
        frame["event"], "connect.challenge",
        "server must send connect.challenge first: {frame}"
    );
    assert!(
        frame["payload"]["nonce"].as_str().is_some_and(|n| !n.is_empty()),
        "challenge needs a non-empty nonce: {frame}"
    );
    assert!(
        frame["payload"]["ts"].as_u64().is_some(),
        "challenge needs a non-negative integer ts: {frame}"
    );
}

#[tokio::test]
async fn official_connect_frame_is_accepted_and_hello_ok_is_complete() {
    let (handle, url) = start().await;
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let _challenge = next_frame(&mut client).await;

    send(&mut client, official_connect("synthetic-handshake-token")).await;
    let frame = next_response(&mut client).await;
    handle.shutdown();

    assert_eq!(frame["type"], "res", "{frame}");
    assert_eq!(frame["ok"], true, "official connect frame rejected: {frame}");
    let hello = &frame["payload"];

    // HelloOkSchema required fields.
    assert_eq!(hello["type"], "hello-ok", "{hello}");
    assert_eq!(hello["protocol"], 4, "must advertise protocol 4: {hello}");

    assert!(
        hello["server"]["version"].as_str().is_some_and(|v| !v.is_empty()),
        "hello.server.version required: {hello}"
    );
    assert!(
        hello["server"]["connId"].as_str().is_some_and(|v| !v.is_empty()),
        "hello.server.connId required: {hello}"
    );
    assert!(
        hello["features"]["methods"].is_array(),
        "hello.features.methods required: {hello}"
    );
    assert!(
        hello["features"]["events"].is_array(),
        "hello.features.events required: {hello}"
    );
    assert!(
        !hello["features"]["methods"]
            .as_array()
            .unwrap()
            .is_empty(),
        "advertised method list must not be empty: {hello}"
    );

    // SnapshotSchema required fields.
    assert!(hello["snapshot"]["presence"].is_array(), "{hello}");
    assert!(hello["snapshot"]["health"].is_object(), "{hello}");
    assert!(
        hello["snapshot"]["stateVersion"]["presence"].as_u64().is_some(),
        "{hello}"
    );
    assert!(
        hello["snapshot"]["stateVersion"]["health"].as_u64().is_some(),
        "{hello}"
    );
    assert!(hello["snapshot"]["uptimeMs"].as_u64().is_some(), "{hello}");

    // auth + policy blocks.
    assert_eq!(hello["auth"]["role"], "operator", "{hello}");
    assert!(
        hello["auth"]["scopes"].is_array(),
        "hello.auth.scopes required: {hello}"
    );
    assert!(hello["policy"]["maxPayload"].as_u64().is_some(), "{hello}");
    assert!(
        hello["policy"]["maxBufferedBytes"].as_u64().is_some(),
        "{hello}"
    );
    assert!(
        hello["policy"]["tickIntervalMs"].as_u64().is_some(),
        "{hello}"
    );
}

#[tokio::test]
async fn incompatible_protocol_range_is_rejected_with_details() {
    let (handle, url) = start().await;
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let _challenge = next_frame(&mut client).await;

    let mut frame = official_connect("synthetic-handshake-token");
    // A client that only speaks protocol 1..2 cannot overlap with server 4.
    frame["params"]["minProtocol"] = json!(1);
    frame["params"]["maxProtocol"] = json!(2);
    send(&mut client, frame).await;
    let reply = next_response(&mut client).await;
    handle.shutdown();

    assert_eq!(reply["ok"], false, "protocol 1..2 must be refused: {reply}");
    assert_eq!(
        reply["error"]["code"], "PROTOCOL_MISMATCH",
        "expected PROTOCOL_MISMATCH: {reply}"
    );
    assert!(
        reply["error"]["details"].is_object(),
        "mismatch must carry details: {reply}"
    );
}

#[tokio::test]
async fn legacy_scalar_protocol_is_still_accepted_for_one_release() {
    let (handle, url) = start().await;
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let _challenge = next_frame(&mut client).await;

    send(
        &mut client,
        json!({
            "type": "req",
            "id": "legacy",
            "method": "connect",
            "params": {"protocol": 4, "auth": {"token": "synthetic-handshake-token"}}
        }),
    )
    .await;
    let reply = next_response(&mut client).await;
    handle.shutdown();

    assert_eq!(
        reply["ok"], true,
        "the deprecated scalar `protocol` must keep working: {reply}"
    );
}

#[tokio::test]
async fn password_auth_is_accepted_in_password_mode() {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let handle = Gateway::new(GatewayConfig {
        listen: addr.to_string(),
        require_auth: true,
        auth_mode: "password".to_owned(),
        auth_password: Some("synthetic-password".to_owned()),
        ..Default::default()
    })
    .run()
    .await
    .unwrap();
    let url = format!("ws://{addr}");
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let _challenge = next_frame(&mut client).await;

    // Documented: mode=password uses connect.params.auth.password.
    let mut frame = official_connect("");
    frame["params"]["auth"] = json!({ "password": "synthetic-password" });
    send(&mut client, frame).await;
    let reply = next_response(&mut client).await;
    handle.shutdown();

    assert_eq!(
        reply["ok"], true,
        "auth.password must authenticate in password mode: {reply}"
    );
}
