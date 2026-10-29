//! The Gateway must push `tick` and `shutdown` events.
//!
//! Official reference: `docs/gateway/index.md` — `tick`, `presence`, `heartbeat`,
//! `sessions.changed`, and a `shutdown` event before close;
//! `packages/gateway-protocol/src/schema/frames.ts` defines `TickEventSchema`
//! (`ts`) and `ShutdownEventSchema` (`reason`, optional `restartExpectedMs`).
//! The Rust Gateway never constructed an event, so the Control UI's
//! inbound-silence watchdog never saw a tick and clients hung on stop.

use futures_util::StreamExt;
use openclaw_config::GatewayConfig;
use openclaw_gateway::Gateway;
use serde_json::Value;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message;

async fn start(tick_ms: u64) -> (openclaw_gateway::GatewayHandle, String) {
    let reservation = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = reservation.local_addr().unwrap();
    drop(reservation);
    let handle = Gateway::new(GatewayConfig {
        listen: addr.to_string(),
        require_auth: false,
        auth_token: None,
        ping_interval_secs: tick_ms,
        ..Default::default()
    })
    .run()
    .await
    .unwrap();
    (handle, format!("ws://{addr}"))
}

#[tokio::test]
async fn tick_events_are_pushed_on_the_configured_interval() {
    // ping_interval_secs is 1s here, so a tick must arrive within a few seconds.
    let (handle, url) = start(1).await;
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();

    let tick = timeout(Duration::from_secs(6), async {
        loop {
            match client.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["event"] == "tick" {
                        return value;
                    }
                }
                Some(Ok(_)) => continue,
                _ => panic!("socket closed before a tick arrived"),
            }
        }
    })
    .await
    .expect("Gateway must emit a tick within the interval");
    handle.shutdown();

    assert_eq!(tick["type"], "event", "{tick}");
    assert!(
        tick["payload"]["ts"].as_u64().is_some(),
        "tick payload needs a non-negative integer ts: {tick}"
    );
}

#[tokio::test]
async fn shutdown_event_is_sent_before_the_socket_closes() {
    let (handle, url) = start(1).await;
    let (mut client, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    // Consume the challenge so the stream is positioned after it.
    let _ = timeout(Duration::from_secs(2), client.next()).await;

    handle.shutdown();

    let shutdown = timeout(Duration::from_secs(6), async {
        loop {
            match client.next().await {
                Some(Ok(Message::Text(text))) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if value["event"] == "shutdown" {
                        return value;
                    }
                }
                Some(Ok(_)) => continue,
                _ => return Value::Null,
            }
        }
    })
    .await
    .expect("a shutdown event must arrive before the socket closes");

    assert_ne!(shutdown, Value::Null, "socket closed without a shutdown event");
    assert!(
        shutdown["payload"]["reason"]
            .as_str()
            .is_some_and(|r| !r.is_empty()),
        "shutdown payload needs a non-empty reason: {shutdown}"
    );
}
