use futures_util::{SinkExt, StreamExt};
use openclaw_config::GatewayConfig;
use openclaw_gateway::{Gateway, GatewayHandle};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

const TOKEN: &str = "synthetic-gateway-token";

async fn start() -> (GatewayHandle, String) {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let handle = Gateway::new(GatewayConfig {
        listen: addr.to_string(),
        require_auth: true,
        auth_token: Some(TOKEN.to_owned()),
        ..Default::default()
    })
    .run()
    .await
    .unwrap();
    (handle, format!("ws://{addr}"))
}

/// Send one request and return the first response frame, skipping the
/// `connect.challenge` event the Gateway sends on accept.
async fn rpc(client: &mut Client, method: &str, params: Value) -> Value {
    client
        .send(Message::Text(
            json!({"type":"req","id":"test","method":method,"params":params})
                .to_string()
                .into(),
        ))
        .await
        .unwrap();
    timeout(Duration::from_secs(2), async {
        loop {
            let frame = client.next().await.unwrap().unwrap();
            if let Message::Text(text) = frame {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["type"] == "res" {
                    return value;
                }
            }
        }
    })
    .await
    .expect("Gateway must answer within test deadline")
}

/// Connect with the deprecated scalar `protocol` form (still accepted).
fn connect_params(token: Option<&str>) -> Value {
    match token {
        Some(token) => json!({"protocol": 4, "auth": {"token": token}}),
        None => json!({"protocol": 4}),
    }
}

#[tokio::test]
async fn websocket_requires_successful_authenticated_connect_before_dispatch() {
    let (handle, url) = start().await;

    // Before connect, every method is refused.
    for method in ["sessions.list", "sessions.create", "config.get"] {
        let (mut client, _) = connect_async(&url).await.unwrap();
        let response = rpc(&mut client, method, json!({})).await;
        assert_eq!(response["ok"], false, "unauthenticated {method} reached dispatcher");
        assert_eq!(
            response["error"]["details"]["code"], "AUTH_REQUIRED",
            "expected AUTH_REQUIRED detail: {response}"
        );
    }

    // Wrong, missing, or malformed credentials are refused.
    for auth in [json!(null), json!({"token": "wrong"}), json!({"token": 42})] {
        let (mut client, _) = connect_async(&url).await.unwrap();
        let response = rpc(&mut client, "connect", json!({"protocol": 4, "auth": auth})).await;
        assert_eq!(response["ok"], false, "invalid credential accepted: {response}");
        assert_eq!(response["error"]["code"], "FORBIDDEN", "{response}");
    }

    // A protocol below the server floor is refused, and grants nothing.
    let (mut client, _) = connect_async(&url).await.unwrap();
    assert_eq!(
        rpc(&mut client, "connect", json!({"protocol": 0, "auth": {"token": TOKEN}})).await["ok"],
        false
    );
    assert_eq!(
        rpc(&mut client, "sessions.list", json!({})).await["ok"],
        false,
        "failed protocol negotiation granted access"
    );

    // Correct credential succeeds, then methods work.
    let (mut client, _) = connect_async(&url).await.unwrap();
    assert_eq!(
        rpc(&mut client, "connect", connect_params(Some(TOKEN))).await["ok"],
        true
    );
    let listed = rpc(&mut client, "sessions.list", json!({})).await;
    assert_eq!(listed["ok"], true, "{listed}");
    assert_eq!(
        listed["payload"]["sessions"],
        json!([]),
        "rejected create mutated registry"
    );

    // A second connect on the same connection is refused.
    let again = rpc(&mut client, "connect", connect_params(Some(TOKEN))).await;
    assert_eq!(again["ok"], false, "duplicate connect accepted: {again}");
    handle.shutdown();
}

#[tokio::test]
async fn message_send_cannot_acknowledge_delivery_without_a_transport() {
    let (handle, url) = start().await;
    let (mut client, _) = connect_async(&url).await.unwrap();
    assert_eq!(
        rpc(&mut client, "connect", connect_params(Some(TOKEN))).await["ok"],
        true
    );
    let response = rpc(
        &mut client,
        "message.send",
        json!({"channel":"telegram","session":"synthetic","content":{"text":"hello"}}),
    )
    .await;
    assert_eq!(
        response["ok"], false,
        "no delivery happened; must not return accepted=true"
    );
    assert_eq!(response["error"]["code"], "UNAVAILABLE");
    handle.shutdown();
}

#[tokio::test]
async fn gateway_refuses_required_auth_without_a_secret() {
    let result = Gateway::new(GatewayConfig {
        listen: "127.0.0.1:0".to_owned(),
        require_auth: true,
        auth_token: None,
        ..Default::default()
    })
    .run()
    .await;
    if let Ok(handle) = &result {
        handle.shutdown();
    }
    assert!(result.is_err(), "missing credentials must fail before binding");
}
