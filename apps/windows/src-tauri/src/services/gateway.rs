use crate::gateway::auth;
use crate::services::runtime::BackgroundService;
use crate::services::{ConfigService, EventDispatcher};
use async_trait::async_trait;
use ed25519_dalek::SigningKey;
use futures_util::{SinkExt, StreamExt};
use rand::rngs::OsRng;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::process::Stdio;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

/// Minimum seconds before retrying a failed connection.
const BACKOFF_INITIAL_SECS: u64 = 2;
/// Maximum seconds between connection retries.
const BACKOFF_MAX_SECS: u64 = 10;
/// Connections held longer than this are considered stable; backoff resets.
const STABLE_CONNECTION_SECS: u64 = 30;
/// WebSocket protocol-level ping interval.
const PING_INTERVAL_SECS: u64 = 15;
/// Default port used when remote endpoint omits one.
const DEFAULT_GATEWAY_PORT: u16 = 18789;
/// Default SSH port.
const DEFAULT_SSH_PORT: u16 = 22;

#[derive(Debug, Clone)]
struct SshTarget {
    user: Option<String>,
    host: String,
    port: u16,
}

struct SshTunnelGuard {
    child: Option<Child>,
    local_port: u16,
}

impl SshTunnelGuard {
    async fn shutdown(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        self.child = None;
    }
}

impl Drop for SshTunnelGuard {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
        }
    }
}

/// Typed gateway connection role to avoid string-based mode checks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GatewayRole {
    Operator,
    Node,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatus {
    pub connected: bool,
    pub address: String,
    pub port: u16,
    pub gateway_type: String,
    pub hello_ok: Option<serde_json::Value>,
}

pub struct GatewayState {
    pub operator_connected: bool,
    pub node_connected: bool,
    pub operator_sender: Option<mpsc::UnboundedSender<String>>,
    pub node_sender: Option<mpsc::UnboundedSender<String>>,
    pub hello_ok: Option<serde_json::Value>,
    pub pending_responses: std::collections::HashMap<String, oneshot::Sender<serde_json::Value>>,
}

pub struct GatewayService {
    state: Arc<Mutex<GatewayState>>,
    config: Arc<ConfigService>,
    events: Arc<EventDispatcher>,
    /// Sending on this channel signals the manager loop to stop.
    shutdown_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
}

impl GatewayService {
    pub fn new(config: Arc<ConfigService>, events: Arc<EventDispatcher>) -> Self {
        Self {
            state: Arc::new(Mutex::new(GatewayState {
                operator_connected: false,
                node_connected: false,
                operator_sender: None,
                node_sender: None,
                hello_ok: None,
                pending_responses: std::collections::HashMap::new(),
            })),
            config,
            events,
            shutdown_tx: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn get_status(&self) -> crate::error::Result<serde_json::Value> {
        let config = self.config.load().await?;
        let state = self.state.lock().await;
        Ok(json!({
            "connected": state.operator_connected,
            "address": config.address,
            "port": config.port,
            "gatewayType": config.gateway_type,
            "helloOk": state.hello_ok,
        }))
    }

    pub async fn request(&self, request: String) -> crate::error::Result<serde_json::Value> {
        let frame: serde_json::Value = serde_json::from_str(&request)
            .map_err(|e| crate::error::OpenClawError::Internal(format!("Invalid JSON: {}", e)))?;

        let id = frame["id"]
            .as_str()
            .ok_or_else(|| crate::error::OpenClawError::Internal("Missing request ID".to_string()))?
            .to_string();

        let (tx, rx) = oneshot::channel();

        let sender = {
            let mut s = self.state.lock().await;
            match s.operator_sender.as_ref() {
                Some(sender) => {
                    let sender_clone = sender.clone();
                    s.pending_responses.insert(id.clone(), tx);
                    sender_clone
                }
                None => {
                    return Err(crate::error::OpenClawError::Internal(
                        "Gateway not connected".to_string(),
                    ))
                }
            }
        };

        sender.send(request).map_err(|_| {
            crate::error::OpenClawError::Internal("Failed to send to gateway".to_string())
        })?;

        match timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(response)) => {
                let ok = response
                    .get("ok")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                if ok {
                    Ok(response
                        .get("payload")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null))
                } else {
                    let message = response
                        .get("error")
                        .and_then(|e| e.get("message"))
                        .and_then(|v| v.as_str())
                        .or_else(|| response.get("error").and_then(|e| e.as_str()))
                        .unwrap_or("Gateway request failed");
                    Err(crate::error::OpenClawError::Internal(format!(
                        "Gateway request failed: {}",
                        message
                    )))
                }
            }
            _ => {
                let mut s = self.state.lock().await;
                s.pending_responses.remove(&id);
                Err(crate::error::OpenClawError::Internal(
                    "Gateway request timed out".to_string(),
                ))
            }
        }
    }

    pub async fn send_node_response(&self, response: String) -> crate::error::Result<()> {
        let s = self.state.lock().await;
        if let Some(sender) = &s.node_sender {
            sender.send(response).map_err(|_| {
                crate::error::OpenClawError::Internal("Failed to send node response".to_string())
            })?;
        }
        Ok(())
    }

    async fn ensure_device_setup(
        &self,
        config: &mut crate::models::config::Config,
    ) -> crate::error::Result<()> {
        if !config.device_id.is_empty() && !config.private_key.is_empty() {
            return Ok(());
        }

        let signing_key = SigningKey::generate(&mut OsRng);
        let verify_key = signing_key.verifying_key();

        let mut hasher = Sha256::new();
        hasher.update(verify_key.as_bytes());
        let device_id = hex::encode(hasher.finalize());

        config.device_id = device_id;
        config.private_key = signing_key.to_bytes().to_vec();
        config.public_key = verify_key.to_bytes().to_vec();
        config.device_token = config.auth_token.clone();

        self.config.save(config).await?;
        Ok(())
    }

    async fn run_manager(&self, app: AppHandle, mut shutdown_rx: oneshot::Receiver<()>) {
        let mut backoff = BACKOFF_INITIAL_SECS;

        loop {
            // Check for shutdown signal (non-blocking)
            if shutdown_rx.try_recv().is_ok() {
                tracing::info!("[GatewayService] Shutdown signal received, stopping manager.");
                return;
            }

            let config = match self.config.load().await {
                Ok(c) => c,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };

            if config.is_paused {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }

            let has_remote_direct_url = config.gateway_mode == "remote-direct"
                && config
                    .remote_url
                    .as_ref()
                    .is_some_and(|u| !u.trim().is_empty());
            let has_remote_ssh_target = config.gateway_mode == "remote-ssh"
                && config
                    .remote_ssh_target
                    .as_ref()
                    .is_some_and(|t| !t.trim().is_empty());

            if config.address.trim().is_empty() && !has_remote_direct_url && !has_remote_ssh_target
            {
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }

            let connect_started = std::time::Instant::now();
            match self.connect(&app, &config).await {
                Ok(_) => {
                    // Reset backoff only if connection was stable
                    if connect_started.elapsed().as_secs() >= STABLE_CONNECTION_SECS {
                        backoff = BACKOFF_INITIAL_SECS;
                    }
                }
                Err(e) => {
                    tracing::info!(
                        "[GatewayService] Connection failed: {}. Retrying in {}s",
                        e,
                        backoff
                    );
                }
            }

            tokio::select! {
                _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
                _ = &mut shutdown_rx => {
                    tracing::info!("[GatewayService] Shutdown signal received during backoff.");
                    return;
                }
            }

            backoff = (backoff * 2).min(BACKOFF_MAX_SECS);
        }
    }

    async fn connect(
        &self,
        app: &AppHandle,
        config: &crate::models::config::Config,
    ) -> crate::error::Result<()> {
        let (url, mut ssh_tunnel) = if config.gateway_mode == "remote-direct" {
            let url = Self::normalize_remote_direct_url(config.remote_url.as_deref().unwrap_or(""))
                .ok_or_else(|| {
                    crate::error::OpenClawError::Internal(
                        "Could not resolve remote URL".to_string(),
                    )
                })?;
            (url, None)
        } else if config.gateway_mode == "remote-ssh" {
            let tunnel = self.open_remote_ssh_tunnel(config).await?;
            let url = format!("ws://127.0.0.1:{}", tunnel.local_port);
            (url, Some(tunnel))
        } else {
            let url = self
                .resolve_gateway_endpoint(
                    &config.address,
                    config.port,
                    &config.gateway_mode,
                    &config.gateway_type,
                )
                .await
                .ok_or_else(|| {
                    crate::error::OpenClawError::Internal("Could not resolve gateway".to_string())
                })?;
            (url, None)
        };

        let mut config = self.config.load().await?;
        self.ensure_device_setup(&mut config).await?;

        let op_task = self.run_connection(app.clone(), url.clone(), GatewayRole::Operator);
        let node_task = self.run_connection(app.clone(), url, GatewayRole::Node);

        let (op_result, node_result) = tokio::join!(op_task, node_task);
        if let Some(tunnel) = ssh_tunnel.as_mut() {
            tunnel.shutdown().await;
        }
        match (op_result, node_result) {
            (Err(e), _) => Err(e),
            (_, Err(e)) => Err(e),
            _ => Ok(()),
        }
    }

    async fn resolve_gateway_endpoint(
        &self,
        address: &str,
        port: u16,
        gateway_mode: &str,
        gateway_type: &str,
    ) -> Option<String> {
        let primary = address.trim();
        if primary.is_empty() || port == 0 {
            return None;
        }

        let mut candidates = vec![primary.to_string()];
        let allow_loopback_fallback = gateway_mode == "local"
            || gateway_type.eq_ignore_ascii_case("local")
            || gateway_type.eq_ignore_ascii_case("wsl")
            || Self::is_loopback_host(primary);
        if allow_loopback_fallback {
            for host in ["127.0.0.1", "::1"] {
                if !candidates.iter().any(|c| c == host) {
                    candidates.push(host.to_string());
                }
            }
        }

        for host in candidates {
            if let Ok(Ok(_)) = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                tokio::net::TcpStream::connect((host.as_str(), port)),
            )
            .await
            {
                return Some(format!("ws://{}", Self::format_host_port_for_ws(&host, port)));
            }
        }
        None
    }

    fn format_host_port_for_ws(host: &str, port: u16) -> String {
        let normalized = host.trim().trim_matches(['[', ']']);
        if normalized.contains(':') {
            format!("[{}]:{}", normalized, port)
        } else {
            format!("{}:{}", normalized, port)
        }
    }

    fn normalize_remote_direct_url(raw: &str) -> Option<String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut url = if trimmed.contains("://") {
            Url::parse(trimmed).ok()?
        } else {
            Url::parse(&format!("ws://{}", trimmed)).ok()?
        };

        match url.scheme() {
            "ws" | "wss" => {}
            "http" => {
                url.set_scheme("ws").ok()?;
            }
            "https" => {
                url.set_scheme("wss").ok()?;
            }
            _ => return None,
        }

        if url.host_str().is_none() {
            return None;
        }

        if url.port().is_none() {
            let default_port = match url.scheme() {
                "wss" => 443,
                _ => DEFAULT_GATEWAY_PORT,
            };
            let _ = url.set_port(Some(default_port));
        }

        Some(url.to_string())
    }

    fn parse_ssh_target(raw: &str) -> Option<SshTarget> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return None;
        }

        let (raw_user, host_port) = if let Some((lhs, rhs)) = trimmed.rsplit_once('@') {
            (Some(lhs.trim()), rhs.trim())
        } else {
            (None, trimmed)
        };

        if host_port.is_empty() {
            return None;
        }

        let user = raw_user
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(ToString::to_string);

        if host_port.starts_with('[') {
            let end = host_port.find(']')?;
            let host = host_port[1..end].trim();
            if host.is_empty() {
                return None;
            }
            let rest = host_port[end + 1..].trim();
            let port = if rest.is_empty() {
                DEFAULT_SSH_PORT
            } else if let Some(port_str) = rest.strip_prefix(':') {
                port_str.parse::<u16>().ok()?
            } else {
                return None;
            };
            return Some(SshTarget {
                user,
                host: host.to_string(),
                port,
            });
        }

        if let Some((host, port_str)) = host_port.rsplit_once(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                let host = host.trim();
                if host.is_empty() {
                    return None;
                }
                return Some(SshTarget {
                    user,
                    host: host.to_string(),
                    port,
                });
            }
        }

        Some(SshTarget {
            user,
            host: host_port.to_string(),
            port: DEFAULT_SSH_PORT,
        })
    }

    fn resolve_remote_ssh_target(config: &crate::models::config::Config) -> Option<SshTarget> {
        if let Some(parsed) = config
            .remote_ssh_target
            .as_deref()
            .and_then(Self::parse_ssh_target)
        {
            return Some(parsed);
        }

        let host = config
            .ssh_host
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
            .or_else(|| {
                let address = config.address.trim();
                if address.is_empty() {
                    None
                } else {
                    Some(address)
                }
            })?;
        let user = config
            .ssh_user
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .map(ToString::to_string);

        Some(SshTarget {
            user,
            host: host.to_string(),
            port: config.ssh_port.unwrap_or(DEFAULT_SSH_PORT),
        })
    }

    fn allocate_local_tunnel_port() -> crate::error::Result<u16> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to reserve local SSH tunnel port: {}",
                e
            ))
        })?;
        let port = listener
            .local_addr()
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to read local SSH tunnel port: {}",
                    e
                ))
            })?
            .port();
        drop(listener);
        Ok(port)
    }

    /// Validate SSH key path before passing to ssh.exe
    fn validate_ssh_key_path(key_path: &str) -> crate::error::Result<()> {
        let path = Path::new(key_path);

        if !path.exists() {
            return Err(crate::error::OpenClawError::Internal(format!(
                "SSH key file not found: {}",
                key_path
            )));
        }

        if !path.is_file() {
            return Err(crate::error::OpenClawError::Internal(format!(
                "SSH key path is not a file: {}",
                key_path
            )));
        }

        let canonical = path.canonicalize().map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to resolve SSH key path '{}': {}",
                key_path, e
            ))
        })?;

        tracing::debug!(
            "[GatewayService] SSH key path validation passed: {}",
            canonical.display()
        );

        Ok(())
    }

    async fn open_remote_ssh_tunnel(
        &self,
        config: &crate::models::config::Config,
    ) -> crate::error::Result<SshTunnelGuard> {
        let target = Self::resolve_remote_ssh_target(config).ok_or_else(|| {
            crate::error::OpenClawError::Internal(
                "Missing SSH target. Set Remote SSH target in settings.".to_string(),
            )
        })?;
        let local_port = Self::allocate_local_tunnel_port()?;
        let gateway_port = if config.port == 0 {
            DEFAULT_GATEWAY_PORT
        } else {
            config.port
        };

        let mut args = vec![
            "-N".to_string(),
            "-L".to_string(),
            format!("{}:127.0.0.1:{}", local_port, gateway_port),
            "-p".to_string(),
            target.port.to_string(),
            "-o".to_string(),
            "ExitOnForwardFailure=yes".to_string(),
            "-o".to_string(),
            "BatchMode=yes".to_string(),
            "-o".to_string(),
            "ConnectTimeout=8".to_string(),
        ];

        if let Some(identity) = config
            .remote_ssh_identity
            .as_deref()
            .map(str::trim)
            .filter(|i| !i.is_empty())
        {
            // Validate SSH key path before passing to ssh.exe
            Self::validate_ssh_key_path(identity)?;
            args.push("-i".to_string());
            args.push(identity.to_string());
        }

        let destination = match target.user {
            Some(user) => format!("{}@{}", user, target.host),
            None => target.host,
        };
        args.push(destination);

        tracing::info!(
            "[GatewayService] Opening SSH tunnel on localhost:{} for remote gateway port {}",
            local_port,
            gateway_port
        );
        let mut child = Command::new("ssh.exe")
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .spawn()
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to start ssh.exe for remote tunnel: {}",
                    e
                ))
            })?;

        // Wait for local forwarder to be ready (or fail fast if ssh exits).
        for _ in 0..50 {
            if let Some(status) = child.try_wait().map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed while checking ssh tunnel process state: {}",
                    e
                ))
            })? {
                return Err(crate::error::OpenClawError::Internal(format!(
                    "SSH tunnel exited before ready (code {:?})",
                    status.code()
                )));
            }

            if tokio::net::TcpStream::connect(("127.0.0.1", local_port))
                .await
                .is_ok()
            {
                return Ok(SshTunnelGuard {
                    child: Some(child),
                    local_port,
                });
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }

        let _ = child.start_kill();
        let _ = child.wait().await;
        Err(crate::error::OpenClawError::Internal(
            "Timed out waiting for SSH tunnel to become ready".to_string(),
        ))
    }

    fn is_loopback_host(host: &str) -> bool {
        let trimmed = host.trim().trim_matches(['[', ']']);
        matches!(trimmed, "127.0.0.1" | "::1") || trimmed.eq_ignore_ascii_case("localhost")
    }

    async fn run_connection(
        &self,
        app: AppHandle,
        url: String,
        role: GatewayRole,
    ) -> crate::error::Result<()> {
        tracing::info!("[GatewayService {:?}] Connecting to {}...", role, url);
        let (mut socket, _) = connect_async(&url).await.map_err(|e| {
            tracing::error!("[GatewayService {:?}] WebSocket failed: {}", role, e);
            crate::error::OpenClawError::Internal(format!("WebSocket failed: {}", e))
        })?;

        tracing::info!("[GatewayService {:?}] WebSocket connected: {}", role, url);

        let challenge_msg = timeout(Duration::from_secs(5), socket.next())
            .await
            .map_err(|_| crate::error::OpenClawError::Internal("Challenge timeout".to_string()))?
            .ok_or_else(|| {
                crate::error::OpenClawError::Internal("No challenge received".to_string())
            })?
            .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?;

        let txt = match challenge_msg {
            Message::Text(t) => t,
            _ => {
                return Err(crate::error::OpenClawError::Internal(
                    "Unexpected challenge type".to_string(),
                ))
            }
        };

        let challenge_json: serde_json::Value = serde_json::from_str(&txt)
            .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?;

        let nonce = challenge_json["payload"]["nonce"]
            .as_str()
            .ok_or_else(|| crate::error::OpenClawError::Internal("Missing nonce".to_string()))?;

        let config = self.config.load().await?;

        let connect_req = match role {
            GatewayRole::Operator => auth::get_operator_connection_req(nonce, &config)
                .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?,
            GatewayRole::Node => auth::get_node_connection_req(nonce, &config)
                .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?,
        };

        socket
            .send(Message::Text(connect_req.to_string()))
            .await
            .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?;

        let hello_msg = timeout(Duration::from_secs(5), socket.next())
            .await
            .map_err(|_| crate::error::OpenClawError::Internal("Hello timeout".to_string()))?
            .ok_or_else(|| crate::error::OpenClawError::Internal("No hello response".to_string()))?
            .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?;

        let txt = match hello_msg {
            Message::Text(t) => t,
            _ => {
                return Err(crate::error::OpenClawError::Internal(
                    "Unexpected hello response".to_string(),
                ))
            }
        };

        let response: serde_json::Value = serde_json::from_str(&txt)
            .map_err(|e| crate::error::OpenClawError::Internal(e.to_string()))?;

        if response.get("ok") != Some(&serde_json::Value::Bool(true)) {
            tracing::error!(
                "[GatewayService {:?}] Handshake rejected. Full response: {}",
                role,
                txt
            );

            if let Some(err) = response.get("error") {
                tracing::error!("[GatewayService {:?}] Gateway error payload: {}", role, err);
            }

            return Err(crate::error::OpenClawError::Internal(format!(
                "Handshake failed: {}",
                txt
            )));
        }

        if role == GatewayRole::Operator {
            if let Some(device_token) = response["payload"]["auth"]["deviceToken"].as_str() {
                let _ = self
                    .config
                    .update(|c| c.device_token = device_token.to_string())
                    .await;
            }
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<String>();
        {
            let mut s = self.state.lock().await;
            match role {
                GatewayRole::Operator => {
                    s.operator_connected = true;
                    s.operator_sender = Some(tx);
                    s.hello_ok = Some(response["payload"].clone());
                }
                GatewayRole::Node => {
                    s.node_connected = true;
                    s.node_sender = Some(tx);
                }
            }
        }
        if role == GatewayRole::Operator {
            self.emit_status_event().await;
        }

        let state = self.state.clone();
        let events = self.events.clone();

        // Fixed heartbeat: use interval so ping fires every 15s regardless of message traffic.
        let mut ping_interval = tokio::time::interval(Duration::from_secs(PING_INTERVAL_SECS));
        ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // Skip the immediate first tick
        ping_interval.tick().await;

        loop {
            tokio::select! {
                msg = socket.next() => {
                    match msg {
                        Some(Ok(Message::Text(txt))) => {
                            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&txt) {
                                match role {
                                    GatewayRole::Node => {
                                        if json["type"] == "event" && json["event"] == "node.invoke.request" {
                                            if let Some(payload) = json.get("payload") {
                                                let app_clone = app.clone();
                                                let req_clone = payload.clone();
                                                let service_clone = app_clone.state::<Arc<GatewayService>>().inner().clone();
                                                tokio::spawn(async move {
                                                    crate::services::invoke::handle_request(app_clone, req_clone, service_clone).await;
                                                });
                                            }
                                        }
                                    }
                                    GatewayRole::Operator => {
                                        if json["type"] == "res" {
                                            if let Some(id) = json["id"].as_str() {
                                                let mut s = state.lock().await;
                                                if let Some(tx) = s.pending_responses.remove(id) {
                                                    let _ = tx.send(json.clone());
                                                }
                                            }
                                        }
                                        let _ = events.emit("gateway_event", json.clone());
                                    }
                                }
                            }
                        }
                        Some(Ok(Message::Ping(p))) => { let _ = socket.send(Message::Pong(p)).await; }
                        Some(Ok(Message::Close(frame))) => {
                            if let Some(cf) = frame {
                                tracing::error!(
                                    "[GatewayService {:?}] Connection closed by gateway. Code: {:?}, Reason: {}",
                                    role,
                                    cf.code,
                                    cf.reason
                                );
                            } else {
                                tracing::error!(
                                    "[GatewayService {:?}] Connection closed by gateway (no close frame)",
                                    role
                                );
                            }
                            break;
                        }
                        Some(Err(e)) => {
                            tracing::error!(
                                "[GatewayService {:?}] WebSocket error: {}",
                                role,
                                e
                            );
                            break;
                        }
                        None => {
                            tracing::error!(
                                "[GatewayService {:?}] WebSocket closed unexpectedly (likely 1006)",
                                role
                            );
                            break;
                        },
                        _ => {}
                    }
                }
                Some(to_send) = rx.recv() => {
                    let _ = socket.send(Message::Text(to_send)).await;
                }
                _ = ping_interval.tick() => {
                    let _ = socket.send(Message::Ping(vec![])).await;
                }
            }
        }

        {
            let mut s = state.lock().await;
            match role {
                GatewayRole::Operator => {
                    s.operator_connected = false;
                    s.operator_sender = None;
                    s.hello_ok = None;
                    s.pending_responses.clear();
                }
                GatewayRole::Node => {
                    s.node_connected = false;
                    s.node_sender = None;
                }
            }
        }

        if role == GatewayRole::Operator {
            self.emit_status_event().await;
        }

        Ok(())
    }

    async fn emit_status_event(&self) {
        if let Ok(status) = self.get_status().await {
            let _ = self.events.emit("gateway_status", status);
        }
    }
}

#[async_trait]
impl BackgroundService for GatewayService {
    fn name(&self) -> &'static str {
        "GatewayService"
    }

    async fn start(&self, app: AppHandle) -> anyhow::Result<()> {
        let cfg = self.config.load().await?;
        if cfg.is_paused {
            tracing::info!("[GatewayService] Start skipped because app is paused.");
            return Ok(());
        }

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        {
            let mut lock = self.shutdown_tx.lock().await;
            *lock = Some(shutdown_tx);
        }
        let service = app.state::<Arc<GatewayService>>().inner().clone();
        tokio::spawn(async move {
            service.run_manager(app, shutdown_rx).await;
        });
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        tracing::info!("[GatewayService] Stopping...");
        let mut lock = self.shutdown_tx.lock().await;
        if let Some(tx) = lock.take() {
            let _ = tx.send(());
        }
        // Drop senders to close WebSocket connections
        let mut s = self.state.lock().await;
        s.operator_sender = None;
        s.node_sender = None;
        s.operator_connected = false;
        s.node_connected = false;
        s.pending_responses.clear();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::GatewayService;

    #[test]
    fn normalizes_remote_direct_url_with_wss_default_port() {
        let url = GatewayService::normalize_remote_direct_url("wss://gateway.example.com");
        assert_eq!(url.as_deref(), Some("wss://gateway.example.com/"));
    }

    #[test]
    fn normalizes_remote_direct_url_with_ws_default_port() {
        let url = GatewayService::normalize_remote_direct_url("ws://gateway.example.com");
        assert_eq!(url.as_deref(), Some("ws://gateway.example.com:18789/"));
    }

    #[test]
    fn parses_ssh_target_with_user_and_port() {
        let parsed = GatewayService::parse_ssh_target("dev@example.com:2201").unwrap();
        assert_eq!(parsed.user.as_deref(), Some("dev"));
        assert_eq!(parsed.host, "example.com");
        assert_eq!(parsed.port, 2201);
    }

    #[test]
    fn parses_ssh_target_without_user() {
        let parsed = GatewayService::parse_ssh_target("example.com").unwrap();
        assert_eq!(parsed.user, None);
        assert_eq!(parsed.host, "example.com");
        assert_eq!(parsed.port, 22);
    }
}
