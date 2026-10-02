//! macOS owns this executable, its inherited pipes, and credential selection.
//! The shared crates own Gateway sessions, invocation scheduling, and authenticated IPC framing.

mod transport;

use openclaw_gateway_client::{json_encoded_len, Event, GatewayClientConfig};
use openclaw_node_host::{
    read_sidecar_frame, write_sidecar_frame, write_sidecar_frame_parts,
    AuthenticatedSidecarChannel, ClientError, CommandRuntime, HandlerError, InvocationContext,
    InvocationIo, NodeClient, SidecarHandshake, SidecarLimits, SidecarPeerIdentity,
    SidecarPeerRole, SidecarProtocolOffer, SidecarSessionKey,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, error::Error, os::fd::AsFd, sync::Arc, time::Duration};
use tokio::{
    io::AsyncReadExt,
    sync::{mpsc, oneshot, Mutex, OwnedSemaphorePermit, Semaphore},
    task::JoinSet,
};

const GATEWAY_PAYLOAD_LIMIT: usize = 25 * 1024 * 1024;
// Keep the negotiated ceiling for existing JSON/native-result envelopes unchanged.
// Private transport records use the original bounded Gateway bytes without base64.
const FRAME_LIMIT: u32 = (GATEWAY_PAYLOAD_LIMIT.div_ceil(3) * 4 + 4096) as u32;
const MAX_IN_FLIGHT: u16 = 64;
// Per-direction retained IPC bytes, separate from caller/runtime payloads and JSON
// allocation overhead. Count limits and the acknowledged native relay stay independent.
const RETAINED_MESSAGE_BYTES: usize = 128 * 1024 * 1024;
type RetainedMessage<T> = (T, OwnedSemaphorePermit);

fn retain_message<T>(
    value: T,
    length: usize,
    budget: &Arc<Semaphore>,
) -> Result<RetainedMessage<T>, T> {
    let permit = u32::try_from(length)
        .ok()
        .and_then(|length| Arc::clone(budget).try_acquire_many_owned(length).ok());
    match permit {
        Some(permit) => Ok((value, permit)),
        None => Err(value),
    }
}

#[derive(Clone)]
struct SupervisorOutput {
    sender: mpsc::Sender<RetainedMessage<Value>>,
    bytes: Arc<Semaphore>,
    failed: tokio::sync::watch::Sender<bool>,
}

impl SupervisorOutput {
    fn new() -> (Self, mpsc::Receiver<RetainedMessage<Value>>) {
        let (sender, receiver) = mpsc::channel(usize::from(MAX_IN_FLIGHT));
        (
            Self {
                sender,
                bytes: Arc::new(Semaphore::new(RETAINED_MESSAGE_BYTES)),
                failed: tokio::sync::watch::channel(false).0,
            },
            receiver,
        )
    }

    fn retain(&self, value: Value) -> Result<RetainedMessage<Value>, Value> {
        let retained = match json_encoded_len(&value, RETAINED_MESSAGE_BYTES) {
            Some(length) => retain_message(value, length, &self.bytes),
            None => Err(value),
        };
        if retained.is_err() {
            self.failed.send_replace(true);
        }
        retained
    }

    async fn send(&self, value: Value) -> Result<(), mpsc::error::SendError<Value>> {
        // Byte admission never waits holding an uncharged Value. Existing count
        // backpressure may suspend only after its payload has acquired byte credit.
        let retained = self.retain(value).map_err(mpsc::error::SendError)?;
        self.sender
            .send(retained)
            .await
            .map_err(|error| mpsc::error::SendError(error.0 .0))
    }

    fn try_send(&self, value: Value) -> Result<(), mpsc::error::TrySendError<Value>> {
        let retained = self
            .retain(value)
            .map_err(mpsc::error::TrySendError::Full)?;
        self.sender.try_send(retained).map_err(|error| match error {
            mpsc::error::TrySendError::Full((value, _)) => mpsc::error::TrySendError::Full(value),
            mpsc::error::TrySendError::Closed((value, _)) => {
                mpsc::error::TrySendError::Closed(value)
            }
        })
    }
}
const NATIVE_RELAY: u64 = 1;
const INDEPENDENT_PONG: u64 = 2;
const BINARY_GATEWAY_WRITES: u64 = 4;
const NATIVE_RESULT_TUPLES: u64 = 16;
const OPAQUE_TRANSPORT: u64 = 64;
// Require the current product contract before any Gateway effect. Retired
// base64 transport tuples (bit 8) are no longer offered or accepted.
const NATIVE_TRANSPORT_FEATURE: u64 = NATIVE_RELAY
    | INDEPENDENT_PONG
    | BINARY_GATEWAY_WRITES
    | NATIVE_RESULT_TUPLES
    | OPAQUE_TRANSPORT;
const BOOTSTRAP_TIMEOUT: Duration = Duration::from_secs(10);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
type Failure = Box<dyn Error + Send + Sync>;
type RequestResult = (Option<String>, Result<(), mpsc::error::SendError<Value>>);
type RequestHandles = HashMap<String, (tokio::task::AbortHandle, RequestKind)>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum RequestKind {
    Application,
    Progress,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
enum SupervisorMessage {
    Open {
        url: String,
        #[serde(default, rename = "privateCommands")]
        private_commands: Vec<String>,
    },
    Frame {
        frame: Request,
        #[serde(default, rename = "callerOwnsLifetime")]
        caller_owns_lifetime: bool,
    },
    #[serde(skip)]
    NativeResult {
        frame: Request,
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
    #[serde(skip)]
    TransportFrame {
        kind: u8,
        data: std::ops::Range<usize>,
    },
    TransportSent {
        id: u64,
        ok: bool,
    },
    TransportPong {
        id: u64,
        ok: bool,
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

fn decode_native_result(payload: &[u8]) -> serde_json::Result<Option<SupervisorMessage>> {
    if payload.iter().find(|byte| !byte.is_ascii_whitespace()) != Some(&b'[') {
        return Ok(None);
    }
    let (kind, mut frame, raw): (String, Request, &serde_json::value::RawValue) =
        serde_json::from_slice(payload)?;
    if kind != "native-result"
        || frame.kind != "req"
        || frame.method != "node.invoke.result"
        || frame.params["ok"] != true
        || frame.params.get("payloadJSON").is_some()
    {
        return Err(serde::de::Error::custom("invalid native result metadata"));
    }
    // RawValue borrows the last tuple element without copying its escaped JSON.
    // A separate Value parse preserves standalone payloadJSON depth, number,
    // Unicode and duplicate-key semantics; RawValue alone does not validate them.
    frame.params["payload"] = serde_json::from_str(raw.get())?;
    Ok(Some(SupervisorMessage::NativeResult { frame }))
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
    // Foundation supplies anonymous pipes. Reactor-owned descriptors avoid stdio's
    // blocking-worker buffers and let session retirement cancel pending I/O.
    let mut input = tokio::net::unix::pipe::Receiver::from_owned_fd(
        std::io::stdin().as_fd().try_clone_to_owned()?,
    )?;
    let mut output = tokio::net::unix::pipe::Sender::from_owned_fd(
        std::io::stdout().as_fd().try_clone_to_owned()?,
    )?;
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
    // Bootstrap frames and peer metadata are needed only until acceptance commits.
    // Release them before the active session can suspend indefinitely.
    let (frame_limit, max_in_flight) = {
        let mut handshake = SidecarHandshake::with_required_features(
            SidecarProtocolOffer {
                protocol_major: 1,
                protocol_minor: 0,
                peer: SidecarPeerIdentity {
                    role: SidecarPeerRole::Runtime,
                    name: "openclaw-mac-node-sidecar".into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                    artifact_identity: "bundled-macos-sidecar".into(),
                },
                feature_bits: NATIVE_TRANSPORT_FEATURE,
                limits: SidecarLimits {
                    max_frame_bytes: FRAME_LIMIT,
                    max_in_flight: MAX_IN_FLIGHT,
                    bootstrap_timeout_ms: 10_000,
                },
            },
            NATIVE_TRANSPORT_FEATURE,
        )?;
        let offer = read_sidecar_frame(&mut input, FRAME_LIMIT, BOOTSTRAP_TIMEOUT).await?;
        let accept = handshake
            .receive(&mut channel, &offer)?
            .ok_or("missing acceptance")?;
        write_sidecar_frame(&mut output, &accept, FRAME_LIMIT, WRITE_TIMEOUT).await?;
        handshake.complete_acceptance(&mut channel)?;
        let negotiated = handshake.negotiated().ok_or("missing negotiated limits")?;
        (channel.max_frame_bytes(), negotiated.limits.max_in_flight)
    };
    let channel = Arc::new(Mutex::new(channel));
    // Application and progress tasks each own max_in_flight slots; their bursts
    // must fit without blocking transport receipts on the reader task.
    let (incoming_tx, incoming) =
        mpsc::channel::<RetainedMessage<SupervisorMessage>>(usize::from(max_in_flight) * 2);
    let incoming_bytes = Arc::new(Semaphore::new(RETAINED_MESSAGE_BYTES));
    let (transport_outgoing, mut transport_writes) = mpsc::channel(1);
    let (transport_receipts, mut receipt_writes) = mpsc::channel(1);
    let (transport, transport_input) =
        transport::NativeTransport::new(transport_outgoing, transport_receipts);
    let reader_channel = Arc::clone(&channel);
    let reader = async move {
        loop {
            // Idle suspension has no deadline; after the first byte, the canonical
            // reader gives the remaining prefix and body one shared frame deadline.
            let mut first = [0];
            if input.read(&mut first).await? == 0 {
                return Ok::<(), Failure>(());
            }
            let mut frame = read_sidecar_frame(
                &mut std::io::Cursor::new(first).chain(&mut input),
                frame_limit,
                WRITE_TIMEOUT,
            )
            .await?;
            // The shared reader bounds allocation before body I/O; lengths 1–64
            // can hold only 64 bytes and the same deadline, never authenticated work.
            if frame.len() < 65 {
                return Err::<(), Failure>("invalid frame length".into());
            }
            let message = reader_channel
                .lock()
                .await
                .open_reusing_with_opaque::<SupervisorMessage>(
                    &mut frame,
                    transport::TRANSPORT_DOMAIN,
                    decode_native_result,
                    |payload, range| {
                        let (kind, data) = transport::decode_record(payload, range)?;
                        Ok(SupervisorMessage::TransportFrame { kind, data })
                    },
                )?;
            match message {
                SupervisorMessage::TransportFrame { kind, data } => {
                    // Transfer the authenticated input allocation to the Gateway receive owner.
                    // The next IPC read cannot mutate or retain this message's storage.
                    transport_input.receive(kind, bytes::Bytes::from(frame).slice(data))?
                }
                SupervisorMessage::TransportSent { id, ok } => {
                    transport_input.acknowledge(id, ok)?
                }
                SupervisorMessage::TransportPong { id, ok } => transport_input.pong(id, ok)?,
                // Never block transport receipts behind application traffic; saturation closes
                // this connection instead of deadlocking both inherited pipes.
                message => {
                    // Authentication and decoding own at most one additional frame.
                    // Reserve before retaining it in the queue; never wait on the IPC reader.
                    let retained = retain_message(message, frame.len(), &incoming_bytes)
                        .map_err(|_| "supervisor queue byte limit")?;
                    incoming_tx
                        .try_send(retained)
                        .map_err(|_| "supervisor queue full or closed")?;
                }
            }
        }
    };
    let (outgoing, mut outgoing_rx) = SupervisorOutput::new();
    let writer_channel = Arc::clone(&channel);
    let mut writer = tokio::spawn(async move {
        // Each JSON control owns its buffer through one write, so an idle writer
        // cannot retain a prior large frame. Transport writes borrow Gateway bytes.
        loop {
            let mut frame = Vec::new();
            let _retained = tokio::select! {
                Some((value, permit)) = outgoing_rx.recv() => {
                    writer_channel.lock().await.seal_into(&value, &mut frame)?;
                    Some(permit)
                },
                Some(value) = transport_writes.recv() => {
                    let (metadata, body) = value.payload_parts();
                    let (header, tag) = writer_channel.lock().await
                        .seal_opaque_parts(transport::TRANSPORT_DOMAIN, &[&metadata, body])?;
                    write_sidecar_frame_parts(
                        &mut output, &[&header, &metadata, body, &tag], frame_limit, WRITE_TIMEOUT,
                    ).await?;
                    continue;
                },
                Some(value) = receipt_writes.recv() => {
                    writer_channel.lock().await.seal_into(&value, &mut frame)?;
                    None
                },
                else => break,
            };
            // The dequeued frame still owns its credit until the physical write ends.
            write_sidecar_frame(&mut output, &frame, frame_limit, WRITE_TIMEOUT).await?;
        }
        Ok::<(), Failure>(())
    });
    // Own the reader future here: a framing failure must not become a graceful
    // queue EOF before its error is observed. Either pipe can retire the session.
    let (mut result, drain_writer) = tokio::select! {
        result = reader => {
            // Invalid input has no terminal message to flush; retire a blocked writer now.
            let drain_writer = result.is_ok();
            (result, drain_writer)
        },
        result = run_gateway(incoming, &outgoing, max_in_flight, transport) => (result, true),
        completed = &mut writer => (
            completed
                .unwrap_or_else(|error| Err(error.into()))
                .and(Err("authenticated sidecar output stopped".into())),
            false,
        ),
    };
    drop(outgoing);
    if drain_writer {
        // Await output before exit so an authenticated terminal error is not lost.
        let flushed = match tokio::time::timeout(WRITE_TIMEOUT, &mut writer).await {
            Ok(completed) => completed.unwrap_or_else(|error| Err(error.into())),
            Err(error) => Err(error.into()),
        };
        result = result.and(flushed);
    }
    writer.abort();
    channel.lock().await.retire();
    result
}

async fn run_gateway(
    mut incoming: mpsc::Receiver<RetainedMessage<SupervisorMessage>>,
    outgoing: &SupervisorOutput,
    max_in_flight: u16,
    transport: transport::NativeTransport,
) -> Result<(), Failure> {
    let Some((
        SupervisorMessage::Open {
            url,
            private_commands,
        },
        _,
    )) = incoming.recv().await
    else {
        return Err("expected Gateway configuration".into());
    };
    let incoming = Arc::new(Mutex::new(incoming));
    let config = GatewayClientConfig::new(url)?
        .max_message_bytes(GATEWAY_PAYLOAD_LIMIT)
        .connector(Arc::new(transport::NativeConnector::new(transport)));
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
        let Some((SupervisorMessage::Frame { frame, .. }, _)) =
            incoming_ref.lock().await.recv().await
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
    let mut native_failed = outgoing.failed.subscribe();
    let native = Arc::new(NativeHandlers {
        outgoing: outgoing.clone(),
        results: std::sync::Mutex::new(HashMap::new()),
        admissions: std::sync::Mutex::new(HashMap::new()),
        failed: outgoing.failed.clone(),
    });
    let mut builder = CommandRuntime::builder()
        .max_concurrency(usize::from(max_in_flight))
        .max_input_bytes(GATEWAY_PAYLOAD_LIMIT)
        .max_output_bytes(GATEWAY_PAYLOAD_LIMIT)
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
                    let id = context.invocation.id;
                    let command = context.invocation.command;
                    async move { native.admit(&id, &command).await }
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
    let mut registered_private = std::collections::HashSet::new();
    for name in private_commands {
        if session.command_names().any(|public| public == name)
            || !registered_private.insert(name.clone())
        {
            return Err("duplicate private command registration".into());
        }
        let admission = Arc::clone(&native);
        let handler = Arc::clone(&native);
        builder = builder.private_duplex_command(
            name,
            move |context| {
                let native = Arc::clone(&admission);
                let id = context.invocation.id;
                let command = context.invocation.command;
                async move { native.admit(&id, &command).await }
            },
            move |context| {
                let native = Arc::clone(&handler);
                async move { native.invoke(context).await }
            },
        );
    }
    drop(registered_private);
    let runtime = builder.build()?;
    let runtime_session = session.clone();
    let mut runtime_task = tokio::spawn(async move { runtime.run(runtime_session).await });
    let _runtime_lifetime = AbortTaskOnDrop(runtime_task.abort_handle());
    let mut requests = JoinSet::new();
    let mut controls = JoinSet::new();
    let mut request_handles = RequestHandles::new();
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
            message = async {
                incoming.lock().await.recv().await.map(|(message, _)| message)
            } => {
                // Completed tasks still occupy JoinSet capacity until joined.
                while let Some(completed) = requests.try_join_next() {
                    finish_request(completed, &mut request_handles)?;
                }
                while let Some(completed) = controls.try_join_next() {
                    finish_request(completed, &mut request_handles)?;
                }
                match message {
                    Some(SupervisorMessage::NativeResult { frame }) => {
                        native.complete(frame.params).await?;
                    }
                    Some(SupervisorMessage::Frame { frame, caller_owns_lifetime }) if frame.kind == "req" && frame.method != "connect" => {
                        if frame.method == "node.invoke.result" {
                            native.complete(frame.params).await?;
                            // Swift's node owner sends a completion; it does not await an RPC response.
                            // CommandRuntime owns the actual Gateway result and delivery failure.
                            continue;
                        }
                        // Progress belongs to active native invocations, not the unrelated app
                        // RPC budget. Both task classes remain independently bounded.
                        let kind = if frame.method == "node.invoke.progress" { RequestKind::Progress } else { RequestKind::Application };
                        if request_handles.values().filter(|(_, active)| *active == kind).count() >= usize::from(max_in_flight) || request_handles.contains_key(&frame.id) {
                            return Err("request capacity or identity conflict".into());
                        }
                        let session = session.clone();
                        let outgoing = outgoing.clone();
                        let native = Arc::clone(&native);
                        let id = frame.id.clone();
                        let handle = requests.spawn(async move {
                            let result = if kind == RequestKind::Progress {
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
                        request_handles.insert(id, (handle, kind));
                    }
                    Some(SupervisorMessage::CancelRequest { id }) => {
                        if let Some((handle, _)) = request_handles.get(&id) {
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
            _ = native_failed.changed() => return Err("native delivery saturated".into()),
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
    handles: &mut RequestHandles,
) -> Result<(), Failure> {
    match completed {
        Ok((id, result)) => {
            if let Some(id) = id {
                handles.remove(&id);
            }
            result?;
        }
        Err(error) if error.is_cancelled() => {
            handles.retain(|_, (handle, _)| handle.id() != error.id());
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

struct NativeHandlers {
    outgoing: SupervisorOutput,
    results: std::sync::Mutex<HashMap<String, NativeInvocation>>,
    admissions: std::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>,
    failed: tokio::sync::watch::Sender<bool>,
}

struct NativeInvocation {
    reply: oneshot::Sender<Result<Option<Value>, HandlerError>>,
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

    async fn invoke(
        self: &Arc<Self>,
        context: InvocationContext,
    ) -> Result<Option<Value>, HandlerError> {
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
        let request = json!({"type":"frame","frame": {
            "type":"event","event":"node.invoke.request","payload":{
                "id":invocation.id,"nodeId":invocation.node_id,"command":invocation.command,
                "paramsJSON":invocation.received_params_json(),"timeoutMs":invocation.timeout_ms,
                "sessionKey":invocation.session_key,"idempotencyKey":invocation.idempotency_key
            }
        }});
        let (id, node_id) = (invocation.id.clone(), invocation.node_id.clone());
        // The queued request owns its raw JSON; pending native work needs only IDs.
        drop(invocation);
        self.outgoing
            .send(request)
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
                            "id":id,"nodeId":node_id,"seq":input_seq,"payloadJSON":payload
                        }
                    }})).await.map_err(|_| HandlerError::new("UNAVAILABLE", "native supervisor disconnected"))?;
                    input_seq += 1;
                }
            }
        };
        outcome
    }

    async fn complete(&self, mut params: Value) -> Result<(), Failure> {
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
                Ok(Some(serde_json::from_str(raw)?))
            } else {
                Ok(params
                    .as_object_mut()
                    .and_then(|fields| fields.remove("payload")))
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
    fn opaque_transport_requires_matching_peers_before_active_effects() {
        use openclaw_node_host::{SidecarHandshakeError, SidecarHandshakeState};
        let offer = |role, bits| SidecarProtocolOffer {
            protocol_major: 1,
            protocol_minor: 0,
            peer: SidecarPeerIdentity {
                role,
                name: "test".into(),
                version: "1".into(),
                artifact_identity: "test".into(),
            },
            feature_bits: bits,
            limits: SidecarLimits {
                max_frame_bytes: FRAME_LIMIT,
                max_in_flight: MAX_IN_FLIGHT,
                bootstrap_timeout_ms: 10_000,
            },
        };
        let channel = |role| {
            AuthenticatedSidecarChannel::new(
                role,
                "negotiation".into(),
                7,
                SidecarSessionKey::from_bytes([0x5a; 32]),
                FRAME_LIMIT,
            )
            .unwrap()
        };
        for (supervisor_bits, runtime_bits) in [
            (31, NATIVE_TRANSPORT_FEATURE),
            (NATIVE_TRANSPORT_FEATURE, 31),
            (63, NATIVE_TRANSPORT_FEATURE),
            (NATIVE_TRANSPORT_FEATURE, 63),
            (95, NATIVE_TRANSPORT_FEATURE),
            (NATIVE_TRANSPORT_FEATURE, 95),
        ] {
            let mut supervisor = SidecarHandshake::with_required_features(
                offer(SidecarPeerRole::Supervisor, supervisor_bits),
                supervisor_bits,
            )
            .unwrap();
            let mut runtime = SidecarHandshake::with_required_features(
                offer(SidecarPeerRole::Runtime, runtime_bits),
                runtime_bits,
            )
            .unwrap();
            let mut supervisor_channel = channel(SidecarPeerRole::Supervisor);
            let mut runtime_channel = channel(SidecarPeerRole::Runtime);
            let first = supervisor.start(&mut supervisor_channel).unwrap();
            let (error, failed, retired) = match runtime.receive(&mut runtime_channel, &first) {
                Err(error) => (error, runtime.state(), runtime_channel.is_retired()),
                Ok(Some(acceptance)) => {
                    runtime.complete_acceptance(&mut runtime_channel).unwrap();
                    (
                        supervisor
                            .receive(&mut supervisor_channel, &acceptance)
                            .unwrap_err(),
                        supervisor.state(),
                        supervisor_channel.is_retired(),
                    )
                }
                _ => panic!("missing acceptance"),
            };
            assert!(matches!(
                error,
                SidecarHandshakeError::RequiredFeaturesUnavailable { .. }
            ));
            assert_eq!(failed, SidecarHandshakeState::Failed);
            assert!(retired);
        }
        assert!(serde_json::from_value::<SupervisorMessage>(json!({
            "type":"transport-frame", "kind":"binary", "data":"AA=="
        }))
        .is_err());
    }

    fn native_result_bytes(raw: &str) -> Vec<u8> {
        format!(r#"["native-result",{{"type":"req","id":"request-1","method":"node.invoke.result","params":{{"id":"invoke-1","nodeId":"node-1","ok":true,"payload":{{"ignored":true}}}}}},{raw}]"#).into_bytes()
    }

    #[test]
    fn native_result_preserves_standalone_json_semantics() {
        let mut values = vec![
            r#"{"z":1,"a":2,"z":3}"#.to_owned(),
            r#"[null,true,false,-0,1e2,18446744073709551616,"é🦀\n\\\"\uD83E\uDD80"]"#.to_owned(),
            "null".into(),
            "1e999".into(),
            r#""\ud800""#.into(),
            r#""\udc00""#.into(),
            "01".into(),
            "true false".into(),
        ];
        for depth in [126, 127, 128, 129] {
            values.push(format!("{}null{}", "[".repeat(depth), "]".repeat(depth)));
        }
        for raw in values {
            let expected = serde_json::from_str::<Value>(&raw);
            let decoded = decode_native_result(&native_result_bytes(&raw));
            match expected {
                Ok(expected) => {
                    let Some(SupervisorMessage::NativeResult { frame }) = decoded.unwrap() else {
                        panic!("expected native result")
                    };
                    assert_eq!(frame.params["payload"], expected, "{raw}");
                    assert_eq!(frame.params["id"], "invoke-1");
                    assert_eq!(frame.params["nodeId"], "node-1");
                }
                Err(_) => assert!(decoded.is_err(), "accepted invalid standalone JSON: {raw}"),
            }
        }
    }

    #[test]
    fn native_result_rejects_metadata_and_structural_injection() {
        let valid = String::from_utf8(native_result_bytes("null")).unwrap();
        assert!(matches!(
            decode_native_result(
                valid
                    .replace("native-result", "\\u006eative-result")
                    .as_bytes()
            ),
            Ok(Some(SupervisorMessage::NativeResult { .. }))
        ));
        for invalid in [
            valid.replace("native-result", "transport-send"),
            valid.replace("\"req\"", "\"res\""),
            valid.replace("node.invoke.result", "connect"),
            valid.replace("\"ok\":true", "\"ok\":false"),
            valid.replace("\"ok\":true", "\"ok\":true,\"payloadJSON\":\"null\""),
            valid.replace("\"type\":\"req\"", "\"type\":\"req\",\"extra\":0"),
            valid.replace(",null]", "]"),
            valid.replace(",null]", ",null,0]"),
            format!("{valid} {{}}"),
            String::from_utf8(native_result_bytes("null],{\"ok\":false}")).unwrap(),
        ] {
            assert!(
                decode_native_result(invalid.as_bytes()).is_err(),
                "accepted {invalid}"
            );
        }
        assert!(decode_native_result(br#"{"type":"ping","id":"one"}"#)
            .unwrap()
            .is_none());
        assert!(serde_json::from_slice::<SupervisorMessage>(
            br#"{"type":"native-result","frame":{}}"#
        )
        .is_err());
    }

    #[tokio::test]
    async fn native_result_moves_large_payload_to_matching_invocation() {
        let media = "x".repeat(GATEWAY_PAYLOAD_LIMIT - 4096);
        let raw = format!(r#"{{"media":"{media}"}}"#);
        let Some(SupervisorMessage::NativeResult { frame }) =
            decode_native_result(&native_result_bytes(&raw)).unwrap()
        else {
            panic!("expected native result")
        };
        let allocation = frame.params["payload"]["media"].as_str().unwrap().as_ptr();
        let (outgoing, _) = SupervisorOutput::new();
        let native = NativeHandlers {
            outgoing,
            results: std::sync::Mutex::new(HashMap::new()),
            admissions: std::sync::Mutex::new(HashMap::new()),
            failed: tokio::sync::watch::channel(false).0,
        };
        let (reply, receiver) = oneshot::channel();
        native.results.lock().unwrap().insert(
            "invoke-1".into(),
            NativeInvocation {
                reply,
                io: None,
                node_id: "node-1".into(),
            },
        );
        native.complete(frame.params).await.unwrap();
        let result = receiver.await.unwrap().unwrap().unwrap();
        assert_eq!(result["media"].as_str().unwrap(), media);
        assert_eq!(result["media"].as_str().unwrap().as_ptr(), allocation);
        assert!(native.results.lock().unwrap().is_empty());

        let (reply, receiver) = oneshot::channel();
        native.results.lock().unwrap().insert(
            "invoke-1".into(),
            NativeInvocation {
                reply,
                io: None,
                node_id: "another-node".into(),
            },
        );
        assert!(native
            .complete(json!({"id":"invoke-1","nodeId":"node-1","ok":true,"payload":null}))
            .await
            .is_err());
        assert!(receiver.await.is_err());
    }

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
    // JSON CPU time does not consume the in-memory protocol's virtual deadlines.
    #[tokio::test(start_paused = true)]
    async fn native_invoke_backlog_retires_before_six_large_requests_are_retained() {
        async fn deliver_with_progress(
            input: &transport::NativeTransportInput,
            writes: &mut mpsc::Receiver<transport::TransportWrite>,
            receipts: &mut mpsc::Receiver<Value>,
            pending: &mut std::collections::VecDeque<(bytes::Bytes, bool)>,
            invocation: bytes::Bytes,
        ) -> Result<(), &'static str> {
            pending.push_back((invocation, true));
            while let Some((frame, is_invocation)) = pending.pop_front() {
                input
                    .receive(1, frame)
                    .map_err(|_| "peer delivery rejected")?;
                loop {
                    tokio::select! {
                        receipt = receipts.recv() => {
                            let receipt = receipt.ok_or("delivery receipt missing")?;
                            if receipt["type"] != "transport-received" {
                                return Err("unexpected delivery receipt");
                            }
                            break;
                        }
                        write = writes.recv() => {
                            let write = write.ok_or("Gateway writer closed")?;
                            let (metadata, body) = write.payload_parts();
                            if !matches!(metadata[0], 1 | 2) { return Err("unexpected Gateway control"); }
                            let request: Value = serde_json::from_slice(body)
                                .map_err(|_| "invalid Gateway request")?;
                            if request["type"] != "req" || request["id"].as_str().is_none() {
                                return Err("invalid Gateway request identity");
                            }
                            match request["method"].as_str() {
                                Some("node.invoke.progress") => {
                                    let index = request["params"]["invokeId"].as_str()
                                        .and_then(|id| id.strip_prefix("hold-"))
                                        .and_then(|index| index.parse::<usize>().ok());
                                    if index.is_none_or(|index| index >= 6)
                                        || request["params"]["nodeId"] != "node-1"
                                        || request["params"]["chunk"] != ""
                                        || request["params"]["seq"].as_u64().is_none()
                                    { return Err("unexpected invocation heartbeat"); }
                                }
                                Some("node.invoke.result") if request["params"]["id"] == "hold-5"
                                    && request["params"]["nodeId"] == "node-1"
                                    && request["params"]["ok"] == false
                                    && request["params"]["error"]["code"] == "UNAVAILABLE" => {}
                                _ => return Err("unexpected Gateway method"),
                            }
                            input.acknowledge(u64::from_be_bytes(metadata[1..].try_into().unwrap()), true)
                                .map_err(|_| "Gateway write acknowledgement rejected")?;
                            pending.push_back((bytes::Bytes::from(json!({
                                "type":"res", "id":request["id"], "ok":true, "payload":{}
                            }).to_string()), false));
                        }
                    }
                }
                if is_invocation {
                    return Ok(());
                }
            }
            Err("invocation delivery missing")
        }
        // Prepare immutable peer bytes before timing runtime work. This exercises retention
        // behavior; these fixture allocations are not a process-memory measurement.
        let frames: Vec<_> = (0..6u8)
            .map(|index| {
                let raw =
                    json!({"data": char::from(b'a' + index).to_string().repeat(24 * 1024 * 1024)})
                        .to_string();
                let frame = json!({"type":"event", "event":"node.invoke.request", "payload":{
                    "id":format!("hold-{index}"), "nodeId":"node-1", "command":"benchmark.hold",
                    "paramsJSON":raw, "timeoutMs":0
                }})
                .to_string();
                assert!(frame.len() < GATEWAY_PAYLOAD_LIMIT);
                bytes::Bytes::from(frame)
            })
            .collect();
        let (incoming, incoming_rx) = mpsc::channel(128);
        let (outgoing, mut queued) = SupervisorOutput::new();
        let input_bytes = Arc::new(Semaphore::new(RETAINED_MESSAGE_BYTES));
        let (transport_outgoing, mut writes) = mpsc::channel(1);
        let (transport_receipts, mut receipts) = mpsc::channel(1);
        let (transport, native_input) =
            transport::NativeTransport::new(transport_outgoing, transport_receipts);
        let mut task = tokio::spawn(async move {
            run_gateway(incoming_rx, &outgoing, MAX_IN_FLIGHT, transport).await
        });
        let _abort = AbortTaskOnDrop(task.abort_handle());
        let mut step = "open".to_owned();
        let mut peer_responses = std::collections::VecDeque::new();
        let observed = tokio::time::timeout(Duration::from_secs(10), async {
            incoming.send(retain_message(SupervisorMessage::Open {
                url: "ws://127.0.0.1:1".into(), private_commands: Vec::new(),
            }, 1024, &input_bytes).map_err(|_| "open budget rejected")?).await.map_err(|_| "open rejected")?;
            native_input.receive(1, bytes::Bytes::from(json!({
                "type":"event", "event":"connect.challenge", "payload":{"nonce":"fixture", "ts":1}
            }).to_string())).map_err(|_| "challenge rejected")?;
            step = "challenge receipt".into();
            receipts.recv().await.ok_or("challenge receipt missing")?;
            step = "native challenge".into();
            let (challenge, _) = queued.recv().await.ok_or("native challenge missing")?;
            if challenge["frame"]["event"] != "connect.challenge" { return Err("wrong challenge"); }
            incoming.send(retain_message(SupervisorMessage::Frame {
                frame: Request { kind:"req".into(), id:"connect-1".into(), method:"connect".into(),
                    params:json!({"role":"node", "client":{"mode":"node"}, "minProtocol":4,
                        "maxProtocol":4, "commands":["benchmark.hold"]}) },
                caller_owns_lifetime:false,
            }, 1024, &input_bytes).map_err(|_| "connect budget rejected")?).await.map_err(|_| "signed connect rejected")?;
            step = "Gateway connect".into();
            let connect = writes.recv().await.ok_or("Gateway connect missing")?;
            let (metadata, body) = connect.payload_parts();
            let connect: Value = serde_json::from_slice(body).map_err(|_| "invalid Gateway connect")?;
            native_input.acknowledge(u64::from_be_bytes(metadata[1..].try_into().unwrap()), true)
                .map_err(|_| "connect acknowledgement rejected")?;
            native_input.receive(1, bytes::Bytes::from(json!({
                "type":"res", "id":connect["id"], "ok":true, "payload":{"type":"hello-ok","protocol":4}
            }).to_string())).map_err(|_| "hello rejected")?;
            step = "hello receipt".into();
            receipts.recv().await.ok_or("hello receipt missing")?;
            step = "native hello".into();
            let (hello, _) = queued.recv().await.ok_or("native hello missing")?;
            if hello["frame"]["ok"] != true { return Err("native hello failed"); }
            for (index, frame) in frames.into_iter().enumerate() {
                step = format!("invocation {index} receipt");
                // Real duplex heartbeats share this socket; acknowledge writes and serialize
                // their responses behind the outstanding frame's actual receive receipt.
                deliver_with_progress(
                    &native_input, &mut writes, &mut receipts, &mut peer_responses,
                    frame,
                ).await?;
                step = format!("invocation {index} forwarding");
                while queued.len() < index + 1 && !task.is_finished() {
                    // A stalled owner must let the existing virtual timeout advance.
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                if index < 5 && task.is_finished() { return Err("valid backlog retired early"); }
            }
            Ok::<_, &'static str>(())
        }).await;
        // Budget failure must retire the real run, not merely return a handler error.
        let retired = tokio::time::timeout(Duration::from_secs(1), &mut task).await;
        drop(native_input);
        let retired = match retired {
            Ok(result) => matches!(result, Ok(Err(_))),
            Err(_) => {
                task.abort();
                let _ = task.await;
                false
            }
        };
        let mut requests = Vec::new();
        while let Ok((frame, _)) = queued.try_recv() {
            if frame["frame"]["event"] == "node.invoke.request" {
                requests.push(frame["frame"]["payload"]["id"].as_str().unwrap().to_owned());
            }
        }
        drop(queued);
        observed
            .unwrap_or_else(|_| {
                panic!(
                    "fixture timed out at {step}; queued {} invocations",
                    requests.len()
                )
            })
            .expect("valid native flow");
        assert!(
            retired,
            "six distinct 24MiB native requests remained queued"
        );
        assert_eq!(
            requests,
            (0..5)
                .map(|index| format!("hold-{index}"))
                .collect::<Vec<_>>()
        );
    }
    #[tokio::test]
    async fn outgoing_count_wait_cancellation_and_dequeue_keep_byte_ownership() {
        let (outgoing, mut queued) = SupervisorOutput::new();
        for _ in 0..MAX_IN_FLIGHT {
            outgoing.send(Value::Null).await.unwrap();
        }
        let queued_bytes = usize::from(MAX_IN_FLIGHT) * 4;
        assert_eq!(
            outgoing.bytes.available_permits(),
            RETAINED_MESSAGE_BYTES - queued_bytes
        );
        {
            let mut cancelled = Box::pin(outgoing.send(json!("cancelled")));
            assert!(futures_util::poll!(cancelled.as_mut()).is_pending());
            assert_eq!(
                outgoing.bytes.available_permits(),
                RETAINED_MESSAGE_BYTES - queued_bytes - 11
            );
        }
        assert_eq!(
            outgoing.bytes.available_permits(),
            RETAINED_MESSAGE_BYTES - queued_bytes
        );

        let mut waiting = Box::pin(outgoing.send(json!("next")));
        assert!(futures_util::poll!(waiting.as_mut()).is_pending());
        let (value, retained) = queued.recv().await.unwrap();
        assert_eq!(value, Value::Null);
        assert!(matches!(
            futures_util::poll!(waiting.as_mut()),
            std::task::Poll::Ready(Ok(()))
        ));
        drop(waiting);
        drop(value);
        drop(queued);
        // Dequeue transfers credit to the consumer; dropping the channel must not refund it.
        assert_eq!(
            outgoing.bytes.available_permits(),
            RETAINED_MESSAGE_BYTES - 4
        );
        drop(retained);
        assert_eq!(outgoing.bytes.available_permits(), RETAINED_MESSAGE_BYTES);
        assert!(outgoing.send(Value::Null).await.is_err());
        assert!(outgoing.try_send(Value::Null).is_err());
        assert_eq!(outgoing.bytes.available_permits(), RETAINED_MESSAGE_BYTES);
        assert!(!*outgoing.failed.borrow());
    }
}
