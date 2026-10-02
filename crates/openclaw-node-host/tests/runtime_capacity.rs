use futures_util::{SinkExt, StreamExt};
use openclaw_gateway_client::GatewayClientConfig;
use openclaw_node_host::{CommandRuntime, NodeClient};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

async fn send(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    frame: Value,
) {
    socket
        .send(Message::Text(frame.to_string().into()))
        .await
        .unwrap();
}
async fn receive(socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Value {
    let frame = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    serde_json::from_str(&frame.into_text().unwrap()).unwrap()
}
fn invoke(id: &str, command: &str) -> Value {
    json!({"type":"event","event":"node.invoke.request","payload":{
        "id":id,"nodeId":"node-fixture","command":command,"timeoutMs":10000}})
}

async fn acknowledge(
    socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    request: &Value,
) {
    send(
        socket,
        json!({"type":"res","id":request["id"],"ok":true,"payload":{}}),
    )
    .await;
}

async fn run(capacity: usize) -> Value {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send(
            &mut socket,
            json!({"type":"event","event":"connect.challenge",
            "payload":{"nonce":"local-fixture","ts":1_700_000_000_000_u64}}),
        )
        .await;
        let connect = receive(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
            "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        assert_eq!(receive(&mut socket).await["method"], "fixture.hold");
        send(&mut socket, invoke("native-effect", "example.effect")).await;
        let mut delivered = false;
        while let Ok(Some(Ok(message))) =
            tokio::time::timeout(Duration::from_secs(2), socket.next()).await
        {
            match message {
                message @ (Message::Text(_) | Message::Binary(_)) => {
                    let text = message.into_text().unwrap();
                    let frame: Value = serde_json::from_str(&text).unwrap();
                    if frame["method"] == "node.invoke.result" {
                        assert_eq!(frame["params"]["ok"], true);
                        delivered = true;
                        acknowledge(&mut socket, &frame).await;
                        socket.close(None).await.unwrap();
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
        delivered
    });
    let session = NodeClient::connect_signed(
        GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .max_in_flight(capacity)
            .request_timeout(Duration::from_millis(250)),
        |_| async {
            Ok::<_, std::io::Error>(json!({"role":"node","client":{"mode":"node"},
                "minProtocol":4,"maxProtocol":4,"commands":["example.effect"]}))
        },
    )
    .await
    .unwrap();
    let rpc_session = session.clone();
    let hold = tokio::spawn(async move {
        rpc_session
            .request_until_cancelled("fixture.hold", json!({}))
            .await
    });
    let effects = Arc::new(AtomicUsize::new(0));
    let handler_effects = effects.clone();
    let runtime = CommandRuntime::builder()
        .command("example.effect", move |_| {
            let effects = handler_effects.clone();
            async move {
                effects.fetch_add(1, Ordering::SeqCst);
                Ok(Some(json!({"completed":true})))
            }
        })
        .build()
        .unwrap();
    let start = Instant::now();
    let result = tokio::time::timeout(Duration::from_secs(3), runtime.run(session))
        .await
        .unwrap();
    let delivered = server.await.unwrap();
    let _ = hold.await;
    json!({"rpcCapacity":capacity,"nativeEffects":effects.load(Ordering::SeqCst),"resultDelivered":delivered,
        "elapsedMs":start.elapsed().as_millis(),"runtimeOutcome":format!("{result:?}")})
}

#[tokio::test]
async fn native_result_survives_application_rpc_saturation() {
    let control = run(2).await;
    println!("{control}");
    assert_eq!(control["resultDelivered"], true);
    let saturated = run(1).await;
    println!("{saturated}");
    assert_eq!(saturated["nativeEffects"], 1);
    assert_eq!(
        saturated["resultDelivered"], true,
        "completed native effects must deliver while unrelated RPCs remain held"
    );
}

#[tokio::test]
async fn oversized_result_reports_failure_without_retiring_the_node() {
    const MAXIMUM: usize = 4096;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send(
            &mut socket,
            json!({"type":"event","event":"connect.challenge",
                "payload":{"nonce":"result-limit","ts":1}}),
        )
        .await;
        let connect = receive(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        for id in ["escaped", "envelope", "small"] {
            send(&mut socket, invoke(id, "example.result")).await;
            let result = receive(&mut socket).await;
            assert!(result.to_string().len() <= MAXIMUM);
            assert_eq!(result["method"], "node.invoke.result");
            assert_eq!(result["params"]["id"], id);
            if id == "small" {
                assert_eq!(result["params"]["ok"], true);
                assert_eq!(result["params"]["payloadJSON"], "\"small\"");
            } else {
                assert_eq!(result["params"]["ok"], false);
                assert_eq!(result["params"]["error"]["code"], "OUTPUT_TOO_LARGE");
                assert!(result["params"].get("payloadJSON").is_none());
            }
            acknowledge(&mut socket, &result).await;
        }
        socket.close(None).await.unwrap();
    });
    let session = NodeClient::connect_signed(
        GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .max_message_bytes(MAXIMUM),
        |_| async {
            Ok::<_, std::io::Error>(json!({"role":"node","client":{"mode":"node"},
                "minProtocol":4,"maxProtocol":4,"commands":["example.result"]}))
        },
    )
    .await
    .unwrap();
    let runtime = CommandRuntime::builder()
        .max_output_bytes(MAXIMUM)
        .command("example.result", |context| async move {
            let value = match context.invocation.id.as_str() {
                "escaped" => "\\".repeat(1500),
                "envelope" => "x".repeat(3990),
                _ => "small".to_owned(),
            };
            let payload = Value::String(value);
            // Both rejected outputs fit the handler limit. Escaping and the actual
            // request envelope must be checked before consuming a healthy connection.
            assert!(payload.to_string().len() < MAXIMUM);
            Ok(Some(payload))
        })
        .build()
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(3), runtime.run(session))
        .await
        .unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn stalled_progress_does_not_block_results_or_cancelled_invocations() {
    use openclaw_node_host::HandlerError;
    use tokio::sync::Notify;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let second_started = Arc::new(Notify::new());
    let handler_started = second_started.clone();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send(
            &mut socket,
            json!({"type":"event","event":"connect.challenge",
            "payload":{"nonce":"duplex-capacity","ts":1_700_000_000_000_u64}}),
        )
        .await;
        let connect = receive(&mut socket).await;
        send(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
            "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        assert_eq!(receive(&mut socket).await["method"], "fixture.hold");
        send(&mut socket, invoke("stream-one", "example.stream")).await;
        let stalled = receive(&mut socket).await;
        assert_eq!(stalled["method"], "node.invoke.progress");
        assert_eq!(stalled["params"]["invokeId"], "stream-one");
        send(&mut socket, invoke("stream-two", "example.stream")).await;
        second_started.notified().await;
        send(&mut socket, invoke("effect", "example.effect")).await;
        let effect = receive(&mut socket).await;
        assert_eq!(effect["method"], "node.invoke.result");
        assert_eq!(effect["params"]["id"], "effect");
        assert_eq!(effect["params"]["ok"], true);
        acknowledge(&mut socket, &effect).await;
        send(
            &mut socket,
            json!({"type":"event","event":"node.invoke.cancel","payload":{
            "invokeId":"stream-two","nodeId":"node-fixture"}}),
        )
        .await;
        let cancelled = receive(&mut socket).await;
        assert_eq!(cancelled["method"], "node.invoke.result");
        assert_eq!(cancelled["params"]["id"], "stream-two");
        assert_eq!(cancelled["params"]["ok"], false);
        acknowledge(&mut socket, &cancelled).await;
        acknowledge(&mut socket, &stalled).await;
        let completed = receive(&mut socket).await;
        assert_eq!(
            completed["method"], "node.invoke.result",
            "cancelled queued progress must never reach wire"
        );
        assert_eq!(completed["params"]["id"], "stream-one");
        assert_eq!(completed["params"]["ok"], true);
        acknowledge(&mut socket, &completed).await;
        socket.close(None).await.unwrap();
    });
    let session = NodeClient::connect_signed(
        GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .max_in_flight(1),
        |_| async {
            Ok::<_, std::io::Error>(json!({"role":"node","client":{"mode":"node"},
            "minProtocol":4,"maxProtocol":4,"commands":["example.stream","example.effect"]}))
        },
    )
    .await
    .unwrap();
    let rpc_session = session.clone();
    let hold = tokio::spawn(async move {
        rpc_session
            .request_until_cancelled("fixture.hold", json!({}))
            .await
    });
    let runtime = CommandRuntime::builder()
        .duplex_command("example.stream", move |context| {
            if context.invocation.id == "stream-two" {
                handler_started.notify_one();
            }
            async move {
                context
                    .io
                    .unwrap()
                    .emit_chunk("native output")
                    .await
                    .map_err(|error| HandlerError::new("OUTPUT_FAILED", error.to_string()))?;
                Ok(Some(json!({"completed":true})))
            }
        })
        .command("example.effect", |_| async {
            Ok(Some(json!({"completed":true})))
        })
        .build()
        .unwrap();
    let _ = tokio::time::timeout(Duration::from_secs(3), runtime.run(session))
        .await
        .unwrap();
    server.await.unwrap();
    let _ = hold.await;
}
