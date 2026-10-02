use futures_util::{SinkExt, StreamExt};
use openclaw_gateway_client::{
    ClientError, ConnectAttempt, DispatchRejection, Event, GatewayClient, GatewayClientConfig,
};
use serde_json::{json, Value};
use std::{io, time::Duration};
use tokio::net::TcpListener;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn typed_delivery_releases_payload_before_ack_and_enforces_wire_limit() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    struct OwnedPayload {
        media: String,
        released: Arc<AtomicBool>,
    }
    impl serde::Serialize for OwnedPayload {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(&self.media)
        }
    }
    impl Drop for OwnedPayload {
        fn drop(&mut self) {
            self.released.store(true, Ordering::Release);
        }
    }
    const MAXIMUM: usize = 4096;
    const PREFIX: &[u8] = br#"{"id":"rust-gateway-1","method":"test.media","params":""#;
    const SUFFIX: &[u8] = br#"","type":"req"}"#;
    let media_bytes = MAXIMUM - PREFIX.len() - SUFFIX.len();
    let released = Arc::new(AtomicBool::new(false));
    let observed_release = released.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"typed","ts":1}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        let Message::Binary(frame) = socket.next().await.unwrap().unwrap() else {
            panic!("expected binary JSON request");
        };
        assert_eq!(frame.len(), MAXIMUM);
        assert!(frame.starts_with(PREFIX));
        assert!(frame.ends_with(SUFFIX));
        assert!(frame[PREFIX.len()..MAXIMUM - SUFFIX.len()]
            .iter()
            .all(|byte| *byte == b'x'));
        // The Gateway has not acknowledged the write; normalized media must already be released.
        assert!(observed_release.load(Ordering::Acquire));
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":"rust-gateway-1", "ok":true, "payload":null
            }),
        )
        .await;
        let after = receive_json(&mut socket).await;
        assert_eq!(after["method"], "test.after-oversized");
        send_json(
            &mut socket,
            json!({"type":"res", "id":after["id"], "ok":true, "payload":null}),
        )
        .await;
    });
    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .max_message_bytes(MAXIMUM),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    session
        .request_delivery(
            "test.media",
            OwnedPayload {
                media: "x".repeat(media_bytes),
                released,
            },
        )
        .await
        .unwrap();
    let rejected_release = Arc::new(AtomicBool::new(false));
    assert!(matches!(
        session
            .request_delivery(
                "test.media",
                OwnedPayload {
                    media: "x".repeat(media_bytes + 1),
                    released: rejected_release.clone(),
                }
            )
            .await,
        Err(ClientError::RequestTooLarge { maximum: MAXIMUM })
    ));
    assert!(rejected_release.load(Ordering::Acquire));
    session
        .request("test.after-oversized", json!({}))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn connects_publishes_events_and_correlates_requests() {
    for binary in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json_as(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-1","ts":1_700_000_000_123_u64}
            }),
            binary,
        )
        .await;

            let connect = receive_json(&mut socket).await;
            assert_eq!(connect["method"], "connect");
            assert_eq!(connect["params"]["role"], "node");
            send_json_as(
                &mut socket,
                json!({
                    "type":"res", "id":connect["id"], "ok":true,
                    "payload":{"type":"hello-ok","protocol":4}
                }),
                binary,
            )
            .await;
            ready_rx.await.unwrap();
            send_json_as(
                &mut socket,
                json!({
                    "type":"event", "event":"node.test", "payload":{"ready":true,"text":"é😀\n\""}, "seq":7,
                    "stateVersion":{"presence":9}, "recipientProfileId":"profile-1"
                }),
                binary,
            )
            .await;

            let request = receive_json(&mut socket).await;
            assert_eq!(request["method"], "node.echo");
            send_json_as(
                &mut socket,
                json!({
                    "type":"res", "id":request["id"], "ok":true,
                    "payload":{"echo":request["params"]}
                }),
                binary,
            )
            .await;
            socket.close(None).await.unwrap();
        });

        let session = GatewayClient::connect(
            GatewayClientConfig::new(format!("ws://{address}"))
                .unwrap()
                .challenge_timeout(Duration::from_secs(1)),
            |challenge| async move {
                assert_eq!(challenge.nonce, "nonce-1");
                assert_eq!(challenge.issued_at_ms, 1_700_000_000_123);
                Ok::<_, io::Error>(json!({
                    "minProtocol":4, "maxProtocol":4,
                    "client":{"id":"node-host","version":"test","platform":"test","mode":"node"},
                    "role":"node", "scopes":[]
                }))
            },
        )
        .await
        .unwrap();
        assert_eq!(session.hello()["protocol"], 4);
        let mut independent = session.subscribe();
        ready_tx.send(()).unwrap();
        let expected = Event {
            event: "node.test".into(),
            payload: json!({"ready":true,"text":"é😀\n\""}),
            seq: Some(7),
            state_version: Some(json!({"presence":9})),
            recipient_profile_id: Some("profile-1".into()),
        };
        let mut first = session.next_event().await.unwrap();
        assert_eq!(first, expected);
        first.payload["text"] = json!("changed by first reader");
        first.state_version = None;
        first.recipient_profile_id = None;
        assert_eq!(independent.recv().await.unwrap(), expected);
        assert_eq!(
            session
                .request("node.echo", json!({"value":42}))
                .await
                .unwrap(),
            json!({"echo":{"value":42}})
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn dispatch_guard_rejects_before_wire_without_closing_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-guard","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;

        let request = receive_json(&mut socket).await;
        assert_eq!(request["method"], "node.after-rejection");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":request["id"], "ok":true,
                "payload":{"ok":true}
            }),
        )
        .await;
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .max_message_bytes(4096),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    // Denied authority must win over an oversized frame, without retiring a healthy session.
    let oversized = session
        .request_with_deadline(
            "node.rejected",
            json!({"media": "x".repeat(4096)}),
            tokio::time::Instant::now() + Duration::from_secs(1),
            || Err(DispatchRejection::new("generation changed")),
        )
        .await;
    assert!(
        matches!(oversized, Err(ClientError::DispatchRejected(reason)) if reason == "generation changed")
    );
    let late_rejection = session
        .request_with_dispatch_deadline(
            "node.rejected",
            json!({"media": "x".repeat(4096)}),
            tokio::time::Instant::now() + Duration::from_secs(1),
            |dispatch| {
                dispatch.enqueue();
                Err(DispatchRejection::new("generation changed"))
            },
        )
        .await;
    assert!(matches!(
        late_rejection,
        Err(ClientError::DispatchRejected(reason)) if reason == "generation changed"
    ));
    let rejected = session
        .request_with_deadline(
            "node.rejected",
            json!({}),
            tokio::time::Instant::now() + Duration::from_secs(1),
            || Err(DispatchRejection::new("generation changed")),
        )
        .await;
    assert!(matches!(
        rejected,
        Err(ClientError::DispatchRejected(reason)) if reason == "generation changed"
    ));
    let not_enqueued = session
        .request_with_dispatch_deadline(
            "node.not-enqueued",
            json!({}),
            tokio::time::Instant::now() + Duration::from_secs(1),
            |_| Ok(()),
        )
        .await;
    assert!(matches!(
        not_enqueued,
        Err(ClientError::DispatchRejected(reason))
            if reason == "dispatch guard did not enqueue the request"
    ));
    assert_eq!(
        session
            .request("node.after-rejection", json!({}))
            .await
            .unwrap(),
        json!({"ok":true})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn dispatch_guard_rejection_after_enqueue_retires_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-guard-retire","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;

        let closed = tokio::time::timeout(Duration::from_secs(1), socket.next())
            .await
            .expect("client close timeout");
        assert!(
            !matches!(closed, Some(Ok(Message::Text(_) | Message::Binary(_)))),
            "rejected frame must not reach the server"
        );
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let rejected = session
        .request_with_dispatch_deadline(
            "node.invalid-guard",
            json!({}),
            tokio::time::Instant::now() + Duration::from_secs(1),
            |dispatch| {
                dispatch.enqueue();
                Err(DispatchRejection::new("late rejection"))
            },
        )
        .await;
    assert!(matches!(
        rejected,
        Err(ClientError::Closed(reason))
            if reason == "dispatch guard rejected after enqueue: late rejection"
    ));
    tokio::time::timeout(Duration::from_secs(1), async {
        while !session.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("session retirement timeout");
    assert!(matches!(
        session.request("node.after-invalid-guard", json!({})).await,
        Err(ClientError::Closed(reason))
            if reason == "dispatch guard rejected after enqueue: late rejection"
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn protocol_fallback_reconnects_once_with_a_fresh_challenge() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for (nonce, expected_attempt) in [("nonce-v4", "current"), ("nonce-v3", "fallback")] {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({
                    "type":"event", "event":"connect.challenge",
                    "payload":{"nonce":nonce,"ts":1_700_000_000_123_u64}
                }),
            )
            .await;
            let connect = receive_json(&mut socket).await;
            assert_eq!(connect["params"]["attempt"], expected_attempt);
            if expected_attempt == "current" {
                send_json(
                    &mut socket,
                    json!({
                        "type":"res", "id":connect["id"], "ok":false,
                        "error":{
                            "code":"INVALID_REQUEST",
                            "message":"protocol mismatch",
                            "details":{"code":"PROTOCOL_MISMATCH","expectedProtocol":3}
                        }
                    }),
                )
                .await;
            } else {
                send_json(
                    &mut socket,
                    json!({
                        "type":"res", "id":connect["id"], "ok":true,
                        "payload":{"type":"hello-ok","protocol":3}
                    }),
                )
                .await;
            }
        }
    });

    let session = GatewayClient::connect_with_protocol_fallback(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        3,
        |challenge, attempt| async move {
            let attempt = match attempt {
                ConnectAttempt::Current => "current",
                ConnectAttempt::ProtocolFallback {
                    expected_protocol: 3,
                } => "fallback",
                other => panic!("unexpected attempt: {other:?}"),
            };
            Ok::<_, io::Error>(json!({"attempt":attempt,"nonce":challenge.nonce}))
        },
    )
    .await
    .unwrap();
    assert_eq!(session.hello()["protocol"], 3);
    server.await.unwrap();
}

#[tokio::test]
async fn protocol_fallback_accepts_released_v3_mismatch_response() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for (nonce, fallback) in [("nonce-v4", false), ("nonce-v3", true)] {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({
                    "type":"event", "event":"connect.challenge",
                    "payload":{"nonce":nonce,"ts":1_700_000_000_123_u64}
                }),
            )
            .await;
            let connect = receive_json(&mut socket).await;
            if fallback {
                send_json(
                    &mut socket,
                    json!({
                        "type":"res", "id":connect["id"], "ok":true,
                        "payload":{"type":"hello-ok","protocol":3}
                    }),
                )
                .await;
            } else {
                send_json(
                    &mut socket,
                    json!({
                        "type":"res", "id":connect["id"], "ok":false,
                        "error":{
                            "code":"INVALID_REQUEST",
                            "message":"protocol mismatch",
                            "details":{"expectedProtocol":3}
                        }
                    }),
                )
                .await;
            }
        }
    });

    let session = GatewayClient::connect_with_protocol_fallback(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        3,
        |challenge, attempt| async move {
            Ok::<_, io::Error>(json!({
                "nonce":challenge.nonce,
                "fallback":matches!(attempt, ConnectAttempt::ProtocolFallback { .. })
            }))
        },
    )
    .await
    .unwrap();
    assert_eq!(session.hello()["protocol"], 3);
    server.await.unwrap();
}

#[tokio::test]
async fn protocol_fallback_does_not_retry_unstructured_or_unrelated_errors() {
    for (message, details) in [
        ("rejected", json!({"code":"PROTOCOL_MISMATCH"})),
        (
            "rejected",
            json!({"code":"AUTH_TOKEN_MISMATCH","expectedProtocol":3}),
        ),
        (
            "protocol mismatch",
            json!({"code":"PROTOCOL_MISMATCH","expectedProtocol":4}),
        ),
        ("unrelated rejection", json!({"expectedProtocol":3})),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({
                    "type":"event", "event":"connect.challenge",
                    "payload":{"nonce":"nonce-no-retry","ts":1_700_000_000_123_u64}
                }),
            )
            .await;
            let connect = receive_json(&mut socket).await;
            send_json(
                &mut socket,
                json!({
                    "type":"res", "id":connect["id"], "ok":false,
                    "error":{"code":"INVALID_REQUEST","message":message,"details":details}
                }),
            )
            .await;
            assert!(
                tokio::time::timeout(Duration::from_millis(50), listener.accept())
                    .await
                    .is_err(),
                "unexpected fallback connection"
            );
        });

        let result = GatewayClient::connect_with_protocol_fallback(
            GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
            3,
            |_, _| async { Ok::<_, io::Error>(json!({})) },
        )
        .await;
        assert!(matches!(result, Err(ClientError::Gateway { .. })));
        server.await.unwrap();
    }
}

#[tokio::test]
async fn protocol_mismatch_after_fallback_is_terminal() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for (attempt, expected_protocol) in [(1, 3), (2, 4)] {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({
                    "type":"event", "event":"connect.challenge",
                    "payload":{
                        "nonce":format!("nonce-{attempt}"),
                        "ts":1_700_000_000_123_u64
                    }
                }),
            )
            .await;
            let connect = receive_json(&mut socket).await;
            send_json(
                &mut socket,
                json!({
                    "type":"res", "id":connect["id"], "ok":false,
                    "error":{
                        "code":"INVALID_REQUEST",
                        "message":"protocol mismatch",
                        "details":{
                            "code":"PROTOCOL_MISMATCH",
                            "expectedProtocol":expected_protocol
                        }
                    }
                }),
            )
            .await;
        }
        assert!(
            tokio::time::timeout(Duration::from_millis(50), listener.accept())
                .await
                .is_err(),
            "protocol fallback must not loop"
        );
    });

    let result = GatewayClient::connect_with_protocol_fallback(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        3,
        |_, _| async { Ok::<_, io::Error>(json!({})) },
    )
    .await;
    assert!(matches!(
        result,
        Err(ClientError::Gateway {
            details: Some(details),
            ..
        }) if details["expectedProtocol"] == 4
    ));
    server.await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_deadline_includes_session_queue_wait() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-queue","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;

        let first = receive_json(&mut socket).await;
        assert_eq!(first["method"], "node.blocking-guard");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":first["id"], "ok":true,
                "payload":{"ok":true}
            }),
        )
        .await;
        let next = receive_json(&mut socket).await;
        assert_eq!(next["method"], "node.after-timeout");
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":next["id"], "ok":true,
                "payload":{"ok":true}
            }),
        )
        .await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .request_timeout(Duration::from_secs(1))
        .max_in_flight(3);
    let session = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await
    .unwrap();

    let (guard_started_tx, guard_started_rx) = std::sync::mpsc::channel();
    let (guard_release_tx, guard_release_rx) = std::sync::mpsc::channel();
    let first_session = session.clone();
    let first = tokio::spawn(async move {
        first_session
            .request_with_deadline(
                "node.blocking-guard",
                json!({}),
                tokio::time::Instant::now() + Duration::from_secs(1),
                move || {
                    guard_started_tx.send(()).unwrap();
                    guard_release_rx.recv().unwrap();
                    Ok(())
                },
            )
            .await
    });
    tokio::task::spawn_blocking(move || guard_started_rx.recv().unwrap())
        .await
        .unwrap();

    let expired = session
        .request_with_deadline(
            "node.expires-in-queue",
            json!({}),
            tokio::time::Instant::now() + Duration::from_millis(20),
            || Ok(()),
        )
        .await;
    assert!(matches!(
        expired,
        Err(ClientError::RequestTimeout(method)) if method == "node.expires-in-queue"
    ));
    guard_release_tx.send(()).unwrap();
    assert_eq!(first.await.unwrap().unwrap(), json!({"ok":true}));
    assert_eq!(
        session
            .request("node.after-timeout", json!({}))
            .await
            .unwrap(),
        json!({"ok":true})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn idle_disconnect_unblocks_the_retained_event_receiver() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-close","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), session.next_event())
        .await
        .expect("idle disconnect must unblock next_event");
    assert!(matches!(result, Err(ClientError::Closed(_))));
    server.await.unwrap();
}

#[tokio::test]
async fn raw_event_subscription_closes_with_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-subscribe","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let mut events = session.subscribe();
    assert!(matches!(
        session.wait_closed().await,
        Err(ClientError::Closed(_))
    ));
    assert!(matches!(
        tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("subscription must terminate"),
        Err(ClientError::Closed(_))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn default_buffer_retains_256_small_events() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (assertions_done_tx, assertions_done_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-buffer","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        for seq in 0..256 {
            send_json(
                &mut socket,
                json!({"type":"event", "event":"node.small", "seq":seq}),
            )
            .await;
        }
        acknowledge_buffered_events(&mut socket).await;
        let _ = assertions_done_rx.await;
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    session.request("test.buffered", Value::Null).await.unwrap();
    for seq in 0..256 {
        let event = session.next_event().await.unwrap();
        assert_eq!(event.event, "node.small");
        assert_eq!(event.seq, Some(seq));
    }
    assertions_done_tx.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn oversized_retained_event_lags_without_closing_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (assertions_done_tx, assertions_done_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-large-event","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.large",
                "payload":{"value":"x".repeat(2000)}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event", "event":"node.after-large", "seq":2}),
        )
        .await;
        acknowledge_buffered_events(&mut socket).await;
        let _ = assertions_done_rx.await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .event_capacity(2)
        .max_event_buffer_bytes(1024);
    let session = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await
    .unwrap();
    session.request("test.buffered", Value::Null).await.unwrap();
    assert!(matches!(
        session.next_event().await,
        Err(ClientError::EventLagged(1))
    ));
    assert_eq!(
        session.next_event().await.unwrap().event,
        "node.after-large"
    );
    assert!(!session.is_closed());
    assertions_done_tx.send(()).unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn abandoned_request_releases_its_in_flight_permit() {
    for caller_owned in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (first_seen_tx, first_seen_rx) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-abandon","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
            let connect = receive_json(&mut socket).await;
            send_json(
                &mut socket,
                json!({
                    "type":"res", "id":connect["id"], "ok":true,
                    "payload":{"type":"hello-ok","protocol":4}
                }),
            )
            .await;
            let first = receive_json(&mut socket).await;
            assert_eq!(first["method"], "node.first");
            first_seen_tx.send(()).unwrap();
            let second = receive_json(&mut socket).await;
            assert_eq!(second["method"], "node.second");
            send_json(
                &mut socket,
                json!({
                    "type":"res", "id":second["id"], "ok":true,
                    "payload":{"ok":true}
                }),
            )
            .await;
        });

        let config = GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .request_timeout(Duration::from_millis(250))
            .max_in_flight(1);
        let session = GatewayClient::connect(config, |_| async {
            Ok::<_, io::Error>(json!({"role":"node"}))
        })
        .await
        .unwrap();
        let first_session = session.clone();
        let mut first = tokio::spawn(async move {
            if caller_owned {
                first_session
                    .request_until_cancelled("node.first", json!({}))
                    .await
            } else {
                first_session.request("node.first", json!({})).await
            }
        });
        first_seen_rx.await.unwrap();
        if caller_owned {
            // The native owner may legitimately wait beyond the shared client's default deadline.
            assert!(tokio::time::timeout(Duration::from_millis(500), &mut first)
                .await
                .is_err());
        }
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());

        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(1),
                session.request("node.second", json!({}))
            )
            .await
            .expect("second request must acquire the released permit")
            .unwrap(),
            json!({"ok":true})
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn drains_a_queued_event_before_reporting_disconnect() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-final","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"node.final", "payload":{"ready":true}
            }),
        )
        .await;
        socket.close(None).await.unwrap();
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    assert!(matches!(
        session.wait_closed().await,
        Err(ClientError::Closed(_))
    ));
    assert_eq!(
        session.next_event().await.unwrap(),
        Event {
            event: "node.final".into(),
            payload: json!({"ready":true}),
            seq: None,
            state_version: None,
            recipient_profile_id: None,
        }
    );
    assert!(matches!(
        session.next_event().await,
        Err(ClientError::Closed(_))
    ));
    server.await.unwrap();
}

#[tokio::test]
async fn surfaces_websocket_ping_as_transport_activity() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (subscribed_tx, subscribed_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-ping","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        subscribed_rx.await.unwrap();
        socket
            .send(Message::Ping(vec![1, 2, 3].into()))
            .await
            .unwrap();
        let pong = socket.next().await.unwrap().unwrap();
        assert!(matches!(pong, Message::Pong(_)));
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let mut activity = session.subscribe_transport_activity();
    subscribed_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), activity.changed())
        .await
        .expect("ping activity timeout")
        .expect("activity channel remains open");
    server.await.unwrap();
}

#[tokio::test]
async fn websocket_ping_remains_available_when_rpc_capacity_is_full() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (request_seen_tx, request_seen_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge",
                "payload":{"nonce":"nonce-saturated-ping","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;

        let request = receive_json(&mut socket).await;
        assert_eq!(request["method"], "node.blocked");
        request_seen_tx.send(()).unwrap();
        let ping = socket.next().await.unwrap().unwrap();
        let Message::Ping(payload) = ping else {
            panic!("expected websocket ping while request capacity is full");
        };
        socket.send(Message::Pong(payload)).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":request["id"], "ok":true,
                "payload":{"released":true}
            }),
        )
        .await;
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .request_timeout(Duration::from_secs(1))
            .max_in_flight(1),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let request_session = session.clone();
    let request =
        tokio::spawn(async move { request_session.request("node.blocked", json!({})).await });
    request_seen_rx.await.unwrap();

    tokio::time::timeout(Duration::from_secs(1), session.ping())
        .await
        .expect("ping must not wait for RPC capacity")
        .unwrap();
    assert_eq!(request.await.unwrap().unwrap(), json!({"released":true}));
    server.await.unwrap();
}

#[tokio::test]
async fn malformed_idle_text_is_activity_and_does_not_close_the_session() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (subscribed_tx, subscribed_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge",
                "payload":{"nonce":"nonce-malformed-idle","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        subscribed_rx.await.unwrap();
        socket
            .send(Message::Text("not gateway json".into()))
            .await
            .unwrap();
        let request = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":request["id"], "ok":true,
                "payload":{"stillConnected":true}
            }),
        )
        .await;
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let mut activity = session.subscribe_transport_activity();
    subscribed_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(1), activity.changed())
        .await
        .expect("malformed idle frame activity timeout")
        .expect("activity channel remains open");
    assert_eq!(
        session
            .request("node.after-malformed", json!({}))
            .await
            .unwrap(),
        json!({"stillConnected":true})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn malformed_response_does_not_close_a_session_with_a_pending_request() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge",
                "payload":{"nonce":"nonce-malformed-pending","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
        let request = receive_json(&mut socket).await;
        socket
            .send(Message::Text(
                json!({"type":"res","ok":true}).to_string().into(),
            ))
            .await
            .unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":request["id"], "ok":true,
                "payload":{"stillConnected":true}
            }),
        )
        .await;
    });

    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    assert_eq!(
        session
            .request("node.with-malformed", json!({}))
            .await
            .unwrap(),
        json!({"stillConnected":true})
    );
    server.await.unwrap();
}

#[tokio::test]
async fn connect_response_uses_the_request_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-slow","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        send_json(
            &mut socket,
            json!({
                "type":"res", "id":connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .challenge_timeout(Duration::from_millis(10))
        .request_timeout(Duration::from_millis(100));
    let session = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await
    .expect("connect response may outlive the challenge timeout");
    assert_eq!(session.hello()["protocol"], 4);
    server.await.unwrap();
}

#[tokio::test]
async fn websocket_establishment_uses_the_connect_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (_tcp, _) = listener.accept().await.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;
    });

    let config = GatewayClientConfig::new(format!("ws://{address}"))
        .unwrap()
        .connect_timeout(Duration::from_millis(25));
    let result = GatewayClient::connect(config, |_| async {
        Ok::<_, io::Error>(json!({"role":"node"}))
    })
    .await;
    assert!(matches!(result, Err(ClientError::ConnectTimeout)));
    server.abort();
}

#[tokio::test]
async fn connect_rejection_preserves_recovery_details() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"nonce-2","ts":1_700_000_000_123_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(&mut socket, json!({
            "type":"res", "id":connect["id"], "ok":false,
            "error":{"code":"NOT_PAIRED","message":"pairing required",
                "details":{"code":"PAIRING_REQUIRED","deviceId":"device-1","pauseReconnect":true},
                "retryable":false,"retryAfterMs":1250}
        })).await;
    });

    let result = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
        |_| async { Ok::<_, io::Error>(json!({})) },
    )
    .await;
    let Err(ClientError::Gateway {
        details,
        retryable,
        retry_after_ms,
        ..
    }) = result
    else {
        panic!("expected structured Gateway rejection");
    };
    let details = openclaw_gateway_client::ConnectErrorDetails::from_value(details.as_ref());
    assert_eq!(details.device_id(), Some("device-1"));
    assert!(details.should_pause_reconnect());
    assert_eq!(retryable, Some(false));
    assert_eq!(retry_after_ms, Some(1250));
    server.await.unwrap();
}

#[test]
fn plaintext_policy_accepts_trusted_private_targets_only() {
    for target in [
        "ws://127.0.0.1:18789",
        "ws://localhost.:18789",
        "ws://192.168.1.10:18789",
        "ws://100.64.0.1:18789",
        "ws://[::ffff:127.0.0.1]:18789",
        "ws://[::ffff:192.168.1.10]:18789",
        "ws://[::ffff:100.64.0.1]:18789",
        "ws://studio.local:18789",
        "ws://studio.example.ts.net:18789",
        "ws://[fd00::1]:18789",
    ] {
        GatewayClientConfig::new(target).expect("trusted private Gateway target");
    }
    assert!(matches!(
        GatewayClientConfig::new("ws://gateway.example.com:18789"),
        Err(ClientError::InsecureRemoteGateway)
    ));
    assert!(matches!(
        GatewayClientConfig::new("ws://[::ffff:8.8.8.8]:18789"),
        Err(ClientError::InsecureRemoteGateway)
    ));
}

#[tokio::test]
async fn pinned_trust_rejects_plaintext_before_connecting() {
    let config = GatewayClientConfig::new("ws://127.0.0.1:9")
        .unwrap()
        .tls_trust(openclaw_gateway_client::TlsTrust::Pinned([7; 32]));
    let result = GatewayClient::connect(config, |_| async { Ok::<_, io::Error>(json!({})) }).await;
    assert!(matches!(result, Err(ClientError::Tls(_))));
}

async fn acknowledge_buffered_events<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    // The response follows every event on the same socket, so the client must
    // process those events before completing the request and starting to drain.
    let barrier = receive_json(socket).await;
    assert_eq!(barrier["method"], "test.buffered");
    send_json(
        socket,
        json!({"type":"res", "id":barrier["id"], "ok":true, "payload":null}),
    )
    .await;
}

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json_as(socket, value, false).await;
}

async fn send_json_as<S>(
    socket: &mut tokio_tungstenite::WebSocketStream<S>,
    value: Value,
    binary: bool,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let encoded = value.to_string();
    let message = if binary {
        Message::Binary(encoded.into_bytes().into())
    } else {
        Message::Text(encoded.into())
    };
    socket.send(message).await.unwrap();
}

async fn receive_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = socket.next().await.unwrap().unwrap();
    serde_json::from_str(message.into_text().unwrap().as_str()).unwrap()
}

#[tokio::test]
async fn delivery_streaming_and_ping_reserve_bounded_independent_capacity() {
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };
    for capacity in [1, 2] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (seen_tx, mut seen_rx) = tokio::sync::mpsc::channel(3);
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({"type":"event","event":"connect.challenge",
            "payload":{"nonce":"capacity","ts":1700000000000_u64}}),
            )
            .await;
            let connect = receive_json(&mut socket).await;
            send_json(
                &mut socket,
                json!({"type":"res","id":connect["id"],"ok":true,
            "payload":{"type":"hello-ok","protocol":4}}),
            )
            .await;
            while let Some(message) = socket.next().await {
                match message.unwrap() {
                    Message::Ping(payload) => socket.send(Message::Pong(payload)).await.unwrap(),
                    message @ (Message::Text(_) | Message::Binary(_)) => {
                        let text = message.into_text().unwrap();
                        let frame: Value = serde_json::from_str(&text).unwrap();
                        let method = frame["method"].as_str().unwrap();
                        assert!(
                            !method.ends_with("blocked"),
                            "a full lane admitted an extra request"
                        );
                        assert_ne!(
                            method, "stream.stale",
                            "retired streaming owner reached wire"
                        );
                        if method.ends_with("held") {
                            seen_tx.send(method.to_owned()).await.unwrap();
                        } else {
                            send_json(
                                &mut socket,
                                json!({"type":"res","id":frame["id"],"ok":true,
                            "payload":{"delivered":true}}),
                            )
                            .await;
                        }
                        if method == "delivery.finish" {
                            break;
                        }
                    }
                    other => panic!("unexpected message: {other:?}"),
                }
            }
        });
        let session = GatewayClient::connect(
            GatewayClientConfig::new(format!("ws://{address}"))
                .unwrap()
                .max_in_flight(capacity)
                .request_timeout(Duration::from_secs(5)),
            |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
        )
        .await
        .unwrap();
        let mut ordinary = Vec::new();
        for _ in 0..capacity {
            let ordinary_session = session.clone();
            ordinary.push(tokio::spawn(async move {
                ordinary_session
                    .request_until_cancelled("app.held", json!({}))
                    .await
            }));
            assert_eq!(seen_rx.recv().await.unwrap(), "app.held");
        }
        let mut streaming = Vec::new();
        for _ in 0..capacity {
            let streaming_session = session.clone();
            streaming.push(tokio::spawn(async move {
                streaming_session
                    .request_streaming("stream.held", json!({}), |dispatch| {
                        dispatch.enqueue();
                        Ok(())
                    })
                    .await
            }));
            assert_eq!(seen_rx.recv().await.unwrap(), "stream.held");
        }
        assert_eq!(
            session
                .request_delivery("delivery.complete", json!({}))
                .await
                .unwrap(),
            json!({"delivered":true})
        );
        let mut delivery = Vec::new();
        for _ in 0..capacity {
            let delivery_session = session.clone();
            delivery.push(tokio::spawn(async move {
                delivery_session
                    .request_delivery("delivery.held", json!({}))
                    .await
            }));
            assert_eq!(seen_rx.recv().await.unwrap(), "delivery.held");
        }
        // A stalled streaming peer and a stalled delivery peer cannot consume app or
        // keepalive capacity, and none of the three RPC lanes admits an extra request.
        let blocked_app = session.request("app.blocked", json!({}));
        let blocked_delivery = session.request_delivery("delivery.blocked", json!({}));
        let blocked_stream = session.request_streaming("stream.blocked", json!({}), |dispatch| {
            dispatch.enqueue();
            Ok(())
        });
        let (app, result, progress) = tokio::join!(
            tokio::time::timeout(Duration::from_millis(30), blocked_app),
            tokio::time::timeout(Duration::from_millis(30), blocked_delivery),
            tokio::time::timeout(Duration::from_millis(30), blocked_stream),
        );
        assert!(app.is_err() && result.is_err() && progress.is_err());
        session.ping().await.unwrap();
        let active = Arc::new(AtomicBool::new(true));
        let guard_active = active.clone();
        let stale = session.request_streaming("stream.stale", json!({}), move |dispatch| {
            if !guard_active.load(Ordering::SeqCst) {
                return Err(DispatchRejection::new("owner retired"));
            }
            dispatch.enqueue();
            Ok(())
        });
        tokio::pin!(stale);
        assert!(tokio::time::timeout(Duration::from_millis(30), &mut stale)
            .await
            .is_err());
        active.store(false, Ordering::SeqCst);
        let released = streaming.pop().unwrap();
        released.abort();
        assert!(released.await.unwrap_err().is_cancelled());
        assert!(
            matches!(stale.await, Err(ClientError::DispatchRejected(reason)) if reason == "owner retired")
        );
        let released = delivery.pop().unwrap();
        released.abort();
        assert!(released.await.unwrap_err().is_cancelled());
        session
            .request_delivery("delivery.finish", json!({}))
            .await
            .unwrap();
        for task in ordinary.into_iter().chain(streaming).chain(delivery) {
            task.abort();
            let _ = task.await;
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn cloned_handles_share_one_hello_snapshot_across_pending_requests() {
    const REQUESTS: usize = 64;
    const TEXT_BYTES: usize = 64 * 1024;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (seen_tx, seen_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({
                "type":"event", "event":"connect.challenge",
                "payload":{"nonce":"hello-owner-fixture","ts":1700000000000_u64}
            }),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(&mut socket, json!({
            "type":"res", "id":connect["id"], "ok":true,
            "payload":{
                "type":"hello-ok", "protocol":4,
                "server":{"version":"fixture","connId":"hello-owner"},
                "features":{"methods":["node.echo"],"events":[]},
                "snapshot":{
                    "presence":[{"ts":1,"text":"h".repeat(TEXT_BYTES)}],
                    "health":{}, "stateVersion":{"presence":0,"health":0}, "uptimeMs":0
                },
                "auth":{"role":"node","scopes":[]},
                "policy":{"maxPayload":26214400,"maxBufferedBytes":52428800,"tickIntervalMs":30000}
            }
        })).await;
        let mut pending = Vec::with_capacity(REQUESTS);
        for _ in 0..REQUESTS {
            let request = receive_json(&mut socket).await;
            assert_eq!(request["method"], "node.echo");
            pending.push(request);
        }
        seen_tx.send(()).unwrap();
        release_rx.await.unwrap();
        for request in pending {
            send_json(
                &mut socket,
                json!({
                    "type":"res", "id":request["id"], "ok":true,
                    "payload":{"index":request["params"]["index"]}
                }),
            )
            .await;
        }
        while let Some(message) = socket.next().await {
            if matches!(message.unwrap(), Message::Close(_)) {
                break;
            }
        }
    });
    let session = GatewayClient::connect(
        GatewayClientConfig::new(format!("ws://{address}"))
            .unwrap()
            .max_in_flight(REQUESTS),
        |_| async { Ok::<_, io::Error>(json!({"role":"node"})) },
    )
    .await
    .unwrap();
    let mut storage = std::collections::HashSet::new();
    let text = session.hello()["snapshot"]["presence"][0]["text"]
        .as_str()
        .unwrap();
    assert_eq!(text.len(), TEXT_BYTES);
    let mut requests = tokio::task::JoinSet::new();
    for index in 0..REQUESTS {
        let handle = session.clone();
        let text = handle.hello()["snapshot"]["presence"][0]["text"]
            .as_str()
            .unwrap();
        storage.insert(text.as_ptr() as usize);
        requests.spawn(async move {
            let result = handle
                .request_until_cancelled("node.echo", json!({"index":index}))
                .await
                .unwrap();
            assert_eq!(result, json!({"index":index}));
            let text = handle.hello()["snapshot"]["presence"][0]["text"]
                .as_str()
                .unwrap();
            assert_eq!(text.len(), TEXT_BYTES);
            assert!(text.bytes().all(|byte| byte == b'h'));
        });
    }
    let retained = session.clone();
    storage.insert(
        retained.hello()["snapshot"]["presence"][0]["text"]
            .as_str()
            .unwrap()
            .as_ptr() as usize,
    );
    drop(session);
    tokio::time::timeout(Duration::from_secs(5), seen_rx)
        .await
        .unwrap()
        .unwrap();
    // Every handle is still alive in a real pending request. Count storage,
    // not timing or allocator RSS, to protect the immutable snapshot's one owner.
    let distinct_backing_stores = storage.len();
    release_tx.send(()).unwrap();
    while let Some(result) = requests.join_next().await {
        result.unwrap();
    }
    retained.close().await;
    server.await.unwrap();
    let hello: &Value = retained.hello();
    assert_eq!(hello["protocol"], 4);
    assert_eq!(
        hello["snapshot"]["presence"][0]["text"]
            .as_str()
            .unwrap()
            .len(),
        TEXT_BYTES
    );
    assert_eq!(
        distinct_backing_stores, 1,
        "session clones must share the immutable hello allocation"
    );
}
