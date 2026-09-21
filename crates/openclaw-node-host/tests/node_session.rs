use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use openclaw_node_host::{
    AuthenticatedSidecarChannel, CancellationToken, CommandRuntime, ConnectAuth, HandlerError,
    NodeClient, NodeClientConfig, NodeConnectOptions, NodeIdentity, NodeProtocolVersion,
    NodeSession, SidecarAdapterError, SidecarAdapterFuture, SidecarAdmissionDecision,
    SidecarCapabilityAdapter, SidecarCommandRegistration, SidecarConfigurationExchange,
    SidecarHandshake, SidecarInvocation, SidecarInvocationResult, SidecarLimits,
    SidecarPeerIdentity, SidecarPeerRole, SidecarProtocolOffer, SidecarRuntimeBridge,
    SidecarRuntimeConfiguration, SidecarSessionKey, SIDECAR_PROTOCOL_MAJOR, SIDECAR_PROTOCOL_MINOR,
};
use serde_json::{json, Value};
use std::{
    io,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::net::TcpListener;
use tokio::sync::Notify;
use tokio_tungstenite::{accept_async, tungstenite::Message};

#[tokio::test]
async fn public_runtime_completes_allowed_work_and_suppresses_wire_cancelled_effects() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let cancelled_handler_entered = Arc::new(Notify::new());
    let server_handler_entered = Arc::clone(&cancelled_handler_entered);
    let server = tokio::spawn(serve_public_runtime_authority(
        listener,
        server_handler_entered,
    ));

    let native_effects = Arc::new(AtomicUsize::new(0));
    let handler_effects = Arc::clone(&native_effects);
    let handler_entered = Arc::clone(&cancelled_handler_entered);
    let runtime = CommandRuntime::builder()
        .command("example.status", move |context| {
            let effects = Arc::clone(&handler_effects);
            let entered = Arc::clone(&handler_entered);
            async move {
                assert_eq!(
                    context.invocation.session_key.as_deref(),
                    (context.invocation.id == "allowed").then_some("agent:main:main")
                );
                if context.invocation.id == "cancelled" {
                    entered.notify_one();
                    context.cancellation.cancelled().await;
                    return Err(HandlerError::new(
                        "CANCELLED_BY_GATEWAY",
                        "Gateway cancelled before native effects",
                    ));
                }
                assert_eq!(context.invocation.params, json!({"verbose": true}));
                effects.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"ready": true}))
            }
        })
        .build()
        .unwrap();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |challenge| {
            let signing_key = signing_key.clone();
            async move {
                assert_eq!(challenge.nonce, "node-nonce");
                let options = NodeConnectOptions::new("test", "linux")
                    .command("example.status")
                    .activate()
                    .auth(ConnectAuth::token("test-token"));
                let request = options.external_signing_request(public_key, &challenge)?;
                let signature = signing_key.sign(request.payload().as_bytes());
                Ok::<_, openclaw_node_host::IdentityError>(
                    options.device(request.finish(signature.to_bytes())?),
                )
            }
        },
    )
    .await
    .unwrap();
    assert!(session.is_activated());
    assert_eq!(session.issued_device_token(), Some("issued-device-token"));
    assert!(runtime.run(session).await.is_err());
    server.await.unwrap();
    assert_eq!(native_effects.load(Ordering::SeqCst), 1);
}

async fn serve_public_runtime_authority(listener: TcpListener, handler_entered: Arc<Notify>) {
    let (tcp, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(tcp).await.unwrap();
    send_json(
        &mut socket,
        json!({
            "type":"event", "event":"connect.challenge",
            "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}
        }),
    )
    .await;
    let connect = receive_json(&mut socket).await;
    assert_eq!(connect["params"]["client"]["mode"], "node");
    assert_eq!(connect["params"]["role"], "node");
    assert_eq!(connect["params"]["commands"], json!(["example.status"]));
    assert_eq!(connect["params"]["device"]["nonce"], "node-nonce");
    send_json(
        &mut socket,
        json!({"type":"res","id":connect["id"],"ok":true,
            "payload":{"type":"hello-ok","protocol":4,
                "auth":{"deviceToken":"issued-device-token"}}}),
    )
    .await;
    send_json(
        &mut socket,
        json!({"type":"event","event":"node.invoke.request","payload":{
            "id":"allowed","nodeId":"node-1","command":"example.status",
            "paramsJSON":"{\"verbose\":true}","sessionKey":"agent:main:main"
        }}),
    )
    .await;
    let allowed = receive_json(&mut socket).await;
    assert_eq!(allowed["method"], "node.invoke.result");
    assert_eq!(allowed["params"]["id"], "allowed");
    assert_eq!(allowed["params"]["payload"], json!({"ready":true}));
    send_json(
        &mut socket,
        json!({"type":"res","id":allowed["id"],"ok":true,"payload":{"accepted":true}}),
    )
    .await;
    send_json(
        &mut socket,
        json!({"type":"event","event":"node.invoke.request","payload":{
            "id":"cancelled","nodeId":"node-1","command":"example.status",
            "paramsJSON":"{\"verbose\":false}"
        }}),
    )
    .await;
    tokio::time::timeout(
        std::time::Duration::from_secs(1),
        handler_entered.notified(),
    )
    .await
    .expect("cancelled handler did not reach its authority boundary");
    send_json(
        &mut socket,
        json!({"type":"event","event":"node.invoke.cancel",
            "payload":{"invokeId":"cancelled","nodeId":"node-1"}}),
    )
    .await;
    let cancelled = receive_json(&mut socket).await;
    assert_eq!(cancelled["method"], "node.invoke.result");
    assert_eq!(cancelled["params"]["id"], "cancelled");
    assert_eq!(cancelled["params"]["ok"], false);
    assert_eq!(cancelled["params"]["error"]["code"], "CANCELLED_BY_GATEWAY");
    send_json(
        &mut socket,
        json!({"type":"res","id":cancelled["id"],"ok":true,"payload":{"accepted":true}}),
    )
    .await;
    socket.close(None).await.unwrap();
}

#[tokio::test]
async fn runtime_rejects_buffered_invocation_after_session_retirement_is_requested() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({"type":"event","event":"connect.challenge",
                "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event","event":"node.invoke.request",
                "payload":{"id":"retired","nodeId":"node-1","command":"example.status"}}),
        )
        .await;
        let barrier = receive_json(&mut socket).await;
        assert_eq!(barrier["method"], "test.buffered");
        send_json(
            &mut socket,
            json!({"type":"res","id":barrier["id"],"ok":true,"payload":null}),
        )
        .await;
        while let Some(message) = socket.next().await {
            let message = message.unwrap();
            if message.is_close() {
                break;
            }
            if let Message::Text(text) = message {
                let request: Value = serde_json::from_str(text.as_str()).unwrap();
                send_json(
                    &mut socket,
                    json!({"type":"res","id":request["id"],"ok":true,"payload":null}),
                )
                .await;
            }
        }
    });

    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        |_challenge| async move {
            Ok::<_, io::Error>(
                NodeConnectOptions::new("test", "linux")
                    .command("example.status")
                    .activate()
                    .auth(ConnectAuth::token("test-token"))
                    .identity(NodeIdentity::from_secret_bytes([7; 32])),
            )
        },
    )
    .await
    .unwrap();
    session.request("test.buffered", Value::Null).await.unwrap();
    session.close().await;
    assert!(session.is_retired());

    let handler_ran = Arc::new(AtomicBool::new(false));
    let handler_state = Arc::clone(&handler_ran);
    let runtime = CommandRuntime::builder()
        .command("example.status", move |_context| {
            let handler_state = Arc::clone(&handler_state);
            handler_state.store(true, Ordering::SeqCst);
            async { Ok(Value::Null) }
        })
        .build()
        .unwrap();

    assert!(runtime.run(session).await.is_err());
    assert!(!handler_ran.load(Ordering::SeqCst));
    server.await.unwrap();
}

#[tokio::test]
async fn wire_cancellation_during_admission_prevents_handler_construction() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let admission_started = Arc::new(Notify::new());
    let server_admission_started = Arc::clone(&admission_started);
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({"type":"event","event":"connect.challenge",
                "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event","event":"node.invoke.request",
                "payload":{"id":"cancel-during-admission","nodeId":"node-1",
                    "command":"example.status"}}),
        )
        .await;
        tokio::time::timeout(Duration::from_secs(1), server_admission_started.notified())
            .await
            .expect("admission policy did not reach its authority boundary");
        send_json(
            &mut socket,
            json!({"type":"event","event":"node.invoke.cancel",
                "payload":{"invokeId":"cancel-during-admission","nodeId":"node-1"}}),
        )
        .await;
        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["id"], "cancel-during-admission");
        assert_eq!(result["params"]["ok"], false);
        assert_eq!(result["params"]["error"]["code"], "INVOCATION_CANCELLED");
        acknowledge(&mut socket, &result).await;
        socket.close(None).await.unwrap();
    });

    let policy_started = Arc::clone(&admission_started);
    let handler_constructed = Arc::new(AtomicBool::new(false));
    let handler_state = Arc::clone(&handler_constructed);
    let runtime = CommandRuntime::builder()
        .admission_policy(move |context| {
            policy_started.notify_one();
            async move {
                context.cancellation.cancelled().await;
                Ok::<(), HandlerError>(())
            }
        })
        .command("example.status", move |_context| {
            handler_state.store(true, Ordering::SeqCst);
            async { Ok(Value::Null) }
        })
        .build()
        .unwrap();
    let session = connect_with_command(address, "example.status").await;

    assert!(runtime.run(session).await.is_err());
    server.await.unwrap();
    assert!(!handler_constructed.load(Ordering::SeqCst));
}

#[derive(Default)]
struct AuthorityAdapter {
    admissions: AtomicUsize,
    invocations: AtomicUsize,
    native_effects: AtomicUsize,
    retiring_invocation_started: Notify,
}

impl SidecarCapabilityAdapter for AuthorityAdapter {
    fn admit(
        &self,
        invocation: SidecarInvocation,
        _cancellation: CancellationToken,
    ) -> SidecarAdapterFuture<Result<SidecarAdmissionDecision, SidecarAdapterError>> {
        self.admissions.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            if invocation.command == "product.settings" {
                Ok(SidecarAdmissionDecision::Deny {
                    code: "LOCAL_DENY".into(),
                    message: "denied by product policy".into(),
                })
            } else {
                Ok(SidecarAdmissionDecision::Allow)
            }
        })
    }

    fn invoke(
        &self,
        invocation: SidecarInvocation,
        cancellation: CancellationToken,
    ) -> SidecarAdapterFuture<Result<SidecarInvocationResult, SidecarAdapterError>> {
        self.invocations.fetch_add(1, Ordering::SeqCst);
        if invocation.params == json!({"retire": true}) {
            self.retiring_invocation_started.notify_one();
            return Box::pin(async move {
                cancellation.cancelled().await;
                Err(SidecarAdapterError::new(
                    "CANCELLED",
                    "retired before native effects",
                ))
            });
        }
        self.native_effects.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move {
            Ok(SidecarInvocationResult::Success {
                payload: json!({"handledBy": "sidecar-bridge"}),
            })
        })
    }
}

#[tokio::test]
async fn sidecar_bridge_preserves_authority_through_the_public_runtime() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({"type":"event","event":"connect.challenge",
                "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;

        for (id, command, params, expected) in [
            (
                "allowed",
                "product.status",
                json!({}),
                ("", json!({"handledBy": "sidecar-bridge"})),
            ),
            (
                "denied",
                "product.settings",
                json!({}),
                ("LOCAL_DENY", Value::Null),
            ),
            (
                "retired",
                "product.status",
                json!({"retire": true}),
                ("SIDECAR_CHANNEL_RETIRED", Value::Null),
            ),
        ] {
            send_json(
                &mut socket,
                json!({"type":"event","event":"node.invoke.request","payload":{
                    "id":id,"nodeId":"node-1","command":command,
                    "paramsJSON":params.to_string()
                }}),
            )
            .await;
            let result = receive_json(&mut socket).await;
            assert_eq!(result["method"], "node.invoke.result");
            assert_eq!(result["params"]["id"], id);
            if expected.0.is_empty() {
                assert_eq!(result["params"]["payload"], expected.1);
            } else {
                assert_eq!(result["params"]["ok"], false);
                assert_eq!(result["params"]["error"]["code"], expected.0);
            }
            acknowledge(&mut socket, &result).await;
        }
        socket.close(None).await.unwrap();
    });

    let adapter = Arc::new(AuthorityAdapter::default());
    let (bridge, mut channel) = activated_sidecar_bridge(&adapter);
    let runtime = bridge.into_runtime();
    let connect_runtime = runtime.clone();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |_challenge| {
            let connect_runtime = connect_runtime.clone();
            async move {
                Ok::<_, io::Error>(
                    connect_runtime.activate(
                        NodeConnectOptions::new("test", "linux")
                            .auth(ConnectAuth::token("test-token"))
                            .identity(NodeIdentity::from_secret_bytes([7; 32])),
                    ),
                )
            }
        },
    )
    .await
    .unwrap();
    let run = tokio::spawn(async move { runtime.run(session).await });
    tokio::time::timeout(
        Duration::from_secs(1),
        adapter.retiring_invocation_started.notified(),
    )
    .await
    .expect("retiring sidecar invocation did not reach the adapter boundary");
    channel.retire();

    assert!(run.await.unwrap().is_err());
    server.await.unwrap();
    assert_eq!(adapter.admissions.load(Ordering::SeqCst), 3);
    assert_eq!(adapter.invocations.load(Ordering::SeqCst), 2);
    assert_eq!(adapter.native_effects.load(Ordering::SeqCst), 1);
}

fn activated_sidecar_bridge(
    adapter: &Arc<AuthorityAdapter>,
) -> (SidecarRuntimeBridge, AuthenticatedSidecarChannel) {
    let mut supervisor_handshake =
        SidecarHandshake::new(sidecar_offer(SidecarPeerRole::Supervisor)).unwrap();
    let mut runtime_handshake =
        SidecarHandshake::new(sidecar_offer(SidecarPeerRole::Runtime)).unwrap();
    let mut supervisor_channel = sidecar_channel(SidecarPeerRole::Supervisor);
    let mut runtime_channel = sidecar_channel(SidecarPeerRole::Runtime);
    let offer = supervisor_handshake.start(&mut supervisor_channel).unwrap();
    let acceptance = runtime_handshake
        .receive(&mut runtime_channel, &offer)
        .unwrap()
        .unwrap();
    runtime_handshake
        .complete_acceptance(&mut runtime_channel)
        .unwrap();
    supervisor_handshake
        .receive(&mut supervisor_channel, &acceptance)
        .unwrap();

    let mut supervisor_exchange = SidecarConfigurationExchange::new(supervisor_handshake).unwrap();
    let mut runtime_exchange = SidecarConfigurationExchange::new(runtime_handshake).unwrap();
    let configuration = SidecarRuntimeConfiguration {
        manifest_generation: 1,
        capabilities: vec!["native.status".into()],
        commands: vec![
            SidecarCommandRegistration {
                name: "product.settings".into(),
            },
            SidecarCommandRegistration {
                name: "product.status".into(),
            },
        ],
        max_concurrency: 2,
        max_input_bytes: 1_024,
        max_output_bytes: 1_024,
        default_timeout_ms: 1_000,
        max_timeout_ms: 5_000,
        result_grace_ms: 50,
    };
    let configure = supervisor_exchange
        .start(&mut supervisor_channel, &configuration)
        .unwrap();
    runtime_exchange
        .receive(&mut runtime_channel, &configure)
        .unwrap()
        .unwrap();
    let manifest = runtime_exchange.validated_manifest().unwrap().clone();
    let configured = runtime_exchange
        .acknowledge(&mut runtime_channel, &manifest)
        .unwrap();
    runtime_exchange
        .complete_acknowledgement(&mut runtime_channel)
        .unwrap();
    supervisor_exchange
        .receive(&mut supervisor_channel, &configured)
        .unwrap();

    let bridge =
        SidecarRuntimeBridge::activate(&mut runtime_exchange, &mut runtime_channel, adapter)
            .unwrap();
    (bridge, runtime_channel)
}

fn sidecar_channel(role: SidecarPeerRole) -> AuthenticatedSidecarChannel {
    AuthenticatedSidecarChannel::new(
        role,
        "authority-session".into(),
        1,
        SidecarSessionKey::from_bytes([0x55; 32]),
        4_096,
    )
    .unwrap()
}

fn sidecar_offer(role: SidecarPeerRole) -> SidecarProtocolOffer {
    SidecarProtocolOffer {
        protocol_major: SIDECAR_PROTOCOL_MAJOR,
        protocol_minor: SIDECAR_PROTOCOL_MINOR,
        peer: SidecarPeerIdentity {
            role,
            name: match role {
                SidecarPeerRole::Supervisor => "test-supervisor",
                SidecarPeerRole::Runtime => "test-runtime",
            }
            .into(),
            version: "test".into(),
            artifact_identity: "sha256:test-only".into(),
        },
        feature_bits: 0,
        limits: SidecarLimits {
            max_frame_bytes: 4_096,
            max_in_flight: 4,
            bootstrap_timeout_ms: 1_000,
        },
    }
}

#[tokio::test]
async fn node_protocol_fallback_uses_fresh_legacy_connect_material_and_recovers_to_v4() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut current, current_connect) =
            accept_node_connect(&listener, "nonce-v4", 1_700_000_000_123).await;
        assert_current_connect(&current_connect, "nonce-v4");
        send_json(
            &mut current,
            json!({
                "type":"res", "id":current_connect["id"], "ok":false,
                "error":{
                    "code":"INVALID_REQUEST",
                    "message":"protocol mismatch",
                    "details":{"expectedProtocol":3}
                }
            }),
        )
        .await;

        let (mut legacy, legacy_connect) =
            accept_node_connect(&listener, "nonce-v3", 1_700_000_000_456).await;
        assert_legacy_connect(&legacy_connect, "nonce-v3");
        assert_ne!(
            current_connect["params"]["device"]["signature"],
            legacy_connect["params"]["device"]["signature"]
        );
        send_json(
            &mut legacy,
            json!({
                "type":"res", "id":legacy_connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":3}
            }),
        )
        .await;
        send_json(
            &mut legacy,
            json!({
                "type":"event", "event":"node.invoke.request",
                "payload":{
                    "id":"invoke-v3",
                    "nodeId":"node-1",
                    "command":"example.status",
                    "paramsJSON":"{\"verbose\":true}"
                }
            }),
        )
        .await;
        while let Some(Ok(message)) = legacy.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }

        let (mut upgraded, upgraded_connect) =
            accept_node_connect(&listener, "nonce-v4-again", 1_700_000_000_789).await;
        assert_current_connect(&upgraded_connect, "nonce-v4-again");
        send_json(
            &mut upgraded,
            json!({
                "type":"res", "id":upgraded_connect["id"], "ok":true,
                "payload":{"type":"hello-ok","protocol":4}
            }),
        )
        .await;
    });

    let connect = || {
        NodeClient::connect(
            NodeClientConfig::new(format!("ws://{address}")),
            |_challenge| async move {
                Ok::<_, std::io::Error>(
                    NodeConnectOptions::new("test", "macos")
                        .device_family("Mac")
                        .command("example.status")
                        .activate()
                        .identity(openclaw_node_host::NodeIdentity::from_secret_bytes([7; 32])),
                )
            },
        )
    };
    let legacy = connect().await.unwrap();
    assert_eq!(legacy.protocol(), NodeProtocolVersion::V3);
    assert_eq!(
        legacy.next_invocation().await.unwrap().params,
        json!({"verbose":true})
    );
    legacy.close().await;

    let current = connect().await.unwrap();
    assert_eq!(current.protocol(), NodeProtocolVersion::V4);
    current.close().await;
    server.await.unwrap();
}

#[tokio::test]
async fn duplex_runtime_routes_ordered_input_and_progress() {
    let fixture = lifecycle_fixture();
    let server_fixture = fixture.clone();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(serve_duplex_runtime(listener, server_fixture));

    let runtime = CommandRuntime::builder()
        .capability("example")
        .duplex_command("example.duplex", |context| async move {
            let io = context.io.expect("duplex command I/O");
            let first = io.recv().await.expect("first input");
            let second = io.recv().await.expect("second input");
            let output = format!("{}é", "a".repeat(16 * 1024 - 1));
            io.emit_chunk(&output).await.unwrap();
            Ok(json!({"input":[first, second]}))
        })
        .build()
        .unwrap();
    let connect_runtime = runtime.clone();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |challenge| {
            let connect_runtime = connect_runtime.clone();
            let signing_key = signing_key.clone();
            async move {
                let options = connect_runtime.activate(
                    NodeConnectOptions::new("test", "linux").auth(ConnectAuth::token("test-token")),
                );
                let request = options.external_signing_request(public_key, &challenge)?;
                let signature = signing_key.sign(request.payload().as_bytes());
                Ok::<_, openclaw_node_host::IdentityError>(
                    options.device(request.finish(signature.to_bytes())?),
                )
            }
        },
    )
    .await
    .unwrap();

    assert!(runtime.run(session).await.is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn duplex_input_overflow_forces_a_terminal_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({"type":"event","event":"connect.challenge","payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event","event":"node.invoke.request","payload":{
                "id":"overflow","nodeId":"node-1","command":"example.duplex","paramsJSON":null
            }}),
        )
        .await;
        for seq in 0..5 {
            send_json(
                &mut socket,
                json!({"type":"event","event":"node.invoke.input","payload":{
                    "id":"overflow","nodeId":"node-1","seq":seq,
                    "payloadJSON":"x".repeat(16 * 1024)
                }}),
            )
            .await;
        }
        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["ok"], false);
        assert_eq!(result["params"]["error"]["code"], "INPUT_BUFFER_OVERFLOW");
        acknowledge(&mut socket, &result).await;
        socket.close(None).await.unwrap();
    });

    let runtime = CommandRuntime::builder()
        .duplex_command("example.duplex", |_context| async move {
            std::future::pending().await
        })
        .build()
        .unwrap();
    let session = connect_with_command(address, "example.duplex").await;

    assert!(runtime.run(session).await.is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn direct_dispatch_rejects_duplex_without_running_an_event_loop() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut socket = accept_async(tcp).await.unwrap();
        send_json(
            &mut socket,
            json!({"type":"event","event":"connect.challenge","payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
        )
        .await;
        let connect = receive_json(&mut socket).await;
        send_json(
            &mut socket,
            json!({"type":"res","id":connect["id"],"ok":true,
                "payload":{"type":"hello-ok","protocol":4}}),
        )
        .await;
        send_json(
            &mut socket,
            json!({"type":"event","event":"node.invoke.request",
                "payload":{"id":"invoke-1","nodeId":"node-1","command":"example.duplex"}}),
        )
        .await;
        let result = receive_json(&mut socket).await;
        assert_eq!(result["method"], "node.invoke.result");
        assert_eq!(result["params"]["ok"], false);
        assert_eq!(result["params"]["error"]["code"], "DUPLEX_REQUIRES_RUN");
        send_json(
            &mut socket,
            json!({"type":"res","id":result["id"],"ok":true,"payload":{"accepted":true}}),
        )
        .await;
    });

    let runtime = CommandRuntime::builder()
        .duplex_command("example.duplex", |_context| async { Ok(Value::Null) })
        .build()
        .unwrap();
    let connect_runtime = runtime.clone();
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let public_key = signing_key.verifying_key().to_bytes();
    let session = NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |challenge| {
            let connect_runtime = connect_runtime.clone();
            let signing_key = signing_key.clone();
            async move {
                let options = connect_runtime.activate(
                    NodeConnectOptions::new("test", "linux").auth(ConnectAuth::token("test-token")),
                );
                let request = options.external_signing_request(public_key, &challenge)?;
                let signature = signing_key.sign(request.payload().as_bytes());
                Ok::<_, openclaw_node_host::IdentityError>(
                    options.device(request.finish(signature.to_bytes())?),
                )
            }
        },
    )
    .await
    .unwrap();
    let invocation = session.next_invocation().await.unwrap();
    runtime.dispatch(&session, invocation).await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn runtime_enforces_the_manifest_of_each_connection() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let first_entered = Arc::new(tokio::sync::Notify::new());
    let server_entered = Arc::clone(&first_entered);
    let server = tokio::spawn(async move {
        for (attempt, (advertised, denied)) in [
            ("example.first", "example.second"),
            ("example.second", "example.first"),
        ]
        .into_iter()
        .enumerate()
        {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({"type":"event","event":"connect.challenge",
                    "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
            )
            .await;
            let connect = receive_json(&mut socket).await;
            assert_eq!(connect["params"]["commands"], json!([advertised]));
            send_json(
                &mut socket,
                json!({"type":"res","id":connect["id"],"ok":true,
                    "payload":{"type":"hello-ok","protocol":4}}),
            )
            .await;

            for (id, command) in [("denied", denied), ("allowed", advertised)] {
                send_json(
                    &mut socket,
                    json!({"type":"event","event":"node.invoke.request",
                        "payload":{"id":id,"nodeId":"node-1","command":command}}),
                )
                .await;
                if attempt == 0 && id == "allowed" {
                    server_entered.notified().await;
                    break;
                }
                let result = receive_json(&mut socket).await;
                assert_eq!(result["method"], "node.invoke.result");
                if id == "denied" {
                    assert_eq!(result["params"]["ok"], false);
                    assert_eq!(result["params"]["error"]["code"], "COMMAND_NOT_ADVERTISED");
                } else {
                    assert_eq!(result["params"]["payload"], json!({"command":command}));
                }
                send_json(
                    &mut socket,
                    json!({"type":"res","id":result["id"],"ok":true,
                        "payload":{"accepted":true}}),
                )
                .await;
            }
            socket.close(None).await.unwrap();
        }
    });

    let first_cancelled = Arc::new(tokio::sync::Notify::new());
    let handler_entered = Arc::clone(&first_entered);
    let handler_cancelled = Arc::clone(&first_cancelled);
    let runtime = CommandRuntime::builder()
        .command("example.first", move |context| {
            let entered = Arc::clone(&handler_entered);
            let cancelled = Arc::clone(&handler_cancelled);
            async move {
                let cancellation = context.cancellation.clone();
                tokio::spawn(async move {
                    cancellation.cancelled().await;
                    cancelled.notify_one();
                });
                entered.notify_one();
                std::future::pending().await
            }
        })
        .command("example.second", |context| async move {
            Ok(json!({"command":context.invocation.command}))
        })
        .build()
        .unwrap();
    for (attempt, advertised) in ["example.first", "example.second"].into_iter().enumerate() {
        let session = connect_with_command(address, advertised).await;
        assert!(runtime.run(session).await.is_err());
        if attempt == 0 {
            tokio::time::timeout(Duration::from_secs(1), first_cancelled.notified())
                .await
                .expect("retired connection cancelled its active handler");
        }
    }
    server.await.unwrap();
}

async fn connect_with_command(
    address: std::net::SocketAddr,
    advertised: &'static str,
) -> NodeSession {
    NodeClient::connect(
        NodeClientConfig::new(format!("ws://{address}")),
        move |challenge| async move {
            let signing_key = SigningKey::from_bytes(&[7; 32]);
            let options = NodeConnectOptions::new("test", "linux")
                .command(advertised)
                .activate()
                .auth(ConnectAuth::token("test-token"));
            let request = options
                .external_signing_request(signing_key.verifying_key().to_bytes(), &challenge)?;
            let signature = signing_key.sign(request.payload().as_bytes());
            Ok::<_, openclaw_node_host::IdentityError>(
                options.device(request.finish(signature.to_bytes())?),
            )
        },
    )
    .await
    .unwrap()
}

async fn serve_duplex_runtime(listener: TcpListener, fixture: Value) {
    let (tcp, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(tcp).await.unwrap();
    send_json(
        &mut socket,
        json!({"type":"event", "event":"connect.challenge",
            "payload":{"nonce":"node-nonce","ts":1_700_000_000_123_u64}}),
    )
    .await;
    let connect = receive_json(&mut socket).await;
    assert_example_connect_surface(&connect);
    send_json(
        &mut socket,
        json!({"type":"res", "id":connect["id"], "ok":true,
            "payload":{"type":"hello-ok","protocol":4}}),
    )
    .await;
    send_json(
        &mut socket,
        json!({"type":"event", "event":"node.invoke.request",
            "payload":fixture["request"]["canonical"]}),
    )
    .await;
    let inputs = fixture["input"]["canonical"]
        .as_array()
        .expect("canonical input array");
    for payload in [
        inputs[0].clone(),
        json!({"id":"invoke-1","nodeId":"wrong-node","seq":1,"payloadJSON":"wrong"}),
        json!({"id":"invoke-1","nodeId":"node-1","seq":0,"payloadJSON":"duplicate"}),
        inputs[1].clone(),
    ] {
        send_json(
            &mut socket,
            json!({"type":"event", "event":"node.invoke.input", "payload":payload}),
        )
        .await;
    }

    let first = receive_json(&mut socket).await;
    assert_eq!(first["method"], "node.invoke.progress");
    assert_eq!(first["params"]["seq"], 0);
    assert_eq!(
        first["params"]["chunk"].as_str().unwrap().len(),
        16 * 1024 - 1
    );
    acknowledge(&mut socket, &first).await;

    let second = receive_json(&mut socket).await;
    assert_eq!(second["method"], "node.invoke.progress");
    assert_eq!(second["params"], fixture["progress"]["canonical"]);
    acknowledge(&mut socket, &second).await;

    let result = receive_json(&mut socket).await;
    assert_eq!(result["method"], "node.invoke.result");
    assert_eq!(result["params"], fixture["results"]["success"]);
    send_json(
        &mut socket,
        json!({"type":"res", "id":result["id"], "ok":true,
            "payload":{"accepted":true}}),
    )
    .await;
}

async fn acknowledge<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, request: &Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    send_json(
        socket,
        json!({"type":"res", "id":request["id"], "ok":true, "payload":{"ok":true}}),
    )
    .await;
}

async fn send_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>, value: Value)
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    socket
        .send(Message::Text(value.to_string().into()))
        .await
        .unwrap();
}

async fn accept_node_connect(
    listener: &TcpListener,
    nonce: &str,
    timestamp: u64,
) -> (
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    Value,
) {
    let (tcp, _) = listener.accept().await.unwrap();
    let mut socket = accept_async(tcp).await.unwrap();
    send_json(
        &mut socket,
        json!({
            "type":"event", "event":"connect.challenge",
            "payload":{"nonce":nonce,"ts":timestamp}
        }),
    )
    .await;
    let connect = receive_json(&mut socket).await;
    (socket, connect)
}

fn assert_current_connect(connect: &Value, nonce: &str) {
    assert_eq!(connect["params"]["minProtocol"], 4);
    assert_eq!(connect["params"]["maxProtocol"], 4);
    assert_eq!(connect["params"]["client"]["platform"], "macos");
    assert_eq!(connect["params"]["client"]["deviceFamily"], "Mac");
    assert_eq!(connect["params"]["device"]["nonce"], nonce);
}

fn assert_legacy_connect(connect: &Value, nonce: &str) {
    assert_eq!(connect["params"]["minProtocol"], 3);
    assert_eq!(connect["params"]["maxProtocol"], 3);
    assert_eq!(connect["params"]["client"]["platform"], "darwin");
    assert!(connect["params"]["client"].get("deviceFamily").is_none());
    assert!(connect["params"]["client"].get("modelIdentifier").is_none());
    assert_eq!(connect["params"]["device"]["nonce"], nonce);
}

async fn receive_json<S>(socket: &mut tokio_tungstenite::WebSocketStream<S>) -> Value
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let message = socket.next().await.unwrap().unwrap();
    serde_json::from_str(message.into_text().unwrap().as_str()).unwrap()
}

fn assert_example_connect_surface(connect: &Value) {
    assert_eq!(connect["params"]["caps"], json!(["example"]));
    assert_eq!(connect["params"]["commands"], json!(["example.duplex"]));
}

fn lifecycle_fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/node-invoke-lifecycle-contract.json"
    ))
    .expect("valid node invocation lifecycle fixture")
}

#[tokio::test]
async fn native_signed_connect_preserves_product_fields_and_rejects_invalid_node_manifests() {
    let signed = json!({"minProtocol":4,"maxProtocol":4,"role":"node","scopes":[],
        "client":{"id":"openclaw-macos","mode":"node","platform":"macOS","version":"test"},
        "commands":["system.notify","computer.act"],"computerUse":{"test":"native-authority"},
        "device":{"id":"native-device","signature":"unchanged-signature","nonce":"native-nonce"},
        "auth":{"token":"fixture-token"}});
    for invalid in [
        None,
        Some("omitted"),
        Some("empty"),
        Some("role"),
        Some("mode"),
        Some("protocol"),
        Some("duplicate"),
        Some("command"),
    ] {
        let mut params = signed.clone();
        let rejected = !matches!(invalid, None | Some("omitted" | "empty"));
        match invalid {
            Some("omitted") => {
                params.as_object_mut().unwrap().remove("commands");
            }
            Some("empty") => params["commands"] = json!([]),
            Some("role") => params["role"] = json!("operator"),
            Some("mode") => params["client"]["mode"] = json!("operator"),
            Some("protocol") => params["maxProtocol"] = json!(5),
            Some("duplicate") => params["commands"] = json!(["system.notify", "system.notify"]),
            Some("command") => params["commands"] = json!(["system.notify "]),
            _ => {}
        }
        let expected = params.clone();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            let mut socket = accept_async(tcp).await.unwrap();
            send_json(
                &mut socket,
                json!({"type":"event","event":"connect.challenge",
                "payload":{"nonce":"native-nonce","ts":1}}),
            )
            .await;
            if rejected {
                let next = socket.next().await;
                assert!(
                    !matches!(next, Some(Ok(Message::Text(_)))),
                    "invalid manifest was sent to Gateway"
                );
            } else {
                let connect = receive_json(&mut socket).await;
                assert_eq!(connect["params"], expected);
                send_json(
                    &mut socket,
                    json!({"type":"res","id":connect["id"],"ok":true,
                    "payload":{"type":"hello-ok","protocol":4}}),
                )
                .await;
            }
        });
        let connected = NodeClient::connect_signed(
            openclaw_gateway_client::GatewayClientConfig::new(format!("ws://{address}")).unwrap(),
            move |challenge| async move {
                assert_eq!(challenge.nonce, "native-nonce");
                Ok::<_, io::Error>(params)
            },
        )
        .await;
        if rejected {
            assert!(connected.is_err());
        } else {
            let session = connected.unwrap();
            let expected_commands = if invalid.is_none() {
                vec!["computer.act", "system.notify"]
            } else {
                vec![]
            };
            assert_eq!(
                session.command_names().collect::<Vec<_>>(),
                expected_commands
            );
        }
        server.await.unwrap();
    }
}
