//! macOS owns this executable, its inherited pipes, and credential selection.
//! The shared crates own Gateway sessions, invocation scheduling, and authenticated IPC framing.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use openclaw_gateway_client::{tls_trust, Event, GatewayClientConfig};
use openclaw_gateway_client::{TlsCertificatePolicy, TlsPeerCertificate};
use openclaw_node_host::{
    read_sidecar_frame, write_sidecar_frame, AuthenticatedSidecarChannel, ClientError,
    CommandRuntime, HandlerError, InvocationContext, InvocationIo, NodeClient, SidecarHandshake,
    SidecarLimits, SidecarPeerIdentity, SidecarPeerRole, SidecarProtocolOffer, SidecarSessionKey,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    error::Error,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, oneshot, Mutex},
    task::JoinSet,
};

const FRAME_LIMIT: u32 = 16 * 1024 * 1024;
const MAX_IN_FLIGHT: u16 = 64;
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
type Failure = Box<dyn Error + Send + Sync>;
type RequestResult = (Option<String>, Result<(), mpsc::error::SendError<Value>>);

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum SupervisorMessage {
    Open {
        url: String,
        fingerprint: Option<String>,
        headers: BTreeMap<String, String>,
        #[serde(default)]
        native_tls: bool,
    },
    Frame {
        frame: Request,
        #[serde(default, rename = "callerOwnsLifetime")]
        caller_owns_lifetime: bool,
    },
    CancelRequest {
        id: String,
    },
    Ping {
        id: String,
    },
    Admission {
        id: String,
        allowed: bool,
    },
    TlsDecision {
        allowed: bool,
    },
    Close,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    #[serde(rename = "type")]
    kind: String,
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    // Stderr is deliberately generic: Gateway errors can contain endpoint or auth data.
    if run().await.is_err() {
        eprintln!("macOS Rust sidecar stopped");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Failure> {
    if std::env::args_os().len() != 1 {
        return Err("sidecar accepts configuration only through its inherited pipe".into());
    }
    let mut input = tokio::io::stdin();
    let mut output = tokio::io::stdout();
    let mut bootstrap = [0u8; 56];
    tokio::time::timeout(BOOTSTRAP_TIMEOUT, input.read_exact(&mut bootstrap)).await??;
    let key = SidecarSessionKey::from_bytes(bootstrap[..32].try_into()?);
    let session_id = bootstrap[32..48]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let generation = u64::from_be_bytes(bootstrap[48..].try_into()?);
    bootstrap.fill(0);
    let mut channel = AuthenticatedSidecarChannel::new(
        SidecarPeerRole::Runtime,
        session_id,
        generation,
        key,
        FRAME_LIMIT,
    )?;
    let mut handshake = SidecarHandshake::new(SidecarProtocolOffer {
        protocol_major: 1,
        protocol_minor: 0,
        peer: SidecarPeerIdentity {
            role: SidecarPeerRole::Runtime,
            name: "openclaw-mac-node-sidecar".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            artifact_identity: "bundled-macos-sidecar".into(),
        },
        feature_bits: 0,
        limits: SidecarLimits {
            max_frame_bytes: FRAME_LIMIT,
            max_in_flight: MAX_IN_FLIGHT,
            bootstrap_timeout_ms: 10_000,
        },
    })?;
    let offer = read_sidecar_frame(&mut input, FRAME_LIMIT, BOOTSTRAP_TIMEOUT).await?;
    let accept = handshake
        .receive(&mut channel, &offer)?
        .ok_or("missing acceptance")?;
    write_sidecar_frame(&mut output, &accept, FRAME_LIMIT, WRITE_TIMEOUT).await?;
    handshake.complete_acceptance(&mut channel)?;
    let frame_limit = channel.max_frame_bytes();
    let max_in_flight = handshake
        .negotiated()
        .ok_or("missing negotiated limits")?
        .limits
        .max_in_flight;
    let channel = Arc::new(Mutex::new(channel));
    let (incoming_tx, incoming) = mpsc::channel::<SupervisorMessage>(usize::from(MAX_IN_FLIGHT));
    let reader_channel = Arc::clone(&channel);
    let reader = tokio::spawn(async move {
        loop {
            // No idle deadline: app suspension must not kill a healthy native session.
            let mut prefix = [0; 4];
            input.read_exact(&mut prefix).await?;
            let size = u32::from_be_bytes(prefix);
            if size > frame_limit || size < 65 {
                return Err::<(), Failure>("invalid frame length".into());
            }
            let mut frame = vec![0; size as usize];
            tokio::time::timeout(WRITE_TIMEOUT, input.read_exact(&mut frame)).await??;
            let message = reader_channel
                .lock()
                .await
                .open::<SupervisorMessage>(&frame)?;
            incoming_tx
                .send(message)
                .await
                .map_err(|_| "supervisor reader closed")?;
        }
    });
    let (outgoing, mut outgoing_rx) = mpsc::channel::<Value>(usize::from(MAX_IN_FLIGHT));
    let writer_channel = Arc::clone(&channel);
    let writer = tokio::spawn(async move {
        while let Some(value) = outgoing_rx.recv().await {
            let frame = writer_channel.lock().await.seal(&value)?;
            write_sidecar_frame(&mut output, &frame, frame_limit, WRITE_TIMEOUT).await?;
        }
        Ok::<(), Failure>(())
    });
    let result = run_gateway(incoming, &outgoing, max_in_flight).await;
    reader.abort();
    drop(outgoing);
    // Await output before exit so an authenticated terminal error is not lost.
    let _ = tokio::time::timeout(WRITE_TIMEOUT, writer).await;
    channel.lock().await.retire();
    result
}

async fn run_gateway(
    mut incoming: mpsc::Receiver<SupervisorMessage>,
    outgoing: &mpsc::Sender<Value>,
    max_in_flight: u16,
) -> Result<(), Failure> {
    let Some(SupervisorMessage::Open {
        url,
        fingerprint,
        headers,
        native_tls,
    }) = incoming.recv().await
    else {
        return Err("expected Gateway configuration".into());
    };
    let incoming = Arc::new(Mutex::new(incoming));
    let mut config = GatewayClientConfig::new(url)?.tls_trust(tls_trust(fingerprint.as_deref())?);
    if native_tls {
        config = config.tls_certificate_policy(Arc::new(NativeTlsPolicy {
            incoming: Arc::clone(&incoming),
            outgoing: outgoing.clone(),
        }));
    }
    for (name, value) in headers {
        config = config.header(&name, &value)?;
    }
    let mut connect_id = String::new();
    let connect_id_ref = &mut connect_id;
    let incoming_ref = Arc::clone(&incoming);
    let connection = NodeClient::connect_signed(config, |challenge| async move {
        outgoing
            .send(json!({"type":"frame", "frame": {
                "type":"event", "event":"connect.challenge",
                "payload":{"nonce":challenge.nonce,"ts":challenge.issued_at_ms}
            }}))
            .await
            .map_err(|_| "supervisor closed")?;
        let Some(SupervisorMessage::Frame { frame, .. }) = incoming_ref.lock().await.recv().await
        else {
            return Err("expected signed Gateway connect");
        };
        if frame.kind != "req" || frame.method != "connect" {
            return Err("expected signed Gateway connect");
        }
        *connect_id_ref = frame.id;
        Ok(frame.params)
    })
    .await;
    let (session, mut events) = match connection {
        Ok(session) => {
            // The current-thread executor guarantees the Gateway reader cannot advance
            // the retained event tail between connect returning and this subscription.
            let events = session.subscribe();
            outgoing
                .send(json!({"type":"frame", "frame": {
                    "type":"res","id":connect_id,"ok":true,"payload":session.hello()
                }}))
                .await?;
            (session, events)
        }
        Err(error) => {
            if connect_id.is_empty() {
                outgoing
                    .send(json!({"type":"failure","message":error.to_string()}))
                    .await?;
            } else {
                outgoing
                    .send(json!({"type":"frame","frame":response_error(&connect_id, error)}))
                    .await?;
            }
            return Ok(());
        }
    };
    let (native_failure, mut native_failed) = tokio::sync::watch::channel(false);
    let native = Arc::new(NativeHandlers {
        outgoing: outgoing.clone(),
        results: std::sync::Mutex::new(HashMap::new()),
        admissions: std::sync::Mutex::new(HashMap::new()),
        failed: native_failure,
    });
    let mut builder = CommandRuntime::builder()
        .max_concurrency(usize::from(max_in_flight))
        .max_input_bytes(FRAME_LIMIT as usize - 4096)
        .max_output_bytes(FRAME_LIMIT as usize - 4096)
        .max_timeout(Duration::from_millis(i32::MAX as u64))
        .result_grace(Duration::ZERO);
    for name in session.command_names() {
        let handler = Arc::clone(&native);
        if name.starts_with("system.") {
            let admission = Arc::clone(&native);
            builder = builder.system_duplex_command(
                name,
                move |context| {
                    let native = Arc::clone(&admission);
                    async move {
                        native
                            .admit(&context.invocation.id, &context.invocation.command)
                            .await
                    }
                },
                move |context| {
                    let native = Arc::clone(&handler);
                    async move { native.invoke(context).await }
                },
            );
        } else {
            builder = builder.duplex_command(name, move |context| {
                let native = Arc::clone(&handler);
                async move { native.invoke(context).await }
            });
        }
    }
    let runtime = builder.build()?;
    let runtime_session = session.clone();
    let mut runtime_task = tokio::spawn(async move { runtime.run(runtime_session).await });
    let _runtime_lifetime = AbortTaskOnDrop(runtime_task.abort_handle());
    let mut requests = JoinSet::new();
    let mut controls = JoinSet::new();
    let mut request_handles = HashMap::<String, tokio::task::AbortHandle>::new();
    loop {
        tokio::select! {
            event = events.recv() => {
                match event {
                    Ok(event) if !matches!(event.event.as_str(), "node.invoke.request" | "node.invoke.input" | "node.invoke.cancel") => {
                        outgoing.send(json!({"type":"frame","frame":event_frame(event)})).await?;
                    }
                    Ok(_) => {}
                    Err(error) => {
                        outgoing.send(json!({"type":"failure","message":error.to_string()})).await?;
                        break;
                    }
                }
            }
            message = async { incoming.lock().await.recv().await } => {
                // Completed tasks still occupy JoinSet capacity until joined.
                while let Some(completed) = requests.try_join_next() {
                    finish_request(completed, &mut request_handles)?;
                }
                while let Some(completed) = controls.try_join_next() {
                    finish_request(completed, &mut request_handles)?;
                }
                match message {
                    Some(SupervisorMessage::Frame { frame, caller_owns_lifetime }) if frame.kind == "req" && frame.method != "connect" => {
                        if frame.method == "node.invoke.result" {
                            native.complete(&frame.params).await?;
                            // Swift's node owner sends a completion; it does not await an RPC response.
                            // CommandRuntime owns the actual Gateway result and delivery failure.
                            continue;
                        }
                        if requests.len() >= usize::from(max_in_flight) || request_handles.contains_key(&frame.id) {
                            return Err("request capacity or identity conflict".into());
                        }
                        let session = session.clone();
                        let outgoing = outgoing.clone();
                        let native = Arc::clone(&native);
                        let id = frame.id.clone();
                        let handle = requests.spawn(async move {
                            let result = if frame.method == "node.invoke.progress" {
                                native.progress(&frame.params).await.map(|()| json!({}))
                            } else if caller_owns_lifetime {
                                session.request_until_cancelled(frame.method, frame.params).await
                            } else {
                                session.request(frame.method, frame.params).await
                            };
                            let response = match result {
                                Ok(payload) => json!({"type":"res","id":frame.id,"ok":true,"payload":payload}),
                                Err(error) => response_error(&frame.id, error),
                            };
                            (Some(frame.id), outgoing.send(json!({"type":"frame","frame":response})).await)
                        });
                        request_handles.insert(id, handle);
                    }
                    Some(SupervisorMessage::CancelRequest { id }) => {
                        if let Some(handle) = request_handles.get(&id) {
                            handle.abort();
                            // Retire the actual RPC future before admitting a replacement;
                            // removing its identity alone would leave its request permit alive.
                            while request_handles.contains_key(&id) {
                                finish_request(
                                    requests.join_next().await.ok_or("missing request task")?,
                                    &mut request_handles,
                                )?;
                            }
                        }
                    }
                    Some(SupervisorMessage::Ping { id }) => {
                        // Keepalive has its own bounded task and session capacity. It must
                        // remain available while every application RPC slot is occupied.
                        if !controls.is_empty() {
                            outgoing.send(json!({"type":"pong","id":id,"ok":false})).await?;
                            continue;
                        }
                        let session = session.clone();
                        let outgoing = outgoing.clone();
                        controls.spawn(async move {
                            let result = session.ping().await;
                            (None, outgoing.send(json!({"type":"pong","id":id,"ok":result.is_ok()})).await)
                        });
                    }
                    Some(SupervisorMessage::Admission { id, allowed }) => {
                        if let Some(reply) = native.admissions.lock().unwrap().remove(&id) { let _ = reply.send(allowed); }
                    }
                    Some(SupervisorMessage::Close) | None => break,
                    _ => return Err("unexpected supervisor message".into()),
                }
            }
            Some(completed) = requests.join_next(), if !requests.is_empty() => {
                finish_request(completed, &mut request_handles)?;
            }
            Some(completed) = controls.join_next(), if !controls.is_empty() => {
                finish_request(completed, &mut request_handles)?;
            }
            completed = &mut runtime_task => {
                completed??;
                break;
            }
            _ = native_failed.changed() => return Err("native cancellation delivery saturated".into()),
        }
    }
    requests.abort_all();
    controls.abort_all();
    session.close().await;
    runtime_task.abort();
    Ok(())
}

fn finish_request(
    completed: Result<RequestResult, tokio::task::JoinError>,
    handles: &mut HashMap<String, tokio::task::AbortHandle>,
) -> Result<(), Failure> {
    match completed {
        Ok((id, result)) => {
            if let Some(id) = id {
                handles.remove(&id);
            }
            result?;
        }
        Err(error) if error.is_cancelled() => {
            handles.retain(|_, handle| handle.id() != error.id());
        }
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

struct AbortTaskOnDrop(tokio::task::AbortHandle);
impl Drop for AbortTaskOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct NativeTlsPolicy {
    incoming: Arc<Mutex<mpsc::Receiver<SupervisorMessage>>>,
    outgoing: mpsc::Sender<Value>,
}

impl std::fmt::Debug for NativeTlsPolicy {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeTlsPolicy")
            .finish_non_exhaustive()
    }
}

impl TlsCertificatePolicy for NativeTlsPolicy {
    fn verify(
        &self,
        peer: TlsPeerCertificate,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send>> {
        let incoming = Arc::clone(&self.incoming);
        let outgoing = self.outgoing.clone();
        Box::pin(async move {
            outgoing.send(json!({"type":"tls-peer", "serverName":peer.server_name,
                "port":peer.port,"peerAddress":peer.peer_addr.to_string(),
                "certificateChain":peer.certificate_chain.iter().map(|der| STANDARD.encode(der)).collect::<Vec<_>>(),
                "ocspResponse":STANDARD.encode(peer.ocsp_response),
            })).await.map_err(|_| "native trust owner disconnected".to_owned())?;
            match incoming.lock().await.recv().await {
                Some(SupervisorMessage::TlsDecision { allowed: true }) => Ok(()),
                _ => Err("native TLS verification rejected this connection".into()),
            }
        })
    }
}

struct NativeHandlers {
    outgoing: mpsc::Sender<Value>,
    results: std::sync::Mutex<HashMap<String, NativeInvocation>>,
    admissions: std::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>,
    failed: tokio::sync::watch::Sender<bool>,
}

struct NativeInvocation {
    reply: oneshot::Sender<Result<Value, HandlerError>>,
    io: Option<InvocationIo>,
    node_id: String,
}

struct NativeCallLease {
    owner: Arc<NativeHandlers>,
    id: String,
}
impl Drop for NativeCallLease {
    fn drop(&mut self) {
        if let Some(call) = self.owner.results.lock().unwrap().remove(&self.id) {
            // Timeout, Gateway cancel, and disconnect all retire this one lease.
            // Completed results removed it already, so cancellation is never duplicated.
            if self
                .owner
                .outgoing
                .try_send(json!({"type":"frame","frame":{
                    "type":"event","event":"node.invoke.cancel","payload":{
                        "invokeId":self.id,"nodeId":call.node_id
                    }
                }}))
                .is_err()
            {
                self.owner.failed.send_replace(true);
            }
        }
        self.owner.admissions.lock().unwrap().remove(&self.id);
    }
}

impl NativeHandlers {
    async fn admit(self: &Arc<Self>, id: &str, command: &str) -> Result<(), HandlerError> {
        let _lease = NativeCallLease {
            owner: Arc::clone(self),
            id: id.to_owned(),
        };
        let (reply, receiver) = oneshot::channel();
        self.admissions.lock().unwrap().insert(id.to_owned(), reply);
        self.outgoing
            .send(json!({"type":"admit","id":id,"command":command}))
            .await
            .map_err(|_| HandlerError::new("UNAVAILABLE", "native supervisor disconnected"))?;
        match receiver.await {
            Ok(true) => Ok(()),
            _ => Err(HandlerError::new(
                "UNAVAILABLE",
                "native command admission denied",
            )),
        }
    }

    async fn invoke(self: &Arc<Self>, context: InvocationContext) -> Result<Value, HandlerError> {
        let invocation = context.invocation;
        let _lease = NativeCallLease {
            owner: Arc::clone(self),
            id: invocation.id.clone(),
        };
        let (reply, mut result) = oneshot::channel();
        self.results.lock().unwrap().insert(
            invocation.id.clone(),
            NativeInvocation {
                reply,
                io: context.io.clone(),
                node_id: invocation.node_id.clone(),
            },
        );
        self.outgoing
            .send(json!({"type":"frame","frame": {
                "type":"event","event":"node.invoke.request","payload":{
                    "id":invocation.id,"nodeId":invocation.node_id,"command":invocation.command,
                    "paramsJSON":invocation.received_params_json(),"timeoutMs":invocation.timeout_ms,
                    "sessionKey":invocation.session_key,"idempotencyKey":invocation.idempotency_key
                }
            }}))
            .await
            .map_err(|_| HandlerError::new("UNAVAILABLE", "native supervisor disconnected"))?;
        let mut input_seq = 0u64;
        let outcome = loop {
            tokio::select! {
                result = &mut result => break result.unwrap_or_else(|_| Err(HandlerError::new("UNAVAILABLE", "native invocation ended"))),
                () = context.cancellation.cancelled() => {
                    break Err(HandlerError::new("CANCELLED", "native invocation cancelled"));
                }
                payload = async {
                    match &context.io { Some(io) => io.recv().await, None => std::future::pending().await }
                } => {
                    let Some(payload) = payload else { break Err(HandlerError::new("CANCELLED", "invocation input retired")); };
                    self.outgoing.send(json!({"type":"frame","frame":{
                        "type":"event","event":"node.invoke.input","payload":{
                            "id":invocation.id,"nodeId":invocation.node_id,"seq":input_seq,"payloadJSON":payload
                        }
                    }})).await.map_err(|_| HandlerError::new("UNAVAILABLE", "native supervisor disconnected"))?;
                    input_seq += 1;
                }
            }
        };
        outcome
    }

    async fn complete(&self, params: &Value) -> Result<(), Failure> {
        let id = params["id"]
            .as_str()
            .ok_or("native result requires invocation id")?;
        let Some(call) = self.results.lock().unwrap().remove(id) else {
            return Ok(());
        };
        if params["nodeId"].as_str() != Some(call.node_id.as_str()) {
            return Err("native result node mismatch".into());
        }
        let outcome = if params["ok"] == true {
            if let Some(raw) = params["payloadJSON"].as_str() {
                Ok(serde_json::from_str(raw)?)
            } else {
                Ok(params["payload"].clone())
            }
        } else {
            Err(HandlerError::new(
                params["error"]["code"].as_str().unwrap_or("UNAVAILABLE"),
                params["error"]["message"]
                    .as_str()
                    .unwrap_or("native command failed"),
            ))
        };
        let _ = call.reply.send(outcome);
        Ok(())
    }

    async fn progress(&self, params: &Value) -> Result<(), ClientError> {
        let io = {
            let calls = self.results.lock().unwrap();
            let call = params["invokeId"]
                .as_str()
                .and_then(|id| calls.get(id))
                .filter(|call| params["nodeId"].as_str() == Some(call.node_id.as_str()))
                .ok_or_else(|| ClientError::Closed("native invocation retired".into()))?;
            call.io
                .clone()
                .ok_or_else(|| ClientError::InvalidFrame("non-duplex invocation".into()))?
        };
        let chunk = params["chunk"]
            .as_str()
            .ok_or_else(|| ClientError::InvalidFrame("progress requires chunk".into()))?;
        if chunk.is_empty() {
            io.heartbeat().await
        } else {
            io.emit_chunk(chunk).await
        }
    }
}

fn response_error(id: &str, error: ClientError) -> Value {
    let shape = match error {
        ClientError::Gateway {
            code,
            message,
            details,
            retryable,
            retry_after_ms,
            ..
        } => {
            json!({"code":code,"message":message,"details":details,"retryable":retryable,"retryAfterMs":retry_after_ms})
        }
        error => json!({"code":"UNAVAILABLE","message":error.to_string()}),
    };
    json!({"type":"res","id":id,"ok":false,"error":shape})
}

fn event_frame(event: Event) -> Value {
    let mut frame = json!({"type":"event","event":event.event,"payload":event.payload});
    if let Value::Object(fields) = &mut frame {
        if let Some(seq) = event.seq {
            fields.insert("seq".into(), json!(seq));
        }
        if let Some(state_version) = event.state_version {
            fields.insert("stateVersion".into(), state_version);
        }
        if let Some(recipient_profile_id) = event.recipient_profile_id {
            fields.insert("recipientProfileId".into(), json!(recipient_profile_id));
        }
    }
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_forwarding_preserves_sequence_numbers() {
        assert_eq!(
            event_frame(Event {
                event: "gateway.status".into(),
                payload: json!({"ready": true}),
                seq: Some(42),
                state_version: Some(json!({"presence": 7})),
                recipient_profile_id: Some("profile-1".into()),
            }),
            json!({"type":"event","event":"gateway.status","payload":{"ready":true},"seq":42,
                "stateVersion":{"presence":7},"recipientProfileId":"profile-1"})
        );
    }

    #[test]
    fn event_forwarding_omits_absent_sequence_numbers() {
        assert_eq!(
            event_frame(Event {
                event: "gateway.status".into(),
                payload: json!({"ready": true}),
                seq: None,
                state_version: None,
                recipient_profile_id: None,
            }),
            json!({"type":"event","event":"gateway.status","payload":{"ready":true}})
        );
    }
}
