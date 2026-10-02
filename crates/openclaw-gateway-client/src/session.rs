use futures_util::{future::poll_fn, SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    future::Future,
    net::IpAddr,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex as StdMutex,
    },
    time::Duration,
};
use thiserror::Error;
use tokio::sync::{mpsc, oneshot, watch, Mutex, Notify, Semaphore};
use tokio::time::Instant;
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::{HeaderName, HeaderValue},
    Bytes, Message,
};
#[cfg(feature = "builtin-transport")]
use tokio_tungstenite::{
    connect_async_tls_with_config, tungstenite::protocol::WebSocketConfig, Connector,
};

#[cfg(any(feature = "builtin-transport", test))]
use tokio_tungstenite::tungstenite::Error as TungsteniteError;
use url::{Host, Url};

#[cfg(feature = "builtin-transport")]
use crate::tls::{deferred_tls_config, pinned_tls_config, CapturedTlsCertificate};
use crate::transport::BoundedWebSocket;
#[cfg(any(feature = "builtin-transport", test))]
use crate::TlsPeerCertificate;
use crate::{GatewayWebSocket, GatewayWebSocketConnector, TlsCertificatePolicy, TlsTrust};

const DEFAULT_CHALLENGE_TIMEOUT: Duration = Duration::from_secs(15);
const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const DEFAULT_MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BUFFER_BYTES: usize = 64 * 1024 * 1024;

type DispatchGuard =
    Box<dyn for<'a> FnOnce(&mut DispatchContext<'a>) -> Result<(), DispatchRejection> + Send>;
type RequestEncoder = Box<dyn FnOnce(&str, &str) -> Result<Message, ClientError> + Send>;

#[derive(Clone, Debug)]
pub struct GatewayClientConfig {
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    connector: Option<Arc<dyn GatewayWebSocketConnector>>,
    tls_trust: TlsTrust,
    tls_certificate_policy: Option<Arc<dyn TlsCertificatePolicy>>,
    connect_timeout: Duration,
    challenge_timeout: Duration,
    request_timeout: Duration,
    write_timeout: Duration,
    max_message_bytes: usize,
    max_frame_bytes: usize,
    max_event_buffer_bytes: usize,
    event_capacity: usize,
    max_in_flight: usize,
}

impl GatewayClientConfig {
    /// Build a client configuration for a secure remote or loopback Gateway URL.
    pub fn new(gateway_url: impl AsRef<str>) -> Result<Self, ClientError> {
        validate_gateway_url(gateway_url.as_ref())?;
        let request = gateway_url
            .as_ref()
            .into_client_request()
            .map_err(|error| ClientError::InvalidUrl(error.to_string()))?;
        Ok(Self {
            request,
            connector: None,
            tls_trust: TlsTrust::SystemRoots,
            tls_certificate_policy: None,
            connect_timeout: DEFAULT_CONNECT_TIMEOUT,
            challenge_timeout: DEFAULT_CHALLENGE_TIMEOUT,
            request_timeout: DEFAULT_REQUEST_TIMEOUT,
            write_timeout: DEFAULT_WRITE_TIMEOUT,
            max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
            max_frame_bytes: DEFAULT_MAX_FRAME_BYTES,
            max_event_buffer_bytes: DEFAULT_MAX_EVENT_BUFFER_BYTES,
            event_capacity: 256,
            max_in_flight: 64,
        })
    }

    /// Use a product-owned WebSocket connection (for native proxy, DNS and TLS policy).
    /// The connector owns the actual handshake and must enforce the supplied message limit.
    #[must_use]
    pub fn connector(mut self, connector: Arc<dyn GatewayWebSocketConnector>) -> Self {
        self.connector = Some(connector);
        self
    }

    /// Add an HTTP header to the WebSocket upgrade request.
    pub fn header(mut self, name: &str, value: &str) -> Result<Self, ClientError> {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|error| ClientError::InvalidHeader(error.to_string()))?;
        let value = HeaderValue::from_str(value)
            .map_err(|error| ClientError::InvalidHeader(error.to_string()))?;
        self.request.headers_mut().insert(name, value);
        Ok(self)
    }

    #[must_use]
    pub fn tls_trust(mut self, trust: TlsTrust) -> Self {
        self.tls_trust = trust;
        self
    }

    /// Replace built-in CA/pin trust with an asynchronous product-owned TLS policy.
    /// The policy must approve the actual peer before the HTTP upgrade is written.
    #[must_use]
    pub fn tls_certificate_policy(mut self, policy: Arc<dyn TlsCertificatePolicy>) -> Self {
        self.tls_certificate_policy = Some(policy);
        self
    }

    #[must_use]
    pub fn connect_timeout(mut self, timeout: Duration) -> Self {
        self.connect_timeout = timeout;
        self
    }

    #[must_use]
    pub fn challenge_timeout(mut self, timeout: Duration) -> Self {
        self.challenge_timeout = timeout;
        self
    }

    #[must_use]
    pub fn request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    #[must_use]
    pub fn write_timeout(mut self, timeout: Duration) -> Self {
        self.write_timeout = timeout;
        self
    }

    #[must_use]
    pub fn max_message_bytes(mut self, bytes: usize) -> Self {
        self.max_message_bytes = bytes;
        self
    }

    #[must_use]
    pub fn max_frame_bytes(mut self, bytes: usize) -> Self {
        self.max_frame_bytes = bytes;
        self
    }

    #[must_use]
    pub fn max_event_buffer_bytes(mut self, bytes: usize) -> Self {
        self.max_event_buffer_bytes = bytes;
        self
    }

    #[must_use]
    pub fn event_capacity(mut self, capacity: usize) -> Self {
        self.event_capacity = capacity;
        self
    }

    /// Bound each RPC lane independently: application, delivery, and streaming.
    /// Keepalive has one additional slot, so at most `3 * maximum + 1` requests
    /// can be queued or awaiting responses across the session.
    #[must_use]
    pub fn max_in_flight(mut self, maximum: usize) -> Self {
        self.max_in_flight = maximum;
        self
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Event {
    pub event: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default)]
    pub seq: Option<u64>,
    #[serde(default, rename = "stateVersion")]
    pub state_version: Option<Value>,
    #[serde(default, rename = "recipientProfileId")]
    pub recipient_profile_id: Option<String>,
}

/// Reason a request was rejected by an application-owned pre-dispatch guard.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DispatchRejection {
    reason: String,
}

/// One-shot socket enqueue owned by the session task.
///
/// Application guards can hold their routing/ownership lock while calling
/// [`Self::enqueue`], making validation and wire enqueue one atomic operation
/// with respect to that lock.
pub struct DispatchContext<'a> {
    enqueue: &'a mut dyn FnMut(),
    enqueued: bool,
}

impl DispatchContext<'_> {
    pub fn enqueue(&mut self) {
        if !self.enqueued {
            (self.enqueue)();
            self.enqueued = true;
        }
    }
}

impl DispatchRejection {
    #[must_use]
    pub fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }

    #[must_use]
    pub fn reason(&self) -> &str {
        &self.reason
    }
}

/// Independent retained-event consumer that drains buffered events and then
/// reports the session's terminal close reason.
pub struct EventSubscription {
    events: Arc<EventHub>,
    cursor: u64,
    closed: watch::Receiver<Option<SessionCloseCause>>,
}

impl EventSubscription {
    pub async fn recv(&mut self) -> Result<Event, ClientError> {
        self.events.recv(&mut self.cursor, &mut self.closed).await
    }
}

impl Drop for EventSubscription {
    fn drop(&mut self) {
        let mut state = self
            .events
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.receivers -= 1;
        // A dropped or lagged receiver releases only the frames it has not consumed.
        for frame in state
            .frames
            .iter_mut()
            .filter(|frame| frame.index >= self.cursor)
        {
            frame.remaining -= 1;
        }
        state.trim_consumed();
    }
}

struct EventHub {
    state: StdMutex<EventHubState>,
    notify: Notify,
    capacity: usize,
    max_bytes: usize,
}

#[derive(Default)]
struct EventHubState {
    frames: VecDeque<RetainedEvent>,
    next_index: u64,
    retained_bytes: usize,
    receivers: usize,
    closed: bool,
}

impl EventHubState {
    fn remove_front(&mut self) {
        if let Some(frame) = self.frames.pop_front() {
            self.retained_bytes -= frame.raw.len();
        }
    }

    fn trim_consumed(&mut self) {
        while self
            .frames
            .front()
            .is_some_and(|frame| frame.remaining == 0)
        {
            self.remove_front();
        }
    }
}

struct RetainedEvent {
    index: u64,
    raw: Box<[u8]>,
    // Only readers present at publication own this frame; later subscriptions start at the tail.
    remaining: usize,
}

impl EventHub {
    fn new(capacity: usize, max_bytes: usize) -> Self {
        Self {
            state: StdMutex::new(EventHubState::default()),
            notify: Notify::new(),
            capacity: capacity.max(1),
            max_bytes: max_bytes.max(1),
        }
    }

    fn subscribe(
        self: &Arc<Self>,
        closed: watch::Receiver<Option<SessionCloseCause>>,
    ) -> EventSubscription {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.receivers += 1;
        EventSubscription {
            events: Arc::clone(self),
            cursor: state.next_index,
            closed,
        }
    }

    fn publish(&self, raw: Bytes) {
        // Reclaim unique input storage, but never retain a slice of a larger shared buffer.
        let raw = Vec::from(raw).into_boxed_slice();
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let index = state.next_index;
        state.next_index = state.next_index.wrapping_add(1);
        if raw.len() > self.max_bytes || state.receivers == 0 {
            drop(state);
            self.notify.notify_waiters();
            return;
        }
        while state.frames.len() >= self.capacity
            || state.retained_bytes.saturating_add(raw.len()) > self.max_bytes
        {
            state.remove_front();
        }
        state.retained_bytes += raw.len();
        let remaining = state.receivers;
        state.frames.push_back(RetainedEvent {
            index,
            raw,
            remaining,
        });
        drop(state);
        self.notify.notify_waiters();
    }

    fn close(&self) {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .closed = true;
        self.notify.notify_waiters();
    }

    async fn recv(
        &self,
        cursor: &mut u64,
        closed: &mut watch::Receiver<Option<SessionCloseCause>>,
    ) -> Result<Event, ClientError> {
        loop {
            let notified = self.notify.notified();
            let outcome = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let next = state.frames.iter_mut().find(|frame| frame.index >= *cursor);
                if let Some(frame) = next {
                    if frame.index > *cursor {
                        let lag = frame.index - *cursor;
                        *cursor = frame.index;
                        Some(Err(ClientError::EventLagged(lag)))
                    } else {
                        *cursor = cursor.wrapping_add(1);
                        frame.remaining -= 1;
                        let event = parse_retained_event(&frame.raw);
                        state.trim_consumed();
                        Some(event)
                    }
                } else if *cursor < state.next_index {
                    let lag = state.next_index - *cursor;
                    *cursor = state.next_index;
                    Some(Err(ClientError::EventLagged(lag)))
                } else if state.closed {
                    Some(Err(closed_event_error(closed)))
                } else {
                    None
                }
            };
            if let Some(outcome) = outcome {
                return outcome;
            }
            notified.await;
        }
    }
}

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("invalid Gateway URL: {0}")]
    InvalidUrl(String),
    #[error("invalid WebSocket request header: {0}")]
    InvalidHeader(String),
    #[error("plaintext WebSocket is allowed only for trusted local or private Gateways")]
    InsecureRemoteGateway,
    #[error("Gateway connection failed: {0}")]
    Transport(String),
    #[error("Gateway TLS connection failed: {0}")]
    Tls(String),
    #[error("Gateway connection timed out")]
    ConnectTimeout,
    #[error("Gateway connect challenge timed out")]
    ChallengeTimeout,
    #[error("Gateway connect challenge was invalid: {0}")]
    InvalidChallenge(String),
    #[error("connect parameter callback failed: {0}")]
    ConnectParams(String),
    #[error("Gateway rejected {method}: {code}: {message}")]
    Gateway {
        method: String,
        code: String,
        message: String,
        details: Option<Value>,
        retryable: Option<bool>,
        retry_after_ms: Option<u64>,
    },
    #[error("Gateway request timed out: {0}")]
    RequestTimeout(String),
    #[error("Gateway request exceeds the {maximum}-byte frame limit")]
    RequestTooLarge { maximum: usize },
    #[error("Gateway request dispatch rejected: {0}")]
    DispatchRejected(String),
    #[error("Gateway write timed out: {0}")]
    WriteTimeout(String),
    #[error("Gateway session is closed: {0}")]
    Closed(String),
    #[error("Gateway frame was invalid: {0}")]
    InvalidFrame(String),
    #[error("event consumer fell behind by {0} events")]
    EventLagged(u64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectChallenge {
    pub nonce: String,
    pub issued_at_ms: u64,
}

/// Identifies which bounded connect envelope a parameter callback must build.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectAttempt {
    /// The caller's current protocol envelope.
    Current,
    /// The one allowed fallback selected by a structured Gateway rejection.
    ProtocolFallback { expected_protocol: u32 },
}

pub struct GatewayClient;

impl GatewayClient {
    /// Connect after the Gateway supplies its nonce and signing timestamp.
    pub async fn connect<F, Fut, E>(
        config: GatewayClientConfig,
        make_params: F,
    ) -> Result<GatewaySession, ClientError>
    where
        F: FnOnce(ConnectChallenge) -> Fut,
        Fut: Future<Output = Result<Value, E>>,
        E: std::fmt::Display + Send + Sync + 'static,
    {
        connect_once(config, make_params).await
    }

    /// Connect with one bounded fallback for a structured protocol mismatch.
    ///
    /// A fallback is attempted only when the first `connect` response contains
    /// the requested `details.expectedProtocol` and either
    /// `details.code = "PROTOCOL_MISMATCH"` or a normalized protocol-mismatch
    /// message. The replacement connection obtains a fresh challenge and
    /// invokes `make_params` again.
    pub async fn connect_with_protocol_fallback<F, Fut, E>(
        config: GatewayClientConfig,
        expected_protocol: u32,
        mut make_params: F,
    ) -> Result<GatewaySession, ClientError>
    where
        F: FnMut(ConnectChallenge, ConnectAttempt) -> Fut,
        Fut: Future<Output = Result<Value, E>>,
        E: std::fmt::Display + Send + Sync + 'static,
    {
        let first = Box::pin(connect_once(config.clone(), |challenge| {
            make_params(challenge, ConnectAttempt::Current)
        }))
        .await;
        match first {
            Err(error) if is_expected_protocol_mismatch(&error, expected_protocol) => {
                Box::pin(connect_once(config, |challenge| {
                    make_params(
                        challenge,
                        ConnectAttempt::ProtocolFallback { expected_protocol },
                    )
                }))
                .await
            }
            result => result,
        }
    }
}

fn is_expected_protocol_mismatch(error: &ClientError, expected_protocol: u32) -> bool {
    let ClientError::Gateway {
        method,
        message,
        details,
        ..
    } = error
    else {
        return false;
    };
    if method != "connect" {
        return false;
    }
    let Some(details) = details.as_ref() else {
        return false;
    };
    let matches_expected_protocol = details.get("expectedProtocol").and_then(Value::as_u64)
        == Some(u64::from(expected_protocol));
    let matches_mismatch = details.get("code").and_then(Value::as_str) == Some("PROTOCOL_MISMATCH")
        || message.trim().to_lowercase().contains("protocol mismatch");
    matches_expected_protocol && matches_mismatch
}

async fn connect_once<F, Fut, E>(
    config: GatewayClientConfig,
    make_params: F,
) -> Result<GatewaySession, ClientError>
where
    F: FnOnce(ConnectChallenge) -> Fut,
    Fut: Future<Output = Result<Value, E>>,
    E: std::fmt::Display + Send + Sync + 'static,
{
    if config.connector.is_some()
        && (matches!(config.tls_trust, TlsTrust::Pinned(_))
            || config.tls_certificate_policy.is_some())
    {
        return Err(ClientError::Tls(
            "an injected WebSocket connector must own its TLS trust policy".into(),
        ));
    }
    if matches!(config.tls_trust, TlsTrust::Pinned(_))
        && config.request.uri().scheme_str() != Some("wss")
    {
        return Err(ClientError::Tls(
            "Gateway TLS fingerprint requires a wss:// URL".into(),
        ));
    }
    if config.tls_certificate_policy.is_some() && config.request.uri().scheme_str() != Some("wss") {
        return Err(ClientError::InvalidUrl(
            "Gateway TLS certificate policy requires a wss:// URL".into(),
        ));
    }
    let socket: Box<dyn GatewayWebSocket> = tokio::time::timeout(config.connect_timeout, async {
        if let Some(transport) = config.connector {
            transport
                .connect(config.request, config.max_message_bytes)
                .await
        } else {
            #[cfg(feature = "builtin-transport")]
            {
                connect_builtin(
                    config.request,
                    config.max_message_bytes,
                    config.max_frame_bytes,
                    config.tls_trust,
                    config.tls_certificate_policy,
                )
                .await
            }
            #[cfg(not(feature = "builtin-transport"))]
            {
                Err(ClientError::Transport(
                    "built-in Gateway transport is disabled; provide a WebSocket connector".into(),
                ))
            }
        }
    })
    .await
    .map_err(|_| ClientError::ConnectTimeout)??;

    let mut socket = BoundedWebSocket {
        inner: socket,
        maximum: config.max_message_bytes,
    };
    let challenge = tokio::time::timeout(
        config.challenge_timeout,
        wait_for_challenge(&mut socket, config.write_timeout),
    )
    .await
    .map_err(|_| ClientError::ChallengeTimeout)??;
    let params = make_params(challenge)
        .await
        .map_err(|error| ClientError::ConnectParams(error.to_string()))?;

    let connect_id = "rust-gateway-connect-1";
    send_request(
        &mut socket,
        connect_id,
        "connect",
        request_encoder(params, config.max_message_bytes),
        config.write_timeout,
        None,
    )
    .await?;
    let hello = tokio::time::timeout(
        config.request_timeout,
        wait_for_response(&mut socket, connect_id, "connect", config.write_timeout),
    )
    .await
    .map_err(|_| ClientError::RequestTimeout("connect".into()))??;

    // Keep requests and cancellations on one bounded, ordered stream so a
    // timeout cannot overtake its request. Each request carries its
    // semaphore permit through the session task, bounding queued and
    // pending requests even if the caller drops its future.
    // Preserve each lane's concurrency and one spare cancellation enqueue slot.
    let lane_capacity = config.max_in_flight.max(1);
    let command_capacity = lane_capacity.saturating_mul(3).saturating_add(1);
    let (command_tx, command_rx) = mpsc::channel(command_capacity);
    let (control_tx, control_rx) = mpsc::channel(1);
    let events = Arc::new(EventHub::new(
        config.event_capacity,
        config.max_event_buffer_bytes,
    ));
    let (activity_tx, activity_rx) = watch::channel(0_u64);
    let (closed_tx, closed_rx) = watch::channel(None);
    let (close_tx, close_rx) = watch::channel(false);
    // Register the shared default cursor before the reader can publish on another thread.
    let event_rx = Arc::new(Mutex::new(events.subscribe(closed_rx.clone())));
    tokio::spawn(run_session(
        socket,
        SessionChannels {
            commands: command_rx,
            controls: control_rx,
            events: Arc::clone(&events),
            activity: activity_tx,
            closed: closed_tx,
            close: close_rx,
        },
        SessionLimits {
            write_timeout: config.write_timeout,
        },
    ));

    Ok(GatewaySession {
        hello: Arc::new(hello),
        command_tx,
        control_tx,
        event_rx,
        events,
        activity_rx,
        closed_rx,
        close_tx,
        next_request_id: Arc::new(AtomicU64::new(1)),
        request_timeout: config.request_timeout,
        max_message_bytes: config.max_message_bytes,
        in_flight: Arc::new(Semaphore::new(lane_capacity)),
        control_in_flight: Arc::new(Semaphore::new(1)),
        delivery_in_flight: Arc::new(Semaphore::new(lane_capacity)),
        streaming_in_flight: Arc::new(Semaphore::new(lane_capacity)),
    })
}

#[cfg(feature = "builtin-transport")]
async fn connect_builtin(
    request: crate::WebSocketRequest<()>,
    max_message_bytes: usize,
    max_frame_bytes: usize,
    tls_trust: TlsTrust,
    tls_certificate_policy: Option<Arc<dyn TlsCertificatePolicy>>,
) -> Result<Box<dyn GatewayWebSocket>, ClientError> {
    let websocket_config = WebSocketConfig::default()
        .max_message_size(Some(max_message_bytes))
        .max_frame_size(Some(max_frame_bytes));
    let connector = match tls_trust {
        TlsTrust::SystemRoots => None,
        TlsTrust::Pinned(expected) => Some(Connector::Rustls(Arc::new(
            pinned_tls_config(expected).map_err(ClientError::Transport)?,
        ))),
    };
    let secure_endpoint = request.uri().scheme_str() == Some("wss");
    let (socket, _) = if let Some(policy) = tls_certificate_policy {
        connect_with_certificate_policy(request, websocket_config, policy).await?
    } else {
        connect_async_tls_with_config(request, Some(websocket_config), false, connector)
            .await
            .map_err(|error| classify_connect_error(error, secure_endpoint))?
    };
    Ok(Box::new(socket) as Box<dyn GatewayWebSocket>)
}

#[cfg(feature = "builtin-transport")]
async fn connect_with_certificate_policy(
    request: tokio_tungstenite::tungstenite::http::Request<()>,
    websocket_config: WebSocketConfig,
    policy: Arc<dyn TlsCertificatePolicy>,
) -> Result<
    (
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        tokio_tungstenite::tungstenite::handshake::client::Response,
    ),
    ClientError,
> {
    let host = request
        .uri()
        .host()
        .ok_or_else(|| ClientError::InvalidUrl("missing host".into()))?
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_owned();
    let port = request.uri().port_u16().unwrap_or(443);
    let server_name = rustls::pki_types::ServerName::try_from(host.clone())
        .map_err(|error| ClientError::Tls(error.to_string()))?;
    let tcp = tokio::net::TcpStream::connect((host.as_str(), port))
        .await
        .map_err(|error| ClientError::Transport(error.to_string()))?;
    let peer_addr = tcp
        .peer_addr()
        .map_err(|error| ClientError::Transport(error.to_string()))?;
    let captured = Arc::new(StdMutex::new(CapturedTlsCertificate::default()));
    let tls_config = deferred_tls_config(Arc::clone(&captured)).map_err(ClientError::Tls)?;
    let stream = tokio_rustls::TlsConnector::from(Arc::new(tls_config))
        .connect(server_name, tcp)
        .await
        .map_err(|error| ClientError::Tls(error.to_string()))?;
    let evidence = std::mem::take(
        &mut *captured
            .lock()
            .map_err(|_| ClientError::Tls("Gateway TLS evidence unavailable".into()))?,
    );
    if evidence.certificate_chain.is_empty() {
        return Err(ClientError::Tls(
            "Gateway TLS certificate unavailable".into(),
        ));
    }
    policy
        .verify(TlsPeerCertificate {
            server_name: host,
            port,
            peer_addr,
            certificate_chain: evidence.certificate_chain,
            ocsp_response: evidence.ocsp_response,
        })
        .await
        .map_err(ClientError::Tls)?;
    // This is the first application write on this exact TLS stream. Dropping the enclosing
    // connect future on policy rejection, timeout, or cancellation closes the connection.
    tokio_tungstenite::client_async_with_config(
        request,
        tokio_tungstenite::MaybeTlsStream::Rustls(stream),
        Some(websocket_config),
    )
    .await
    .map_err(|error| classify_connect_error(error, true))
}

#[derive(Clone, Copy)]
enum RequestLane {
    Application,
    Delivery,
    Streaming,
}

#[derive(Clone)]
pub struct GatewaySession {
    hello: Arc<Value>,
    command_tx: mpsc::Sender<SessionCommand>,
    control_tx: mpsc::Sender<SessionControl>,
    events: Arc<EventHub>,
    event_rx: Arc<Mutex<EventSubscription>>,
    activity_rx: watch::Receiver<u64>,
    closed_rx: watch::Receiver<Option<SessionCloseCause>>,
    close_tx: watch::Sender<bool>,
    next_request_id: Arc<AtomicU64>,
    request_timeout: Duration,
    max_message_bytes: usize,
    in_flight: Arc<Semaphore>,
    control_in_flight: Arc<Semaphore>,
    delivery_in_flight: Arc<Semaphore>,
    streaming_in_flight: Arc<Semaphore>,
}

impl GatewaySession {
    /// Send a WebSocket keepalive and wait for its matching pong.
    /// This uses separately bounded control capacity and never consumes a Gateway RPC slot.
    pub async fn ping(&self) -> Result<(), ClientError> {
        let id = format!(
            "rust-gateway-ping-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let deadline = Instant::now() + self.request_timeout;
        let permit =
            tokio::time::timeout_at(deadline, self.control_in_flight.clone().acquire_owned())
                .await
                .map_err(|_| ClientError::RequestTimeout("ping".into()))?
                .map_err(|_| ClientError::Closed("session retired".into()))?;
        let (reply, response) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        let mut cancellation =
            RequestCancellation::new(id.clone(), self.command_tx.clone(), cancelled.clone());
        tokio::time::timeout_at(
            deadline,
            self.control_tx.send(SessionControl::Ping {
                id,
                reply,
                permit,
                deadline,
                cancelled,
            }),
        )
        .await
        .map_err(|_| ClientError::RequestTimeout("ping".into()))?
        .map_err(|_| self.closed_error())?;
        let result = tokio::time::timeout_at(deadline, response)
            .await
            .map_err(|_| ClientError::RequestTimeout("ping".into()))?
            .map_err(|_| self.closed_error())?;
        cancellation.disarm();
        result.map(|_| ())
    }

    #[must_use]
    pub fn hello(&self) -> &Value {
        &self.hello
    }

    #[must_use]
    pub fn subscribe(&self) -> EventSubscription {
        self.events.subscribe(self.closed_rx.clone())
    }

    #[must_use]
    pub fn subscribe_transport_activity(&self) -> watch::Receiver<u64> {
        self.activity_rx.clone()
    }

    pub async fn next_event(&self) -> Result<Event, ClientError> {
        let mut events = self.event_rx.lock().await;
        events.recv().await
    }

    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, ClientError> {
        self.request_inner(
            method.into(),
            params,
            Some(Instant::now() + self.request_timeout),
            None,
            RequestLane::Application,
        )
        .await
    }

    /// Send a request before `deadline` if its application-owned guard still accepts dispatch.
    ///
    /// The guard runs synchronously in the session task after the socket becomes writable and
    /// immediately before the request frame is handed to the WebSocket sink. It must not block.
    pub async fn request_with_deadline<G>(
        &self,
        method: impl Into<String>,
        params: Value,
        deadline: Instant,
        guard: G,
    ) -> Result<Value, ClientError>
    where
        G: FnOnce() -> Result<(), DispatchRejection> + Send + 'static,
    {
        self.request_inner(
            method.into(),
            params,
            Some(deadline),
            Some(Box::new(move |dispatch| {
                guard()?;
                dispatch.enqueue();
                Ok(())
            })),
            RequestLane::Application,
        )
        .await
    }

    /// Send a request before `deadline`, allowing an application-owned guard to
    /// retain its authority lock through the WebSocket enqueue.
    ///
    /// The guard runs synchronously in the session task after the socket becomes
    /// writable. It must call [`DispatchContext::enqueue`] exactly where the
    /// request becomes authorized, return `Ok(())` immediately afterward, and
    /// must not block. Rejecting after enqueue retires the session because the
    /// frame can no longer be withdrawn from the WebSocket sink.
    pub async fn request_with_dispatch_deadline<G>(
        &self,
        method: impl Into<String>,
        params: Value,
        deadline: Instant,
        guard: G,
    ) -> Result<Value, ClientError>
    where
        G: for<'a> FnOnce(&mut DispatchContext<'a>) -> Result<(), DispatchRejection>
            + Send
            + 'static,
    {
        self.request_inner(
            method.into(),
            params,
            Some(deadline),
            Some(Box::new(guard)),
            RequestLane::Application,
        )
        .await
    }

    /// Send a request whose lifetime is owned by the caller instead of the default deadline.
    /// Dropping the future retires its correlation and releases capacity. Socket writes remain bounded.
    pub async fn request_until_cancelled(
        &self,
        method: impl Into<String>,
        params: Value,
    ) -> Result<Value, ClientError> {
        self.request_inner(method.into(), params, None, None, RequestLane::Application)
            .await
    }

    /// Deliver terminal work using its reserved RPC capacity, independent of
    /// ordinary requests and streaming updates. The normal deadline and cancellation rules apply.
    /// Parameters are measured and encoded at dispatch, then released before the socket write.
    /// Serializers must emit stable bytes on both passes.
    pub async fn request_delivery<P: Serialize + Send + 'static>(
        &self,
        method: impl Into<String>,
        params: P,
    ) -> Result<Value, ClientError> {
        self.request_inner(
            method.into(),
            params,
            Some(Instant::now() + self.request_timeout),
            None,
            RequestLane::Delivery,
        )
        .await
    }

    /// Send a streaming update using its reserved RPC capacity. The synchronous guard
    /// revalidates its owner after capacity/write waits, immediately at enqueue.
    pub async fn request_streaming<G>(
        &self,
        method: impl Into<String>,
        params: Value,
        guard: G,
    ) -> Result<Value, ClientError>
    where
        G: for<'a> FnOnce(&mut DispatchContext<'a>) -> Result<(), DispatchRejection>
            + Send
            + 'static,
    {
        self.request_inner(
            method.into(),
            params,
            Some(Instant::now() + self.request_timeout),
            Some(Box::new(guard)),
            RequestLane::Streaming,
        )
        .await
    }

    async fn request_inner<P: Serialize + Send + 'static>(
        &self,
        method: String,
        params: P,
        deadline: Option<Instant>,
        guard: Option<DispatchGuard>,
        lane: RequestLane,
    ) -> Result<Value, ClientError> {
        if method.is_empty() {
            return Err(ClientError::InvalidFrame(
                "request method must not be empty".into(),
            ));
        }
        let capacity = match lane {
            RequestLane::Application => &self.in_flight,
            RequestLane::Delivery => &self.delivery_in_flight,
            RequestLane::Streaming => &self.streaming_in_flight,
        };
        let permit = before_deadline(deadline, capacity.clone().acquire_owned())
            .await
            .map_err(|_| ClientError::RequestTimeout(method.clone()))?
            .map_err(|_| self.closed_error())?;
        let id = format!(
            "rust-gateway-{}",
            self.next_request_id.fetch_add(1, Ordering::Relaxed)
        );
        let (reply_tx, reply_rx) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        before_deadline(
            deadline,
            self.command_tx.send(SessionCommand::Request {
                id: id.clone(),
                method: method.clone(),
                params: request_encoder(params, self.max_message_bytes),
                reply: reply_tx,
                permit,
                deadline,
                cancelled: Arc::clone(&cancelled),
                guard,
            }),
        )
        .await
        .map_err(|_| ClientError::RequestTimeout(method.clone()))?
        .map_err(|_| self.closed_error())?;

        let mut cancellation = RequestCancellation::new(id, self.command_tx.clone(), cancelled);
        match before_deadline(deadline, reply_rx).await {
            Ok(Ok(result)) => {
                cancellation.disarm();
                result
            }
            Ok(Err(_)) => {
                cancellation.disarm();
                Err(self.closed_error())
            }
            Err(_) => Err(ClientError::RequestTimeout(method)),
        }
    }

    pub async fn close(&self) {
        let _ = self.close_tx.send(true);
    }

    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.closed_rx.borrow().is_some()
    }

    #[must_use]
    pub fn is_retired(&self) -> bool {
        *self.close_tx.borrow() || self.is_closed()
    }

    pub async fn wait_closed(&self) -> Result<(), ClientError> {
        let mut closed = self.closed_rx.clone();
        loop {
            if let Some(reason) = closed.borrow().as_ref() {
                return Err(reason.to_client_error());
            }
            if closed.changed().await.is_err() {
                return Err(ClientError::Closed("session task ended".into()));
            }
        }
    }

    fn closed_error(&self) -> ClientError {
        self.closed_rx.borrow().as_ref().map_or_else(
            || ClientError::Closed("session task ended".into()),
            SessionCloseCause::to_client_error,
        )
    }
}

async fn before_deadline<F: Future>(
    deadline: Option<Instant>,
    future: F,
) -> Result<F::Output, tokio::time::error::Elapsed> {
    match deadline {
        Some(deadline) => tokio::time::timeout_at(deadline, future).await,
        None => Ok(future.await),
    }
}

fn parse_retained_event(event: &[u8]) -> Result<Event, ClientError> {
    serde_json::from_slice(event).map_err(|error| ClientError::InvalidFrame(error.to_string()))
}

fn closed_event_error(closed: &watch::Receiver<Option<SessionCloseCause>>) -> ClientError {
    closed.borrow().as_ref().map_or_else(
        || ClientError::Closed("session task ended".into()),
        SessionCloseCause::to_client_error,
    )
}

struct RequestCancellation {
    id: Option<String>,
    commands: mpsc::Sender<SessionCommand>,
    cancelled: Arc<AtomicBool>,
}

impl RequestCancellation {
    fn new(id: String, commands: mpsc::Sender<SessionCommand>, cancelled: Arc<AtomicBool>) -> Self {
        Self {
            id: Some(id),
            commands,
            cancelled,
        }
    }

    fn disarm(&mut self) {
        self.id = None;
    }
}

impl Drop for RequestCancellation {
    fn drop(&mut self) {
        if let Some(id) = self.id.take() {
            self.cancelled.store(true, Ordering::Release);
            let _ = self.commands.try_send(SessionCommand::CancelRequest { id });
        }
    }
}

#[derive(Clone, Debug)]
enum SessionCloseCause {
    Closed(String),
    Transport(String),
    WriteTimeout(String),
}

impl SessionCloseCause {
    fn to_client_error(&self) -> ClientError {
        match self {
            Self::Closed(reason) => ClientError::Closed(reason.clone()),
            Self::Transport(reason) => ClientError::Transport(reason.clone()),
            Self::WriteTimeout(operation) => ClientError::WriteTimeout(operation.clone()),
        }
    }

    fn pending_request_error(&self, method: &str) -> ClientError {
        let suffix = format!("; request {method} did not complete");
        match self {
            Self::Closed(reason) => ClientError::Closed(format!("{reason}{suffix}")),
            Self::Transport(reason) => ClientError::Transport(format!("{reason}{suffix}")),
            Self::WriteTimeout(operation) => {
                ClientError::WriteTimeout(format!("{operation}{suffix}"))
            }
        }
    }
}

enum SessionCommand {
    Request {
        id: String,
        method: String,
        params: RequestEncoder,
        reply: oneshot::Sender<Result<Value, ClientError>>,
        permit: tokio::sync::OwnedSemaphorePermit,
        deadline: Option<Instant>,
        cancelled: Arc<AtomicBool>,
        guard: Option<DispatchGuard>,
    },
    CancelRequest {
        id: String,
    },
}

enum SessionControl {
    Ping {
        id: String,
        reply: oneshot::Sender<Result<Value, ClientError>>,
        permit: tokio::sync::OwnedSemaphorePermit,
        deadline: Instant,
        cancelled: Arc<AtomicBool>,
    },
}

#[derive(Deserialize)]
#[serde(tag = "type")]
enum IncomingFrame {
    #[serde(rename = "event")]
    Event {
        event: String,
        #[serde(default)]
        payload: Value,
    },
    #[serde(rename = "res")]
    Response {
        id: String,
        ok: bool,
        #[serde(default)]
        payload: Value,
        #[serde(default)]
        error: Option<GatewayErrorShape>,
    },
}

#[derive(Deserialize)]
struct GatewayErrorShape {
    #[serde(default)]
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    details: Option<Value>,
    #[serde(default)]
    retryable: Option<bool>,
    #[serde(default, rename = "retryAfterMs")]
    retry_after_ms: Option<u64>,
}

async fn wait_for_challenge<S>(
    socket: &mut S,
    write_timeout: Duration,
) -> Result<ConnectChallenge, ClientError>
where
    S: GatewayWebSocket,
{
    loop {
        match next_frame(socket, write_timeout).await? {
            IncomingFrame::Event { event, payload, .. } if event == "connect.challenge" => {
                let nonce = payload
                    .get("nonce")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| ClientError::InvalidChallenge("missing nonce".into()))?;
                let issued_at_ms = payload
                    .get("ts")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| ClientError::InvalidChallenge("missing timestamp".into()))?;
                return Ok(ConnectChallenge {
                    nonce: nonce.into(),
                    issued_at_ms,
                });
            }
            IncomingFrame::Event { .. } | IncomingFrame::Response { .. } => {}
        }
    }
}

async fn wait_for_response<S>(
    socket: &mut S,
    expected_id: &str,
    method: &str,
    write_timeout: Duration,
) -> Result<Value, ClientError>
where
    S: GatewayWebSocket,
{
    loop {
        if let IncomingFrame::Response {
            id,
            ok,
            payload,
            error,
        } = next_frame(socket, write_timeout).await?
        {
            if id == expected_id {
                return response_result(method, ok, payload, error);
            }
        }
    }
}

async fn next_frame<S>(
    socket: &mut S,
    write_timeout: Duration,
) -> Result<IncomingFrame, ClientError>
where
    S: GatewayWebSocket,
{
    loop {
        let message = socket
            .next()
            .await
            .ok_or_else(|| ClientError::Closed("Gateway ended the WebSocket stream".into()))?
            .map_err(|error| ClientError::Transport(error.to_string()))?;
        match message {
            message @ (Message::Text(_) | Message::Binary(_)) => {
                let text = message
                    .into_text()
                    .map_err(|error| ClientError::InvalidFrame(error.to_string()))?;
                return serde_json::from_str(text.as_str())
                    .map_err(|error| ClientError::InvalidFrame(error.to_string()));
            }
            Message::Ping(payload) => {
                send_message(socket, Message::Pong(payload), write_timeout, "pong").await?
            }
            Message::Close(frame) => return Err(ClientError::Closed(format_close(frame.as_ref()))),
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

fn request_encoder<P: Serialize + Send + 'static>(params: P, maximum: usize) -> RequestEncoder {
    Box::new(move |id, method| {
        #[derive(Serialize)]
        struct RequestFrame<'a, P> {
            id: &'a str,
            method: &'a str,
            params: P,
            #[serde(rename = "type")]
            kind: &'static str,
        }
        crate::json::encode_bounded_json(
            &RequestFrame {
                id,
                method,
                params,
                kind: "req",
            },
            maximum,
        )
        .map(|bytes| Message::Binary(bytes.into()))
    })
}

async fn send_request<S>(
    socket: &mut S,
    id: &str,
    method: &str,
    params: RequestEncoder,
    write_timeout: Duration,
    guard: Option<DispatchGuard>,
) -> Result<(), ClientError>
where
    S: GatewayWebSocket,
{
    // Consuming the encoder releases normalized media before any network await.
    // Native Swift also sends UTF-8 JSON bytes; binary avoids another text conversion.
    // Keep encoding errors at guarded enqueue, so denied authority wins as before.
    let message = params(id, method);
    send_message_guarded(socket, message, write_timeout, method, guard).await
}

async fn send_message<S>(
    socket: &mut S,
    message: Message,
    timeout: Duration,
    operation: &str,
) -> Result<(), ClientError>
where
    S: GatewayWebSocket,
{
    send_message_guarded(socket, Ok(message), timeout, operation, None).await
}

async fn send_message_guarded<S>(
    socket: &mut S,
    message: Result<Message, ClientError>,
    timeout: Duration,
    operation: &str,
    guard: Option<DispatchGuard>,
) -> Result<(), ClientError>
where
    S: GatewayWebSocket,
{
    tokio::time::timeout(timeout, async {
        poll_fn(|context| Pin::new(&mut *socket).poll_ready(context))
            .await
            .map_err(|error| ClientError::Transport(error.to_string()))?;
        if let Some(guard) = guard {
            let mut message = Some(message);
            let mut enqueue_result = None;
            let mut enqueue = || {
                enqueue_result = Some(
                    message
                        .take()
                        .expect("dispatch frame already consumed")
                        .and_then(|message| {
                            Pin::new(&mut *socket)
                                .start_send(message)
                                .map_err(|error| ClientError::Transport(error.to_string()))
                        }),
                );
            };
            let (guard_result, enqueued) = {
                let mut dispatch = DispatchContext {
                    enqueue: &mut enqueue,
                    enqueued: false,
                };
                let result = guard(&mut dispatch);
                (result, dispatch.enqueued)
            };
            if let Err(rejection) = guard_result {
                if !enqueued
                    || matches!(
                        enqueue_result.as_ref(),
                        Some(Err(ClientError::RequestTooLarge { .. }))
                    )
                {
                    return Err(ClientError::DispatchRejected(rejection.reason));
                }
                enqueue_result.expect("enqueued dispatch must record a result")?;
                return Err(ClientError::Closed(format!(
                    "dispatch guard rejected after enqueue: {}",
                    rejection.reason
                )));
            }
            if !enqueued {
                return Err(ClientError::DispatchRejected(
                    "dispatch guard did not enqueue the request".into(),
                ));
            }
            enqueue_result.expect("enqueued dispatch must record a result")?;
        } else {
            Pin::new(&mut *socket)
                .start_send(message?)
                .map_err(|error| ClientError::Transport(error.to_string()))?;
        }
        socket
            .flush()
            .await
            .map_err(|error| ClientError::Transport(error.to_string()))
    })
    .await
    .map_err(|_| ClientError::WriteTimeout(operation.into()))?
}

struct SessionChannels {
    commands: mpsc::Receiver<SessionCommand>,
    controls: mpsc::Receiver<SessionControl>,
    events: Arc<EventHub>,
    activity: watch::Sender<u64>,
    closed: watch::Sender<Option<SessionCloseCause>>,
    close: watch::Receiver<bool>,
}

#[derive(Clone, Copy)]
struct SessionLimits {
    write_timeout: Duration,
}

async fn run_session<S>(mut socket: S, channels: SessionChannels, limits: SessionLimits)
where
    S: GatewayWebSocket + 'static,
{
    let SessionChannels {
        mut commands,
        mut controls,
        events,
        activity,
        closed,
        mut close,
    } = channels;
    let SessionLimits { write_timeout } = limits;
    let mut pending: HashMap<String, PendingRequest> = HashMap::new();
    let close_reason = loop {
        let cancelled_pending = pending
            .iter()
            .filter(|(_, request)| request.cancelled.load(Ordering::Acquire))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in cancelled_pending {
            pending.remove(&id);
        }
        let next_deadline = pending
            .values()
            .filter_map(|request: &PendingRequest| request.deadline)
            .min();
        let deadline = async move {
            if let Some(deadline) = next_deadline {
                tokio::time::sleep_until(deadline).await;
            } else {
                std::future::pending::<()>().await;
            }
        };
        tokio::pin!(deadline);
        tokio::select! {
            changed = close.changed() => {
                let _ = changed;
                let _ = tokio::time::timeout(write_timeout, socket.close()).await;
                break SessionCloseCause::Closed("closed by client".into());
            }
            () = &mut deadline => {
                let now = Instant::now();
                let expired = pending
                    .iter()
                    .filter(|(_, request)| request.deadline.is_some_and(|deadline| deadline <= now))
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>();
                for id in expired {
                    if let Some(request) = pending.remove(&id) {
                        let _ = request.reply.send(Err(ClientError::RequestTimeout(
                            request.method,
                        )));
                    }
                }
            }
            Some(SessionControl::Ping { id, reply, permit, deadline, cancelled }) = controls.recv() => {
                if cancelled.load(Ordering::Acquire) || deadline <= Instant::now() {
                    let _ = reply.send(Err(ClientError::RequestTimeout("ping".into())));
                    continue;
                }
                match send_message(&mut socket, Message::Ping(id.clone().into_bytes().into()), write_timeout, "ping").await {
                    Ok(()) => {
                        pending.insert(id, PendingRequest { method: "ping".into(), reply, _permit: permit, deadline: Some(deadline), cancelled });
                    }
                    Err(error) => {
                        let reason = error.to_string();
                        let _ = reply.send(Err(error));
                        break SessionCloseCause::Transport(reason);
                    }
                }
            }
            command = commands.recv() => {
                match command {
                    Some(SessionCommand::Request { id, method, params, reply, permit, deadline, cancelled, guard }) => {
                        if cancelled.load(Ordering::Acquire) {
                            continue;
                        }
                        if deadline.is_some_and(|deadline| deadline <= Instant::now()) {
                            let _ = reply.send(Err(ClientError::RequestTimeout(method)));
                            continue;
                        }
                        let remaining = deadline.map(|deadline| deadline.saturating_duration_since(Instant::now()));
                        let request_deadline_wins = remaining.is_some_and(|remaining| remaining <= write_timeout);
                        match send_request(
                            &mut socket,
                            &id,
                            &method,
                            params,
                            remaining.map_or(write_timeout, |remaining| write_timeout.min(remaining)),
                            guard,
                        ).await {
                            Ok(()) => {
                                pending.insert(id, PendingRequest { method, reply, _permit: permit, deadline, cancelled });
                            }
                            Err(ClientError::WriteTimeout(operation)) => {
                                let result = if request_deadline_wins {
                                    Err(ClientError::RequestTimeout(method))
                                } else {
                                    Err(ClientError::WriteTimeout(operation.clone()))
                                };
                                let _ = reply.send(result);
                                break SessionCloseCause::WriteTimeout(operation);
                            }
                            // These failures precede socket enqueue; the connection is still usable.
                            Err(error @ (ClientError::DispatchRejected(_) | ClientError::RequestTooLarge { .. })) => {
                                let _ = reply.send(Err(error));
                            }
                            Err(ClientError::Closed(reason)) => {
                                let _ = reply.send(Err(ClientError::Closed(reason.clone())));
                                break SessionCloseCause::Closed(reason);
                            }
                            Err(error) => {
                                let reason = error.to_string();
                                let _ = reply.send(Err(error));
                                break SessionCloseCause::Transport(reason);
                            }
                        }
                    }
                    Some(SessionCommand::CancelRequest { id }) => {
                        pending.remove(&id);
                    }
                    None => {
                        let _ = tokio::time::timeout(write_timeout, socket.close()).await;
                        break SessionCloseCause::Closed("closed by client".into());
                    }
                }
            }
            message = socket.next() => {
                if matches!(&message, Some(Ok(_))) {
                    activity.send_modify(|generation| *generation = generation.wrapping_add(1));
                }
                match message {
                    Some(Ok(message @ (Message::Text(_) | Message::Binary(_)))) => {
                        let Ok(text) = message.into_text() else { continue; };
                        match serde_json::from_str::<IncomingFrame>(text.as_str()) {
                            Ok(frame @ IncomingFrame::Event { .. }) => {
                                // Validation is complete; release its payload before retaining raw bytes.
                                drop(frame);
                                events.publish(text.into());
                            }
                            Ok(IncomingFrame::Response { id, ok, payload, error }) => {
                                if let Some(request) = pending.remove(&id) {
                                    let _ = request.reply.send(response_result(
                                        &request.method,
                                        ok,
                                        payload,
                                        error,
                                    ));
                                }
                            }
                            // Match the authoritative TypeScript client: unknown JSON frames are
                            // not responses or events, regardless of request timing.
                            Err(_) => {}
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if let Err(error) = send_message(
                            &mut socket,
                            Message::Pong(payload),
                            write_timeout,
                            "pong",
                        ).await {
                            break session_close_cause(error);
                        }
                    }
                    Some(Ok(Message::Close(frame))) => {
                        break SessionCloseCause::Closed(format_close(frame.as_ref()));
                    }
                    Some(Ok(Message::Pong(payload))) => {
                        if let Ok(id) = std::str::from_utf8(&payload) {
                            if id.starts_with("rust-gateway-ping-") {
                                if let Some(request) = pending.remove(id) {
                                    let _ = request.reply.send(Ok(Value::Null));
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(error)) => break SessionCloseCause::Transport(error.to_string()),
                    None => break SessionCloseCause::Closed("Gateway ended the WebSocket stream".into()),
                }
            }
        }
    };

    for (_, request) in pending {
        let _ = request
            .reply
            .send(Err(close_reason.pending_request_error(&request.method)));
    }
    let _ = closed.send(Some(close_reason));
    events.close();
}

struct PendingRequest {
    method: String,
    reply: oneshot::Sender<Result<Value, ClientError>>,
    _permit: tokio::sync::OwnedSemaphorePermit,
    deadline: Option<Instant>,
    cancelled: Arc<AtomicBool>,
}

fn session_close_cause(error: ClientError) -> SessionCloseCause {
    match error {
        ClientError::Closed(reason) => SessionCloseCause::Closed(reason),
        ClientError::WriteTimeout(operation) => SessionCloseCause::WriteTimeout(operation),
        error => SessionCloseCause::Transport(error.to_string()),
    }
}

fn response_result(
    method: &str,
    ok: bool,
    payload: Value,
    error: Option<GatewayErrorShape>,
) -> Result<Value, ClientError> {
    if ok {
        return Ok(payload);
    }
    let mut error = error.unwrap_or(GatewayErrorShape {
        code: "UNKNOWN".into(),
        message: "Gateway rejected the request".into(),
        details: None,
        retryable: None,
        retry_after_ms: None,
    });
    if error.code.is_empty() {
        error.code = "UNKNOWN".into();
    }
    if error.message.is_empty() {
        error.message = "Gateway rejected the request".into();
    }
    Err(ClientError::Gateway {
        method: method.into(),
        code: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
        retry_after_ms: error.retry_after_ms,
    })
}

#[cfg(any(feature = "builtin-transport", test))]
fn classify_connect_error(error: TungsteniteError, secure_endpoint: bool) -> ClientError {
    if matches!(error, TungsteniteError::Tls(_))
        || secure_endpoint
            && matches!(
                &error,
                TungsteniteError::Io(io_error)
                    if io_error.kind() == std::io::ErrorKind::InvalidData
            )
        || error.to_string().contains(crate::TLS_PIN_MISMATCH_ERROR)
    {
        ClientError::Tls(error.to_string())
    } else {
        ClientError::Transport(error.to_string())
    }
}

fn validate_gateway_url(value: &str) -> Result<(), ClientError> {
    let url = Url::parse(value).map_err(|error| ClientError::InvalidUrl(error.to_string()))?;
    match url.scheme() {
        "wss" => Ok(()),
        "ws" if is_trusted_plaintext_host(&url) => Ok(()),
        "ws" => Err(ClientError::InsecureRemoteGateway),
        scheme => Err(ClientError::InvalidUrl(format!(
            "unsupported scheme {scheme}; expected ws or wss"
        ))),
    }
}

fn is_trusted_plaintext_host(url: &Url) -> bool {
    match url.host() {
        Some(Host::Ipv4(address)) => is_trusted_plaintext_address(&IpAddr::V4(address)),
        Some(Host::Ipv6(address)) => is_trusted_plaintext_address(&IpAddr::V6(address)),
        Some(Host::Domain(host)) => {
            let host = host.to_ascii_lowercase();
            // Native URLSession accepts the absolute DNS spelling of localhost too.
            matches!(host.as_str(), "localhost" | "localhost.")
                || host.ends_with(".local")
                || host.ends_with(".ts.net")
        }
        None => false,
    }
}

fn is_trusted_plaintext_address(address: &IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, _, _] = address.octets();
            address.is_loopback()
                || address.is_private()
                || address.is_link_local()
                || (first == 100 && (64..=127).contains(&second))
        }
        IpAddr::V6(address) => {
            if let Some(address) = address.to_ipv4_mapped() {
                return is_trusted_plaintext_address(&IpAddr::V4(address));
            }
            let first = address.segments()[0];
            address.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
    }
}

fn format_close(frame: Option<&tokio_tungstenite::tungstenite::protocol::CloseFrame>) -> String {
    frame.map_or_else(
        || "Gateway closed the WebSocket".into(),
        |frame| {
            format!(
                "Gateway closed the WebSocket ({}): {}",
                frame.code, frame.reason
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    use tokio_tungstenite::tungstenite::protocol::Role;

    struct StalledIo;

    impl AsyncRead for StalledIo {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    impl AsyncWrite for StalledIo {
        fn poll_write(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            Poll::Pending
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Pending
        }
    }

    #[cfg(not(feature = "builtin-transport"))]
    #[tokio::test]
    async fn missing_connector_fails_before_network_or_authentication() {
        for scheme in ["ws", "wss"] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let config = GatewayClientConfig::new(format!("{scheme}://{address}"))
                .unwrap()
                .connect_timeout(Duration::from_millis(20))
                .challenge_timeout(Duration::from_millis(20));
            let result = GatewayClient::connect(config, |_| async {
                panic!("missing transport must not request authentication");
                #[allow(unreachable_code)]
                Ok::<Value, std::convert::Infallible>(json!({}))
            })
            .await;
            assert!(
                matches!(result, Err(ClientError::Transport(ref reason)) if reason ==
                "built-in Gateway transport is disabled; provide a WebSocket connector")
            );
            assert!(
                tokio::time::timeout(Duration::from_millis(20), listener.accept())
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn injected_connector_cannot_silently_bypass_requested_tls_trust() {
        #[derive(Debug)]
        struct UnreachableNativeConnector;
        impl GatewayWebSocketConnector for UnreachableNativeConnector {
            fn connect(
                &self,
                _: crate::WebSocketRequest<()>,
                _: usize,
            ) -> futures_util::future::BoxFuture<
                'static,
                Result<Box<dyn GatewayWebSocket>, ClientError>,
            > {
                panic!("mixed trust ownership must be rejected before connecting");
            }
        }
        #[derive(Debug)]
        struct UnreachablePolicy;
        impl TlsCertificatePolicy for UnreachablePolicy {
            fn verify(
                &self,
                _: TlsPeerCertificate,
            ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send>> {
                panic!("mixed trust ownership must be rejected before connecting");
            }
        }
        let native = GatewayClientConfig::new("wss://localhost:1")
            .unwrap()
            .connector(Arc::new(UnreachableNativeConnector));
        for config in [
            native.clone().tls_trust(TlsTrust::Pinned([0; 32])),
            native.tls_certificate_policy(Arc::new(UnreachablePolicy)),
        ] {
            let result = GatewayClient::connect(config, |_| async {
                Ok::<Value, std::convert::Infallible>(json!({}))
            })
            .await;
            assert!(matches!(result, Err(ClientError::Tls(_))));
        }
    }

    #[test]
    fn protocol_fallback_matches_structured_code_or_normalized_message() {
        let error = |message: &str, details: Value| ClientError::Gateway {
            method: "connect".into(),
            code: "INVALID_REQUEST".into(),
            message: message.into(),
            details: Some(details),
            retryable: None,
            retry_after_ms: None,
        };

        assert!(is_expected_protocol_mismatch(
            &error(
                "rejected",
                json!({"code":"PROTOCOL_MISMATCH","expectedProtocol":3})
            ),
            3
        ));
        assert!(is_expected_protocol_mismatch(
            &error(
                "  Protocol Mismatch: expected v3  ",
                json!({"expectedProtocol":3})
            ),
            3
        ));
        assert!(!is_expected_protocol_mismatch(
            &error("protocol mismatch", json!({"expectedProtocol":4})),
            3
        ));
    }

    #[test]
    fn secure_invalid_data_handshakes_are_tls_failures() {
        let invalid_data = || {
            TungsteniteError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "certificate validation failed",
            ))
        };
        assert!(matches!(
            classify_connect_error(invalid_data(), true),
            ClientError::Tls(_)
        ));
        assert!(matches!(
            classify_connect_error(invalid_data(), false),
            ClientError::Transport(_)
        ));
    }

    #[tokio::test]
    async fn event_hub_evicts_by_count_and_aggregate_bytes() {
        let (_closed_tx, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(3, 9));
        let mut subscription = events.subscribe(closed_rx);
        events.publish(Bytes::from_static(br#"{"a":1}"#));
        events.publish(Bytes::from_static(br#"{"b":2}"#));
        assert!(matches!(
            subscription.recv().await,
            Err(ClientError::EventLagged(1))
        ));
    }

    #[tokio::test]
    async fn stalled_writer_closes_session_and_releases_pending_request() {
        let socket =
            tokio_tungstenite::WebSocketStream::from_raw_socket(StalledIo, Role::Client, None)
                .await;
        let (command_tx, command_rx) = mpsc::channel(1);
        let (_control_tx, control_rx) = mpsc::channel(1);
        let events = Arc::new(EventHub::new(1, 1024));
        let (activity_tx, _activity_rx) = watch::channel(0);
        let (closed_tx, mut closed_rx) = watch::channel(None);
        let mut event_rx = events.subscribe(closed_rx.clone());
        let (_close_tx, close_rx) = watch::channel(false);
        let task = tokio::spawn(run_session(
            socket,
            SessionChannels {
                commands: command_rx,
                controls: control_rx,
                events,
                activity: activity_tx,
                closed: closed_tx,
                close: close_rx,
            },
            SessionLimits {
                write_timeout: Duration::from_millis(20),
            },
        ));

        let permits = Arc::new(Semaphore::new(1));
        let permit = permits.clone().acquire_owned().await.unwrap();
        let (reply_tx, reply_rx) = oneshot::channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        command_tx
            .send(SessionCommand::Request {
                id: "stalled-request".into(),
                method: "node.stalled".into(),
                params: request_encoder(json!({}), DEFAULT_MAX_MESSAGE_BYTES),
                reply: reply_tx,
                permit,
                deadline: Some(Instant::now() + Duration::from_secs(1)),
                cancelled,
                guard: None,
            })
            .await
            .unwrap();

        assert!(matches!(
            tokio::time::timeout(Duration::from_secs(1), reply_rx)
                .await
                .expect("stalled write must be bounded")
                .unwrap(),
            Err(ClientError::WriteTimeout(operation)) if operation == "node.stalled"
        ));
        closed_rx.changed().await.unwrap();
        assert!(matches!(
            closed_rx.borrow().as_ref(),
            Some(SessionCloseCause::WriteTimeout(operation)) if operation == "node.stalled"
        ));
        assert!(matches!(
            event_rx.recv().await,
            Err(ClientError::WriteTimeout(_))
        ));
        task.await.unwrap();
        assert_eq!(permits.available_permits(), 1);
    }

    #[tokio::test]
    async fn cancellation_state_survives_a_full_command_queue() {
        let (commands, mut receiver) = mpsc::channel(1);
        commands
            .send(SessionCommand::CancelRequest {
                id: "queue-filler".into(),
            })
            .await
            .unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        drop(RequestCancellation::new(
            "abandoned".into(),
            commands,
            Arc::clone(&cancelled),
        ));

        assert!(cancelled.load(Ordering::Acquire));
        assert!(matches!(
            receiver.try_recv(),
            Ok(SessionCommand::CancelRequest { id }) if id == "queue-filler"
        ));
    }

    #[test]
    fn message_and_frame_limits_have_independent_tauri_compatible_defaults() {
        let config = GatewayClientConfig::new("ws://127.0.0.1:18789").unwrap();
        assert_eq!(config.max_message_bytes, 64 * 1024 * 1024);
        assert_eq!(config.max_frame_bytes, 16 * 1024 * 1024);

        let config = config
            .max_message_bytes(32 * 1024 * 1024)
            .max_frame_bytes(8 * 1024 * 1024);
        assert_eq!(config.max_message_bytes, 32 * 1024 * 1024);
        assert_eq!(config.max_frame_bytes, 8 * 1024 * 1024);
    }
}

#[cfg(test)]
mod event_retention_tests {
    use super::*;
    use futures_util::FutureExt;

    fn raw_event(sequence: u64, bytes: usize) -> Bytes {
        Bytes::from(
            serde_json::json!({
                "event": "node.retention", "seq": sequence, "payload": "x".repeat(bytes)
            })
            .to_string(),
        )
    }

    fn close(events: &EventHub, closed: &watch::Sender<Option<SessionCloseCause>>) {
        closed
            .send(Some(SessionCloseCause::Closed(
                "retention test close".into(),
            )))
            .unwrap();
        events.close();
    }

    async fn assert_closed(receiver: &mut EventSubscription) {
        assert!(matches!(receiver.recv().await,
            Err(ClientError::Closed(reason)) if reason == "retention test close"));
    }

    fn assert_retained(events: &EventHub, expected: &[(u64, usize)]) {
        let state = events.state.lock().unwrap();
        // The queue exclusively owns each Box; removing it releases that allocation.
        assert_eq!(
            state
                .frames
                .iter()
                .map(|frame| (frame.index, frame.raw.len()))
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(
            state.retained_bytes,
            expected.iter().map(|(_, bytes)| bytes).sum::<usize>()
        );
    }

    #[test]
    fn retained_storage_owns_only_visible_bytes_for_each_transport_backing() {
        struct Backing {
            bytes: Vec<u8>,
            released: Arc<AtomicBool>,
        }
        impl AsRef<[u8]> for Backing {
            fn as_ref(&self) -> &[u8] {
                &self.bytes
            }
        }
        impl Drop for Backing {
            fn drop(&mut self) {
                self.released.store(true, Ordering::Release);
            }
        }
        const RAW: &str = r#"{"event":"node.é","payload":{"text":"😀\n\u00e9"},"seq":7}"#;
        let mut spare = Vec::with_capacity(1024 * 1024);
        spare.extend_from_slice(RAW.as_bytes());
        let mut padded = vec![0xff; 1024 * 1024];
        let range = 4096..4096 + RAW.len();
        padded[range.clone()].copy_from_slice(RAW.as_bytes());
        let sibling = Bytes::from(padded.clone());
        let shared = sibling.slice(range.clone());
        let released = Arc::new(AtomicBool::new(false));
        let custom = Bytes::from_owner(Backing {
            bytes: padded.clone(),
            released: Arc::clone(&released),
        })
        .slice(range.clone());
        for (name, input, original, custom_owner) in [
            ("unique", Bytes::from(RAW.as_bytes().to_vec()), None, false),
            ("spare capacity", Bytes::from(spare), None, false),
            (
                "unique slice",
                Bytes::from(padded).slice(range.clone()),
                None,
                false,
            ),
            ("shared slice", shared, Some(sibling), false),
            ("static", Bytes::from_static(RAW.as_bytes()), None, false),
            ("custom owner", custom, None, true),
        ] {
            let (_closed, closed_rx) = watch::channel(None);
            let events = Arc::new(EventHub::new(256, RAW.len()));
            let receiver = events.subscribe(closed_rx);
            events.publish(input);
            assert_retained(&events, &[(0, RAW.len())]);
            if custom_owner {
                assert!(
                    released.load(Ordering::Acquire),
                    "backing must not outlive normalization"
                );
            }
            if let Some(original) = original {
                assert_eq!(&original[range.clone()], RAW.as_bytes(), "{name}");
                assert!(original[..range.start].iter().all(|byte| *byte == 0xff));
                assert!(original[range.end..].iter().all(|byte| *byte == 0xff));
            }
            // Inspect the actual retained allocation, not a cloned copy. This byte budget
            // must exclude spare capacity and backing prefix/suffix even before delivery.
            let retained = {
                let mut state = events.state.lock().unwrap();
                let frame = state.frames.pop_front().unwrap();
                state.retained_bytes -= frame.raw.len();
                frame.raw.into_vec()
            };
            assert_eq!(retained, RAW.as_bytes(), "{name}");
            assert_eq!(
                retained.capacity(),
                RAW.len(),
                "hidden backing capacity: {name}"
            );
            drop(receiver);
            assert_retained(&events, &[]);
        }
    }

    #[tokio::test]
    async fn consumed_raw_storage_releases_after_every_current_reader_advances() {
        let (_closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(256, 64 * 1024 * 1024));
        let mut initial = events.subscribe(closed_rx.clone());
        let mut independent = events.subscribe(closed_rx);
        let raw = raw_event(1, 256 * 1024);
        let raw_bytes = raw.len();
        events.publish(raw);
        assert_eq!(initial.recv().await.unwrap().seq, Some(1));
        assert_retained(&events, &[(0, raw_bytes)]);
        assert_eq!(independent.recv().await.unwrap().seq, Some(1));
        assert_retained(&events, &[]);
    }

    #[tokio::test]
    async fn unread_storage_releases_when_the_only_slow_reader_drops() {
        let (_closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(256, 64 * 1024 * 1024));
        let mut initial = events.subscribe(closed_rx.clone());
        let slow = events.subscribe(closed_rx);
        let raw = raw_event(1, 256 * 1024);
        let raw_bytes = raw.len();
        events.publish(raw);
        assert_eq!(initial.recv().await.unwrap().seq, Some(1));
        assert_retained(&events, &[(0, raw_bytes)]);
        drop(slow);
        assert_retained(&events, &[]);
    }

    #[tokio::test]
    async fn unread_storage_releases_when_the_last_receiver_drops() {
        let (_closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(256, 64 * 1024 * 1024));
        let initial = events.subscribe(closed_rx.clone());
        let raw = raw_event(1, 256 * 1024);
        events.publish(raw);
        drop(initial);
        assert_retained(&events, &[]);
        let mut late = events.subscribe(closed_rx);
        assert!(
            late.recv().now_or_never().is_none(),
            "late receivers never replay prior events"
        );
        events.publish(raw_event(2, 0));
        assert_eq!(late.recv().await.unwrap().seq, Some(2));
    }

    #[tokio::test]
    async fn default_backlog_late_subscription_and_close_drain_stay_independent() {
        let (closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(256, 64 * 1024 * 1024));
        let mut initial = events.subscribe(closed_rx.clone());
        events.publish(raw_event(1, 0));
        let mut late = events.subscribe(closed_rx);
        assert!(
            late.recv().now_or_never().is_none(),
            "a cancelled pending receive cannot consume backlog"
        );
        events.publish(raw_event(2, 0));
        close(&events, &closed);
        assert_eq!(late.recv().await.unwrap().seq, Some(2));
        assert_closed(&mut late).await;
        // The never-polled initial receiver remains a real owner from connection establishment.
        assert_eq!(initial.recv().await.unwrap().seq, Some(1));
        assert_eq!(initial.recv().await.unwrap().seq, Some(2));
        assert_closed(&mut initial).await;
    }

    #[tokio::test]
    async fn slow_reader_keeps_exact_count_and_byte_lag_boundaries() {
        let frame_bytes = raw_event(1, 0).len();
        for (capacity, byte_limit, count, lost) in
            [(3, 4096, 4, 1), (10, frame_bytes * 2 - 1, 2, 1)]
        {
            let (closed, closed_rx) = watch::channel(None);
            let events = Arc::new(EventHub::new(capacity, byte_limit));
            let mut slow = events.subscribe(closed_rx.clone());
            let mut fast = events.subscribe(closed_rx);
            for sequence in 1..=count {
                events.publish(raw_event(sequence, 0));
                assert_eq!(fast.recv().await.unwrap().seq, Some(sequence));
            }
            close(&events, &closed);
            assert!(matches!(slow.recv().await, Err(ClientError::EventLagged(n)) if n == lost));
            for sequence in (lost + 1)..=count {
                assert_eq!(slow.recv().await.unwrap().seq, Some(sequence));
            }
            assert_closed(&mut slow).await;
            assert_closed(&mut fast).await;
        }
    }

    #[tokio::test]
    async fn oversized_gap_preserves_events_on_both_sides_and_close_reason() {
        let (closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(4, 256));
        let mut initial = events.subscribe(closed_rx);
        events.publish(raw_event(1, 0));
        events.publish(raw_event(2, 512));
        events.publish(raw_event(3, 0));
        close(&events, &closed);
        assert_eq!(initial.recv().await.unwrap().seq, Some(1));
        assert!(matches!(
            initial.recv().await,
            Err(ClientError::EventLagged(1))
        ));
        assert_eq!(initial.recv().await.unwrap().seq, Some(3));
        assert_closed(&mut initial).await;
    }

    #[tokio::test]
    async fn malformed_event_releases_consumed_storage_without_hiding_the_error() {
        for invalid_metadata in [
            serde_json::json!({"seq":"bad"}),
            serde_json::json!({"seq":-1}),
            serde_json::json!({"recipientProfileId":7}),
        ] {
            let (_closed, closed_rx) = watch::channel(None);
            let events = Arc::new(EventHub::new(256, 64 * 1024 * 1024));
            let mut initial = events.subscribe(closed_rx.clone());
            let mut independent = events.subscribe(closed_rx);
            let mut value = serde_json::json!({"type":"event", "event":"node.é", "payload":"😀"});
            value
                .as_object_mut()
                .unwrap()
                .extend(invalid_metadata.as_object().unwrap().clone());
            let raw = Bytes::from(value.to_string());
            assert!(matches!(
                serde_json::from_slice::<IncomingFrame>(&raw),
                Ok(IncomingFrame::Event { .. })
            ));
            let raw_bytes = raw.len();
            events.publish(raw);
            assert!(matches!(
                initial.recv().await,
                Err(ClientError::InvalidFrame(_))
            ));
            assert_retained(&events, &[(0, raw_bytes)]);
            assert!(matches!(
                independent.recv().await,
                Err(ClientError::InvalidFrame(_))
            ));
            assert_retained(&events, &[]);
            events.publish(raw_event(2, 0));
            assert_eq!(initial.recv().await.unwrap().seq, Some(2));
            assert_eq!(independent.recv().await.unwrap().seq, Some(2));
            assert_retained(&events, &[]);
        }
    }

    #[tokio::test]
    async fn publishing_without_receivers_does_not_retain_unobservable_storage() {
        let (_closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(256, 64 * 1024 * 1024));
        let raw = raw_event(1, 256 * 1024);
        events.publish(raw);
        assert_retained(&events, &[]);
        let mut late = events.subscribe(closed_rx);
        assert!(late.recv().now_or_never().is_none());
        events.publish(raw_event(2, 0));
        assert_eq!(late.recv().await.unwrap().seq, Some(2));
    }

    #[tokio::test]
    async fn dropping_a_lagged_reader_releases_only_remaining_unread_frames() {
        let (_closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(2, 64 * 1024 * 1024));
        let mut slow = events.subscribe(closed_rx.clone());
        let mut fast = events.subscribe(closed_rx);
        let frame_bytes = raw_event(1, 256 * 1024).len();
        for sequence in 1..=3 {
            let raw = raw_event(sequence, 256 * 1024);
            events.publish(raw);
            assert_eq!(fast.recv().await.unwrap().seq, Some(sequence));
        }
        assert_retained(&events, &[(1, frame_bytes), (2, frame_bytes)]);
        assert!(matches!(
            slow.recv().await,
            Err(ClientError::EventLagged(1))
        ));
        drop(slow);
        assert_retained(&events, &[]);
        events.publish(raw_event(4, 0));
        assert_eq!(fast.recv().await.unwrap().seq, Some(4));
    }

    #[tokio::test]
    async fn dropping_an_early_reader_preserves_only_the_late_readers_backlog() {
        let (_closed, closed_rx) = watch::channel(None);
        let events = Arc::new(EventHub::new(256, 64 * 1024 * 1024));
        let early = events.subscribe(closed_rx.clone());
        let first = raw_event(1, 256 * 1024);
        events.publish(first);
        let mut late = events.subscribe(closed_rx);
        let second = raw_event(2, 256 * 1024);
        let second_bytes = second.len();
        events.publish(second);
        drop(early);
        assert_retained(&events, &[(1, second_bytes)]);
        assert_eq!(late.recv().await.unwrap().seq, Some(2));
        assert_retained(&events, &[]);
    }
}
