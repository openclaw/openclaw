use crate::models::config::Config;
use crate::services::runtime::BackgroundService;
use crate::services::ConfigService;
use crate::services::GatewayService;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;
use tauri::{Manager, State};
use tauri_plugin_autostart::ManagerExt;
use url::Url;

fn req_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

// General settings commands.

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GeneralSettingsPayload {
    pub gateway_mode: String,
    pub remote_url: Option<String>,
    pub remote_ssh_target: Option<String>,
    pub remote_ssh_identity: Option<String>,
    pub remote_ssh_project_root: Option<String>,
    pub remote_ssh_cli_path: Option<String>,
    pub start_on_login: bool,
    pub camera_enabled: bool,
    pub canvas_enabled: bool,
    pub is_paused: bool,
    pub icon_animations_enabled: bool,
    pub automation_bridge_enabled: bool,
    pub debug_pane_enabled: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FullConfigResponse {
    pub schema_version: u32,
    pub device_id: String,
    pub private_key: Vec<u8>,
    pub public_key: Vec<u8>,
    pub device_token: String,
    pub auth_token: String,
    pub address: String,
    pub port: u16,
    pub gateway_type: String,
    pub ssh_user: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_path: Option<String>,
    pub is_setup_completed: bool,
    pub start_on_login: bool,
    pub camera_enabled: bool,
    pub canvas_enabled: bool,
    pub is_paused: bool,
    pub gateway_mode: String,
    pub remote_url: Option<String>,
    pub remote_ssh_target: Option<String>,
    pub remote_ssh_identity: Option<String>,
    pub remote_ssh_project_root: Option<String>,
    pub remote_ssh_cli_path: Option<String>,
    pub icon_animations_enabled: bool,
    pub automation_bridge_enabled: bool,
    pub debug_pane_enabled: bool,
    pub voice_wake_enabled: bool,
    pub voice_wake_triggers: Vec<String>,
    pub voice_wake_mic_id: String,
    pub voice_wake_locale: String,
    pub voice_wake_additional_locale_ids: Vec<String>,
    pub voice_wake_trigger_chime: String,
    pub voice_wake_send_chime: String,
    pub voice_wake_session_key: String,
    pub voice_wake_ptt_enabled: bool,
    pub voice_wake_ptt_key: String,
}

impl From<Config> for FullConfigResponse {
    fn from(config: Config) -> Self {
        Self {
            schema_version: config.schema_version,
            device_id: config.device_id,
            private_key: config.private_key,
            public_key: config.public_key,
            device_token: config.device_token,
            auth_token: config.auth_token,
            address: config.address,
            port: config.port,
            gateway_type: config.gateway_type,
            ssh_user: config.ssh_user,
            ssh_host: config.ssh_host,
            ssh_port: config.ssh_port,
            ssh_key_path: config.ssh_key_path,
            is_setup_completed: config.is_setup_completed,
            start_on_login: config.start_on_login,
            camera_enabled: config.camera_enabled,
            canvas_enabled: config.canvas_enabled,
            is_paused: config.is_paused,
            gateway_mode: config.gateway_mode,
            remote_url: config.remote_url,
            remote_ssh_target: config.remote_ssh_target,
            remote_ssh_identity: config.remote_ssh_identity,
            remote_ssh_project_root: config.remote_ssh_project_root,
            remote_ssh_cli_path: config.remote_ssh_cli_path,
            icon_animations_enabled: config.icon_animations_enabled,
            automation_bridge_enabled: config.automation_bridge_enabled,
            debug_pane_enabled: config.debug_pane_enabled,
            voice_wake_enabled: config.voice_wake_enabled,
            voice_wake_triggers: config.voice_wake_triggers,
            voice_wake_mic_id: config.voice_wake_mic_id,
            voice_wake_locale: config.voice_wake_locale,
            voice_wake_additional_locale_ids: config.voice_wake_additional_locale_ids,
            voice_wake_trigger_chime: config.voice_wake_trigger_chime,
            voice_wake_send_chime: config.voice_wake_send_chime,
            voice_wake_session_key: config.voice_wake_session_key,
            voice_wake_ptt_enabled: config.voice_wake_ptt_enabled,
            voice_wake_ptt_key: config.voice_wake_ptt_key,
        }
    }
}

fn default_gateway_port(current: u16) -> u16 {
    if current == 0 {
        18789
    } else {
        current
    }
}

fn is_loopback_host(host: &str) -> bool {
    let trimmed = host.trim().trim_matches(['[', ']']);
    matches!(trimmed, "127.0.0.1" | "::1") || trimmed.eq_ignore_ascii_case("localhost")
}

fn parse_remote_url_host_port(raw: &str, fallback_port: u16) -> Option<(String, u16)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = if trimmed.contains("://") {
        Url::parse(trimmed).ok()?
    } else {
        Url::parse(&format!("ws://{}", trimmed)).ok()?
    };
    let host = parsed.host_str()?.trim();
    if host.is_empty() {
        return None;
    }
    let scheme = parsed.scheme().to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "wss" | "https" => 443,
        "ws" | "http" => 18789,
        _ => default_gateway_port(fallback_port),
    };
    let port = parsed.port().unwrap_or(default_port);
    Some((host.to_string(), port))
}

fn apply_gateway_connection_preferences(config: &mut Config) {
    match config.gateway_mode.as_str() {
        "remote-direct" => {
            config.gateway_type = "remote".to_string();
            config.port = default_gateway_port(config.port);
            if let Some(remote_url) = config.remote_url.as_deref() {
                if let Some((host, port)) = parse_remote_url_host_port(remote_url, config.port) {
                    config.address = host;
                    config.port = port;
                }
            }
        }
        "remote-ssh" => {
            config.gateway_type = "remote-ssh".to_string();
            config.port = default_gateway_port(config.port);
            if let Some(target) = config.remote_ssh_target.as_deref() {
                if let Some((host, _)) = parse_ssh_target(target) {
                    config.address = host.clone();
                    config.ssh_host = Some(host);
                }
            }
        }
        _ => {
            if config.address.trim().is_empty() || !is_loopback_host(&config.address) {
                config.address = "127.0.0.1".to_string();
            }
            config.port = default_gateway_port(config.port);
            if config.gateway_type.trim().is_empty() || config.gateway_type.starts_with("remote") {
                config.gateway_type = "local".to_string();
            }
        }
    }
}

fn connection_profile_changed(before: &Config, after: &Config) -> bool {
    before.gateway_mode != after.gateway_mode
        || before.gateway_type != after.gateway_type
        || before.address != after.address
        || before.port != after.port
        || before.remote_url != after.remote_url
        || before.remote_ssh_target != after.remote_ssh_target
        || before.auth_token != after.auth_token
}

fn node_capability_profile_changed(before: &Config, after: &Config) -> bool {
    // Node command availability is derived from these settings in the connect handshake.
    before.camera_enabled != after.camera_enabled
}

#[tauri::command]
pub async fn get_full_config(
    config_service: State<'_, Arc<ConfigService>>,
) -> crate::error::Result<FullConfigResponse> {
    let config = config_service.load().await?;
    Ok(config.into())
}

#[tauri::command]
pub async fn save_general_settings(
    payload: GeneralSettingsPayload,
    config_service: State<'_, Arc<ConfigService>>,
    app: tauri::AppHandle,
) -> crate::error::Result<()> {
    // Keep OS autostart state in sync with saved app config.
    let autostart_manager = app.autolaunch();
    if payload.start_on_login {
        let _ = autostart_manager.enable();
    } else {
        let _ = autostart_manager.disable();
    }

    let before = config_service.load().await?;

    config_service
        .update(|config| {
            config.start_on_login = payload.start_on_login;
            config.camera_enabled = payload.camera_enabled;
            config.canvas_enabled = payload.canvas_enabled;
            config.is_paused = payload.is_paused;
            config.gateway_mode = payload.gateway_mode.clone();
            config.remote_url = payload.remote_url.clone();
            config.remote_ssh_target = payload.remote_ssh_target.clone();
            config.remote_ssh_identity = payload.remote_ssh_identity.clone();
            config.remote_ssh_project_root = payload.remote_ssh_project_root.clone();
            config.remote_ssh_cli_path = payload.remote_ssh_cli_path.clone();
            config.icon_animations_enabled = payload.icon_animations_enabled;
            config.automation_bridge_enabled = payload.automation_bridge_enabled;
            config.debug_pane_enabled = payload.debug_pane_enabled;
            apply_gateway_connection_preferences(config);
        })
        .await?;

    let after = config_service.load().await?;
    let connection_changed = connection_profile_changed(&before, &after);
    let node_caps_changed = node_capability_profile_changed(&before, &after);
    let pause_changed = before.is_paused != after.is_paused;
    let gateway = app.state::<Arc<GatewayService>>().inner().clone();

    if pause_changed && after.is_paused {
        <GatewayService as BackgroundService>::stop(gateway.as_ref())
            .await
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to stop gateway service while pausing: {}",
                    e
                ))
            })?;
    } else if pause_changed && !after.is_paused {
        <GatewayService as BackgroundService>::start(gateway.as_ref(), app.clone())
            .await
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to start gateway service while resuming: {}",
                    e
                ))
            })?;
    } else if connection_changed && !after.is_paused {
        <GatewayService as BackgroundService>::stop(gateway.as_ref())
            .await
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to stop gateway service for reconnect: {}",
                    e
                ))
            })?;
        <GatewayService as BackgroundService>::start(gateway.as_ref(), app.clone())
            .await
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to restart gateway service after settings update: {}",
                    e
                ))
            })?;
    } else if node_caps_changed && !after.is_paused {
        <GatewayService as BackgroundService>::stop(gateway.as_ref())
            .await
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to stop gateway service for capability refresh: {}",
                    e
                ))
            })?;
        <GatewayService as BackgroundService>::start(gateway.as_ref(), app.clone())
            .await
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to restart gateway service after capability update: {}",
                    e
                ))
            })?;
    }

    Ok(())
}

// Gateway health and diagnostics.

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHealthStatus {
    pub connected: bool,
    pub error: Option<String>,
}

fn latest_openclaw_log_file(log_dir: &Path) -> Option<PathBuf> {
    let mut latest: Option<(PathBuf, SystemTime)> = None;
    let entries = std::fs::read_dir(log_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|v| v.to_str()) {
            Some(v) => v,
            None => continue,
        };
        if !name.starts_with("openclaw.log") {
            continue;
        }
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);

        match latest {
            Some((_, current)) if modified <= current => {}
            _ => latest = Some((path, modified)),
        }
    }

    latest.map(|(path, _)| path)
}

#[tauri::command]
pub async fn get_log_path(app: tauri::AppHandle) -> crate::error::Result<String> {
    let log_dir = app
        .path()
        .app_log_dir()
        .map_err(|e| crate::error::OpenClawError::Internal(format!("Cannot get log dir: {}", e)))?;
    if let Some(file) = latest_openclaw_log_file(&log_dir) {
        return Ok(file.to_string_lossy().into_owned());
    }
    Ok(log_dir.to_string_lossy().into_owned())
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearResult {
    pub cache_dir: Option<String>,
    pub cache_dir_cleared: bool,
    pub config_cache_cleared: bool,
}

#[tauri::command]
pub async fn clear_artifact_cache(
    app: tauri::AppHandle,
    config_service: State<'_, Arc<ConfigService>>,
) -> crate::error::Result<CacheClearResult> {
    config_service.invalidate_cache().await;

    let cache_dir = app.path().app_cache_dir().ok();
    let mut cache_dir_cleared = false;
    if let Some(path) = cache_dir.as_ref() {
        if path.exists() {
            std::fs::remove_dir_all(path).map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to clear cache dir '{}': {}",
                    path.display(),
                    e
                ))
            })?;
        }
        std::fs::create_dir_all(path).map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to recreate cache dir '{}': {}",
                path.display(),
                e
            ))
        })?;
        cache_dir_cleared = true;
    }

    Ok(CacheClearResult {
        cache_dir: cache_dir.map(|p| p.to_string_lossy().into_owned()),
        cache_dir_cleared,
        config_cache_cleared: true,
    })
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    pub git_commit: Option<String>,
    pub build_timestamp: Option<String>,
}

#[tauri::command]
pub async fn get_build_info(app: tauri::AppHandle) -> crate::error::Result<BuildInfo> {
    let version = app.package_info().version.to_string();
    // These are optional build-time values from TAURI_GIT_COMMIT / TAURI_BUILD_TIMESTAMP.
    let git_commit = option_env!("TAURI_GIT_COMMIT").map(|s| s.to_string());
    let build_timestamp = option_env!("TAURI_BUILD_TIMESTAMP").map(|s| s.to_string());
    Ok(BuildInfo {
        version,
        git_commit,
        build_timestamp,
    })
}

#[tauri::command]
pub async fn reset_setup(
    config_service: State<'_, Arc<ConfigService>>,
) -> crate::error::Result<()> {
    config_service
        .update(|config| {
            config.is_setup_completed = false;
        })
        .await
}

#[tauri::command]
pub async fn get_gateway_health(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<GatewayHealthStatus> {
    let status = gateway_service.get_status().await?;
    let connected = status
        .get("connected")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let address = status
        .get("address")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown");
    let port = status.get("port").and_then(|v| v.as_u64()).unwrap_or(0);
    Ok(GatewayHealthStatus {
        connected,
        error: if connected {
            None
        } else {
            Some(format!("Not connected to {}:{}", address, port))
        },
    })
}

// Remote connectivity validation helpers.

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestRemotePayload {
    pub address: String,
    pub port: u16,
    pub token: String,
    #[serde(default)]
    pub mode: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TestRemoteResult {
    pub ok: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

fn parse_ssh_target(input: &str) -> Option<(String, u16)> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }

    let host_port = trimmed
        .rsplit_once('@')
        .map(|(_, rhs)| rhs)
        .unwrap_or(trimmed);
    if host_port.is_empty() {
        return None;
    }

    // IPv6 with optional port: [::1]:2222
    if host_port.starts_with('[') {
        let end = host_port.find(']')?;
        let host = host_port[1..end].trim().to_string();
        if host.is_empty() {
            return None;
        }
        let rest = host_port[end + 1..].trim();
        if rest.is_empty() {
            return Some((host, 22));
        }
        if let Some(port_str) = rest.strip_prefix(':') {
            if let Ok(port) = port_str.parse::<u16>() {
                return Some((host, port));
            }
        }
        return None;
    }

    // hostname[:port]
    if let Some((host, port_str)) = host_port.rsplit_once(':') {
        if let Ok(port) = port_str.parse::<u16>() {
            let host = host.trim().to_string();
            if !host.is_empty() {
                return Some((host, port));
            }
        }
    }

    Some((host_port.to_string(), 22))
}

fn normalize_ws_url(address: &str, port: u16) -> Result<String, String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return Err("Target address is required".to_string());
    }

    if trimmed.contains("://") {
        let mut url = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {}", e))?;
        match url.scheme() {
            "ws" | "wss" => {}
            "http" => {
                url.set_scheme("ws")
                    .map_err(|_| "Invalid URL scheme".to_string())?;
            }
            "https" => {
                url.set_scheme("wss")
                    .map_err(|_| "Invalid URL scheme".to_string())?;
            }
            other => {
                return Err(format!(
                    "Unsupported URL scheme '{}'. Use ws:// or wss://",
                    other
                ));
            }
        }
        if url.path().is_empty() || url.path() == "/" {
            url.set_path("/ws");
        }
        return Ok(url.to_string());
    }

    if port == 0 {
        return Err("Port must be greater than 0 when using host-only address".to_string());
    }

    Ok(format!("ws://{}:{}/ws", trimmed, port))
}

#[tauri::command]
pub async fn test_remote_connection(
    payload: TestRemotePayload,
) -> crate::error::Result<TestRemoteResult> {
    let start = std::time::Instant::now();
    let mode = payload.mode.unwrap_or_default();

    if mode == "remote-ssh" {
        let Some((host, ssh_port)) = parse_ssh_target(&payload.address) else {
            return Ok(TestRemoteResult {
                ok: false,
                message: "Invalid SSH target. Use user@host[:port]".to_string(),
                latency_ms: None,
            });
        };

        let connect = tokio::net::TcpStream::connect((host.as_str(), ssh_port));
        return match tokio::time::timeout(std::time::Duration::from_secs(8), connect).await {
            Ok(Ok(_)) => Ok(TestRemoteResult {
                ok: true,
                message: format!("SSH target reachable at {}:{}", host, ssh_port),
                latency_ms: Some(start.elapsed().as_millis() as u64),
            }),
            Ok(Err(e)) => Ok(TestRemoteResult {
                ok: false,
                message: format!("SSH connection failed: {}", e),
                latency_ms: None,
            }),
            Err(_) => Ok(TestRemoteResult {
                ok: false,
                message: "SSH check timed out after 8 seconds".to_string(),
                latency_ms: None,
            }),
        };
    }

    let url = match normalize_ws_url(&payload.address, payload.port) {
        Ok(url) => url,
        Err(message) => {
            return Ok(TestRemoteResult {
                ok: false,
                message,
                latency_ms: None,
            })
        }
    };

    let connect_timeout = std::time::Duration::from_secs(8);
    let (mut socket, _) =
        match tokio::time::timeout(connect_timeout, tokio_tungstenite::connect_async(&url)).await {
            Ok(Ok(pair)) => pair,
            Ok(Err(e)) => {
                return Ok(TestRemoteResult {
                    ok: false,
                    message: format!("Connection failed: {}", e),
                    latency_ms: None,
                });
            }
            Err(_) => {
                return Ok(TestRemoteResult {
                    ok: false,
                    message: "Connection timed out after 8 seconds".to_string(),
                    latency_ms: None,
                });
            }
        };

    // Validate auth token via the same challenge/response flow used by real clients.
    let challenge = tokio::time::timeout(std::time::Duration::from_secs(5), socket.next()).await;
    let challenge_text = match challenge {
        Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(t)))) => t,
        Ok(Some(Ok(_))) => {
            return Ok(TestRemoteResult {
                ok: false,
                message: "Gateway challenge frame was not text".to_string(),
                latency_ms: None,
            });
        }
        Ok(Some(Err(e))) => {
            return Ok(TestRemoteResult {
                ok: false,
                message: format!("Failed during gateway challenge: {}", e),
                latency_ms: None,
            });
        }
        Ok(None) => {
            return Ok(TestRemoteResult {
                ok: false,
                message: "Gateway closed before challenge".to_string(),
                latency_ms: None,
            });
        }
        Err(_) => {
            return Ok(TestRemoteResult {
                ok: false,
                message: "Timed out waiting for gateway challenge".to_string(),
                latency_ms: None,
            });
        }
    };

    let challenge_json: Value = match serde_json::from_str(&challenge_text) {
        Ok(v) => v,
        Err(e) => {
            return Ok(TestRemoteResult {
                ok: false,
                message: format!("Invalid challenge payload: {}", e),
                latency_ms: None,
            });
        }
    };
    let _nonce = challenge_json
        .get("payload")
        .and_then(|v| v.get("nonce"))
        .and_then(|v| v.as_str())
        .unwrap_or_default();

    let mut connect_params = Map::new();
    connect_params.insert("minProtocol".to_string(), json!(1));
    connect_params.insert("maxProtocol".to_string(), json!(99));
    connect_params.insert(
        "client".to_string(),
        json!({
            "id": "openclaw-probe",
            "displayName": "OpenClaw Windows Probe",
            "version": env!("CARGO_PKG_VERSION"),
            "platform": "windows",
            "mode": "probe",
        }),
    );
    connect_params.insert("role".to_string(), json!("operator"));
    let token = payload.token.trim();
    if !token.is_empty() {
        connect_params.insert("auth".to_string(), json!({ "token": token }));
    }

    let connect_req = json!({
        "type": "req",
        "id": req_id(),
        "method": "connect",
        "params": Value::Object(connect_params),
    });

    if let Err(e) = socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            connect_req.to_string().into(),
        ))
        .await
    {
        return Ok(TestRemoteResult {
            ok: false,
            message: format!("Failed to send auth handshake: {}", e),
            latency_ms: None,
        });
    }

    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    loop {
        let now = std::time::Instant::now();
        if now >= deadline {
            return Ok(TestRemoteResult {
                ok: false,
                message: "Timed out waiting for gateway auth response".to_string(),
                latency_ms: None,
            });
        }
        let remaining = deadline.saturating_duration_since(now);
        let next = tokio::time::timeout(remaining, socket.next()).await;
        match next {
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(text)))) => {
                let frame: Value = match serde_json::from_str(&text) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                if frame.get("type").and_then(|v| v.as_str()) != Some("res") {
                    continue;
                }
                let ok = frame.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
                if ok {
                    return Ok(TestRemoteResult {
                        ok: true,
                        message: "Connected and authenticated successfully".to_string(),
                        latency_ms: Some(start.elapsed().as_millis() as u64),
                    });
                }
                let message = frame
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .or_else(|| frame.get("error").and_then(|v| v.as_str()))
                    .unwrap_or("Authentication failed");
                return Ok(TestRemoteResult {
                    ok: false,
                    message: message.to_string(),
                    latency_ms: None,
                });
            }
            Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Ping(p)))) => {
                let _ = socket
                    .send(tokio_tungstenite::tungstenite::Message::Pong(p))
                    .await;
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(e))) => {
                return Ok(TestRemoteResult {
                    ok: false,
                    message: format!("Connection failed during auth handshake: {}", e),
                    latency_ms: None,
                });
            }
            Ok(None) => {
                return Ok(TestRemoteResult {
                    ok: false,
                    message: "Gateway closed during auth handshake".to_string(),
                    latency_ms: None,
                });
            }
            Err(_) => {
                return Ok(TestRemoteResult {
                    ok: false,
                    message: "Timed out waiting for gateway auth response".to_string(),
                    latency_ms: None,
                });
            }
        }
    }
}

// Config tab commands (read/write openclaw.json).

#[tauri::command]
pub async fn get_openclaw_json(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "config.get",
        "params": {}
    })
    .to_string();
    let snapshot = gateway_service.request(req).await?;
    Ok(snapshot
        .get("config")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new())))
}

#[tauri::command]
pub async fn save_openclaw_json(
    content: serde_json::Value,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<()> {
    let snapshot_req = json!({
        "type": "req",
        "id": req_id(),
        "method": "config.get",
        "params": {}
    })
    .to_string();
    let snapshot = gateway_service.request(snapshot_req).await?;

    let raw = serde_json::to_string_pretty(&content).map_err(|e| {
        crate::error::OpenClawError::Internal(format!("Failed to encode config JSON: {}", e))
    })?;
    let mut params = Map::new();
    params.insert("raw".to_string(), Value::String(raw));
    if let Some(base_hash) = snapshot.get("hash").and_then(|v| v.as_str()) {
        params.insert("baseHash".to_string(), Value::String(base_hash.to_string()));
    }

    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "config.set",
        "params": Value::Object(params)
    })
    .to_string();
    gateway_service.request(req).await.map(|_| ())
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSchemaResponse {
    pub schema: Value,
    pub uihints: Value,
}

#[tauri::command]
pub async fn get_config_schema(
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<ConfigSchemaResponse> {
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "config.schema",
        "params": {}
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    Ok(ConfigSchemaResponse {
        schema: result.get("schema").cloned().unwrap_or(Value::Null),
        uihints: result
            .get("uihints")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new())),
    })
}

// Channels tab commands.

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInfo {
    pub id: String,
    pub name: String,
    pub detail_name: String,
    pub system_image: Option<String>,
    pub provider: String,
    pub api_key_set: bool,
    pub configured: bool,
    pub linked: bool,
    pub running: bool,
    pub connected: bool,
    pub has_error: bool,
    pub supports_api_key: bool,
    pub status_label: String,
    pub details: Option<String>,
    pub last_checked_ms: Option<u64>,
    pub last_checked_at: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GetChannelsPayload {
    #[serde(default)]
    pub probe: bool,
    pub timeout_ms: Option<u64>,
}

fn channel_api_fields(channel_id: &str) -> &'static [&'static str] {
    match channel_id {
        "telegram" => &["botToken"],
        "discord" => &["token"],
        "slack" => &["botToken"],
        "msteams" => &["appPassword"],
        _ => &[],
    }
}

fn channel_meta_field(meta: &[Value], channel_id: &str, field: &str) -> Option<String> {
    meta.iter().find_map(|entry| {
        let id = entry.get("id").and_then(|v| v.as_str())?;
        if id != channel_id {
            return None;
        }
        first_non_empty_string(entry.get(field))
    })
}

fn first_non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
}

fn channel_has_configured(summary: &Value, accounts: &[Value]) -> bool {
    summary
        .get("configured")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || accounts.iter().any(|acc| {
            acc.get("configured")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        })
}

fn channel_flag(summary: &Value, accounts: &[Value], key: &str) -> bool {
    summary.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
        || accounts
            .iter()
            .any(|acc| acc.get(key).and_then(|v| v.as_bool()).unwrap_or(false))
}

fn channel_error(summary: &Value, accounts: &[Value]) -> Option<String> {
    first_non_empty_string(summary.get("lastError")).or_else(|| {
        accounts
            .iter()
            .find_map(|acc| first_non_empty_string(acc.get("lastError")))
    })
}

fn bool_at(summary: &Value, path: &[&str]) -> Option<bool> {
    let mut current = summary;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_bool()
}

fn string_at(summary: &Value, path: &[&str]) -> Option<String> {
    let mut current = summary;
    for segment in path {
        current = current.get(*segment)?;
    }
    first_non_empty_string(Some(current))
}

fn number_at(summary: &Value, path: &[&str]) -> Option<f64> {
    let mut current = summary;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_f64()
}

fn integer_at(summary: &Value, path: &[&str]) -> Option<i64> {
    let mut current = summary;
    for segment in path {
        current = current.get(*segment)?;
    }
    current.as_i64()
}

fn human_age_ms(ms: f64) -> String {
    let mut seconds = (ms / 1000.0).round() as i64;
    if seconds <= 0 {
        return "0s".to_string();
    }
    let days = seconds / 86_400;
    seconds -= days * 86_400;
    let hours = seconds / 3_600;
    seconds -= hours * 3_600;
    let minutes = seconds / 60;
    seconds -= minutes * 60;

    if days > 0 {
        format!("{}d {}h", days, hours)
    } else if hours > 0 {
        format!("{}h {}m", hours, minutes)
    } else if minutes > 0 {
        format!("{}m {}s", minutes, seconds)
    } else {
        format!("{}s", seconds)
    }
}

fn value_to_ms(value: Option<&Value>) -> Option<u64> {
    let number = value.and_then(|v| {
        v.as_u64()
            .or_else(|| {
                v.as_i64()
                    .and_then(|n| if n > 0 { Some(n as u64) } else { None })
            })
            .or_else(|| {
                v.as_f64().and_then(|n| {
                    if n.is_finite() && n > 0.0 {
                        Some(n as u64)
                    } else {
                        None
                    }
                })
            })
    })?;
    if number == 0 {
        None
    } else {
        Some(number)
    }
}

fn channel_last_check_ms(summary: &Value, accounts: &[Value]) -> Option<u64> {
    let mut latest = [
        "lastProbeAt",
        "lastEventAt",
        "lastMessageAt",
        "lastConnectedAt",
        "lastInboundAt",
        "lastOutboundAt",
    ]
    .iter()
    .filter_map(|key| value_to_ms(summary.get(*key)))
    .max();

    for account in accounts {
        let account_latest = [
            "lastProbeAt",
            "lastEventAt",
            "lastMessageAt",
            "lastConnectedAt",
            "lastInboundAt",
            "lastOutboundAt",
        ]
        .iter()
        .filter_map(|key| value_to_ms(account.get(*key)))
        .max();
        latest = match (latest, account_latest) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (None, Some(b)) => Some(b),
            (Some(a), None) => Some(a),
            (None, None) => None,
        };
    }

    latest
}

fn channel_has_error(channel_id: &str, summary: &Value, fallback_error: Option<&str>) -> bool {
    if fallback_error.is_some() {
        return true;
    }
    if bool_at(summary, &["probe", "ok"]) == Some(false) {
        return true;
    }
    if channel_id == "whatsapp" && bool_at(summary, &["lastDisconnect", "loggedOut"]) == Some(true)
    {
        return true;
    }
    false
}

fn channel_details(channel_id: &str, summary: &Value) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    match channel_id {
        "whatsapp" => {
            if let Some(identity) = string_at(summary, &["self", "e164"])
                .or_else(|| string_at(summary, &["self", "jid"]))
            {
                parts.push(format!("Linked as {}", identity));
            }
            if let Some(age_ms) = number_at(summary, &["authAgeMs"]) {
                parts.push(format!("Auth age {}", human_age_ms(age_ms)));
            }
            if let Some(reconnect_attempts) = integer_at(summary, &["reconnectAttempts"]) {
                if reconnect_attempts > 0 {
                    parts.push(format!("Reconnect attempts {}", reconnect_attempts));
                }
            }
            if let Some(status) = integer_at(summary, &["lastDisconnect", "status"]) {
                let reason = string_at(summary, &["lastDisconnect", "error"])
                    .unwrap_or_else(|| "disconnect".to_string());
                parts.push(format!("Last disconnect status {} ({})", status, reason));
            }
        }
        "telegram" => {
            if let Some(source) = string_at(summary, &["tokenSource"]) {
                parts.push(format!("Token source: {}", source));
            }
            if let Some(mode) = string_at(summary, &["mode"]) {
                parts.push(format!("Mode: {}", mode));
            }
            if let Some(bot) = string_at(summary, &["probe", "bot", "username"]) {
                parts.push(format!("Bot: @{}", bot));
            }
            if let Some(webhook) = string_at(summary, &["probe", "webhook", "url"]) {
                parts.push(format!("Webhook: {}", webhook));
            }
            if bool_at(summary, &["probe", "ok"]) == Some(false) {
                if let Some(code) = integer_at(summary, &["probe", "status"]) {
                    parts.push(format!("Probe failed ({})", code));
                } else {
                    parts.push("Probe failed".to_string());
                }
            }
        }
        "discord" => {
            if let Some(source) = string_at(summary, &["tokenSource"]) {
                parts.push(format!("Token source: {}", source));
            }
            if let Some(bot) = string_at(summary, &["probe", "bot", "username"]) {
                parts.push(format!("Bot: @{}", bot));
            }
            if let Some(elapsed) = number_at(summary, &["probe", "elapsedMs"]) {
                parts.push(format!("Probe {}ms", elapsed.round() as i64));
            }
            if bool_at(summary, &["probe", "ok"]) == Some(false) {
                if let Some(code) = integer_at(summary, &["probe", "status"]) {
                    parts.push(format!("Probe failed ({})", code));
                }
            }
        }
        "googlechat" => {
            if let Some(source) = string_at(summary, &["credentialSource"]) {
                parts.push(format!("Credential: {}", source));
            }
            let audience_type = string_at(summary, &["audienceType"]);
            let audience = string_at(summary, &["audience"]);
            if let Some(t) = audience_type {
                if let Some(a) = audience {
                    parts.push(format!("Audience: {} {}", t, a));
                } else {
                    parts.push(format!("Audience: {}", t));
                }
            }
            if let Some(elapsed) = number_at(summary, &["probe", "elapsedMs"]) {
                parts.push(format!("Probe {}ms", elapsed.round() as i64));
            }
        }
        "signal" => {
            if let Some(base_url) = string_at(summary, &["baseUrl"]) {
                parts.push(format!("Base URL: {}", base_url));
            }
            if let Some(version) = string_at(summary, &["probe", "version"]) {
                parts.push(format!("Version {}", version));
            }
            if let Some(elapsed) = number_at(summary, &["probe", "elapsedMs"]) {
                parts.push(format!("Probe {}ms", elapsed.round() as i64));
            }
            if bool_at(summary, &["probe", "ok"]) == Some(false) {
                if let Some(code) = integer_at(summary, &["probe", "status"]) {
                    parts.push(format!("Probe failed ({})", code));
                }
            }
        }
        "imessage" => {
            if let Some(cli_path) = string_at(summary, &["cliPath"]) {
                parts.push(format!("CLI: {}", cli_path));
            }
            if let Some(db_path) = string_at(summary, &["dbPath"]) {
                parts.push(format!("DB: {}", db_path));
            }
            if bool_at(summary, &["probe", "ok"]) == Some(false) {
                if let Some(err) = string_at(summary, &["probe", "error"]) {
                    parts.push(format!("Probe error: {}", err));
                }
            }
        }
        _ => {
            if let Some(source) = string_at(summary, &["tokenSource"]) {
                parts.push(format!("Token source: {}", source));
            }
            if let Some(source) = string_at(summary, &["credentialSource"]) {
                parts.push(format!("Credential source: {}", source));
            }
            if let Some(mode) = string_at(summary, &["mode"]) {
                parts.push(format!("Mode: {}", mode));
            }
            if let Some(base_url) = string_at(summary, &["baseUrl"]) {
                parts.push(format!("Base URL: {}", base_url));
            }
        }
    }

    if let Some(err) = string_at(summary, &["lastError"]) {
        parts.push(format!("Error: {}", err));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join(" · "))
    }
}

fn channel_status_label(
    channel_id: &str,
    has_error: bool,
    connected: bool,
    running: bool,
    linked: bool,
    configured: bool,
) -> String {
    if has_error {
        return "Error".to_string();
    }
    match channel_id {
        "whatsapp" => {
            if !linked && configured {
                "Not linked".to_string()
            } else if connected {
                "Connected".to_string()
            } else if running {
                "Running".to_string()
            } else if linked {
                "Linked".to_string()
            } else {
                "Not configured".to_string()
            }
        }
        _ => {
            if connected {
                "Connected".to_string()
            } else if running {
                "Running".to_string()
            } else if configured {
                "Configured".to_string()
            } else {
                "Not configured".to_string()
            }
        }
    }
}

fn upsert_channel_secret(
    config: &mut Value,
    channel_id: &str,
    default_account_id: Option<&str>,
    api_key: &str,
) -> bool {
    let fields = channel_api_fields(channel_id);
    if fields.is_empty() {
        return false;
    }

    let root = match config.as_object_mut() {
        Some(root) => root,
        None => return false,
    };
    let channels_value = root
        .entry("channels".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let channels_obj = match channels_value.as_object_mut() {
        Some(obj) => obj,
        None => return false,
    };
    let channel_value = channels_obj
        .entry(channel_id.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    let channel_obj = match channel_value.as_object_mut() {
        Some(obj) => obj,
        None => return false,
    };

    if let Some(account_id) = default_account_id.map(str::trim).filter(|s| !s.is_empty()) {
        let accounts_value = channel_obj
            .entry("accounts".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(accounts_obj) = accounts_value.as_object_mut() {
            let account_value = accounts_obj
                .entry(account_id.to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(account_obj) = account_value.as_object_mut() {
                let field = fields
                    .iter()
                    .find(|candidate| account_obj.contains_key(**candidate))
                    .copied()
                    .unwrap_or(fields[0]);
                account_obj.insert(field.to_string(), Value::String(api_key.to_string()));
                return true;
            }
        }
    }

    let field = fields
        .iter()
        .find(|candidate| channel_obj.contains_key(**candidate))
        .copied()
        .unwrap_or(fields[0]);
    channel_obj.insert(field.to_string(), Value::String(api_key.to_string()));
    true
}

#[tauri::command]
pub async fn get_channels(
    payload: Option<GetChannelsPayload>,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<Vec<ChannelInfo>> {
    let payload = payload.unwrap_or_default();
    let timeout_ms = payload.timeout_ms.unwrap_or(8000);
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "channels.status",
        "params": {
            "probe": payload.probe,
            "timeoutMs": timeout_ms
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;

    let mut channel_ids: Vec<String> = result
        .get("channelOrder")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default();

    if channel_ids.is_empty() {
        channel_ids = result
            .get("channelLabels")
            .and_then(|v| v.as_object())
            .map(|labels| labels.keys().cloned().collect())
            .unwrap_or_default();
    }

    if channel_ids.is_empty() {
        channel_ids = result
            .get("channels")
            .and_then(|v| v.as_object())
            .map(|channels| channels.keys().cloned().collect())
            .unwrap_or_default();
    }

    let labels = result
        .get("channelLabels")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let detail_labels = result
        .get("channelDetailLabels")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let system_images = result
        .get("channelSystemImages")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let channel_meta = result
        .get("channelMeta")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let channels_map = result
        .get("channels")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let channel_accounts = result
        .get("channelAccounts")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let channels = channel_ids
        .into_iter()
        .map(|id| {
            let summary = channels_map.get(&id).cloned().unwrap_or(Value::Null);
            let accounts = channel_accounts
                .get(&id)
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let configured = channel_has_configured(&summary, &accounts);
            let linked = channel_flag(&summary, &accounts, "linked");
            let running = channel_flag(&summary, &accounts, "running");
            let connected = channel_flag(&summary, &accounts, "connected");
            let error_message = channel_error(&summary, &accounts);
            let has_error = channel_has_error(&id, &summary, error_message.as_deref());
            let supports_api_key = !channel_api_fields(&id).is_empty();
            let name = channel_meta_field(&channel_meta, &id, "label")
                .or_else(|| {
                    labels
                        .get(&id)
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| id.clone());
            let detail_name = channel_meta_field(&channel_meta, &id, "detailLabel")
                .or_else(|| {
                    detail_labels
                        .get(&id)
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| name.clone());
            let system_image =
                channel_meta_field(&channel_meta, &id, "systemImage").or_else(|| {
                    system_images
                        .get(&id)
                        .and_then(|v| v.as_str())
                        .map(ToString::to_string)
                });
            ChannelInfo {
                id: id.clone(),
                name,
                detail_name,
                system_image,
                provider: id.clone(),
                api_key_set: configured,
                configured,
                linked,
                running,
                connected,
                has_error,
                supports_api_key,
                status_label: channel_status_label(
                    &id, has_error, connected, running, linked, configured,
                ),
                details: channel_details(&id, &summary),
                last_checked_ms: channel_last_check_ms(&summary, &accounts),
                last_checked_at: None,
                error_message,
            }
        })
        .collect();

    Ok(channels)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetChannelApiKeyPayload {
    pub channel_id: String,
    pub api_key: String,
}

#[tauri::command]
pub async fn set_channel_api_key(
    payload: SetChannelApiKeyPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    let channel_id = payload.channel_id.trim().to_ascii_lowercase();
    let api_key = payload.api_key.trim();
    if channel_id.is_empty() || api_key.is_empty() {
        return Err(crate::error::OpenClawError::Internal(
            "channelId and apiKey are required".to_string(),
        ));
    }
    if channel_api_fields(&channel_id).is_empty() {
        return Err(crate::error::OpenClawError::Internal(format!(
            "Channel '{}' does not support single-key setup in this UI",
            channel_id
        )));
    }

    let config_get_req = json!({
        "type": "req",
        "id": req_id(),
        "method": "config.get",
        "params": {}
    })
    .to_string();
    let config_snapshot = gateway_service.request(config_get_req).await?;

    let channels_status_req = json!({
        "type": "req",
        "id": req_id(),
        "method": "channels.status",
        "params": {
            "probe": false,
            "timeoutMs": 8000
        }
    })
    .to_string();
    let channels_status = gateway_service.request(channels_status_req).await?;
    let default_account_id = channels_status
        .get("channelDefaultAccountId")
        .and_then(|v| v.get(&channel_id))
        .and_then(|v| v.as_str())
        .map(ToString::to_string);

    let mut next_config = config_snapshot
        .get("config")
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !upsert_channel_secret(
        &mut next_config,
        &channel_id,
        default_account_id.as_deref(),
        api_key,
    ) {
        return Err(crate::error::OpenClawError::Internal(format!(
            "Unable to update API key for channel '{}'",
            channel_id
        )));
    }

    let raw = serde_json::to_string_pretty(&next_config).map_err(|e| {
        crate::error::OpenClawError::Internal(format!("Failed to encode config JSON: {}", e))
    })?;
    let mut set_params = Map::new();
    set_params.insert("raw".to_string(), Value::String(raw));
    if let Some(base_hash) = config_snapshot.get("hash").and_then(|v| v.as_str()) {
        set_params.insert("baseHash".to_string(), Value::String(base_hash.to_string()));
    }
    let config_set_req = json!({
        "type": "req",
        "id": req_id(),
        "method": "config.set",
        "params": Value::Object(set_params)
    })
    .to_string();

    gateway_service.request(config_set_req).await
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhatsAppLoginStartPayload {
    #[serde(default)]
    pub force: bool,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhatsAppLoginStartResult {
    pub qr_data_url: Option<String>,
    pub message: String,
}

#[tauri::command]
pub async fn channels_whatsapp_login_start(
    payload: Option<WhatsAppLoginStartPayload>,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<WhatsAppLoginStartResult> {
    let payload = payload.unwrap_or(WhatsAppLoginStartPayload {
        force: false,
        timeout_ms: Some(30_000),
    });
    let timeout_ms = payload.timeout_ms.unwrap_or(30_000);
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "web.login.start",
        "params": {
            "force": payload.force,
            "timeoutMs": timeout_ms
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    let qr_data_url = first_non_empty_string(result.get("qrDataUrl"));
    let message = first_non_empty_string(result.get("message"))
        .unwrap_or_else(|| "Started WhatsApp login flow".to_string());

    Ok(WhatsAppLoginStartResult {
        qr_data_url,
        message,
    })
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhatsAppLoginWaitPayload {
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WhatsAppLoginWaitResult {
    pub connected: bool,
    pub message: String,
}

#[tauri::command]
pub async fn channels_whatsapp_login_wait(
    payload: Option<WhatsAppLoginWaitPayload>,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<WhatsAppLoginWaitResult> {
    let payload = payload.unwrap_or(WhatsAppLoginWaitPayload {
        timeout_ms: Some(120_000),
    });
    let timeout_ms = payload.timeout_ms.unwrap_or(120_000);
    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "web.login.wait",
        "params": {
            "timeoutMs": timeout_ms
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    let connected = result
        .get("connected")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let message = first_non_empty_string(result.get("message")).unwrap_or_else(|| {
        if connected {
            "Login completed".to_string()
        } else {
            "Login wait timed out".to_string()
        }
    });

    Ok(WhatsAppLoginWaitResult { connected, message })
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelLogoutPayload {
    pub channel: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChannelLogoutResult {
    pub channel: Option<String>,
    pub account_id: Option<String>,
    pub cleared: bool,
    pub env_token: Option<bool>,
}

#[tauri::command]
pub async fn channels_logout(
    payload: ChannelLogoutPayload,
    gateway_service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<ChannelLogoutResult> {
    let channel = payload.channel.trim().to_ascii_lowercase();
    if channel.is_empty() {
        return Err(crate::error::OpenClawError::Internal(
            "channel is required".to_string(),
        ));
    }

    let req = json!({
        "type": "req",
        "id": req_id(),
        "method": "channels.logout",
        "params": {
            "channel": channel
        }
    })
    .to_string();

    let result = gateway_service.request(req).await?;
    let cleared = result
        .get("cleared")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    Ok(ChannelLogoutResult {
        channel: first_non_empty_string(result.get("channel")),
        account_id: first_non_empty_string(result.get("accountId")),
        cleared,
        env_token: result.get("envToken").and_then(|v| v.as_bool()),
    })
}

#[cfg(test)]
mod tests {
    use super::{
        apply_gateway_connection_preferences, connection_profile_changed,
        node_capability_profile_changed, normalize_ws_url, parse_ssh_target, FullConfigResponse,
    };
    use crate::models::config::Config;

    #[test]
    fn parses_ssh_target_with_user_and_port() {
        let parsed = parse_ssh_target("dev@example.com:2201");
        assert_eq!(parsed, Some(("example.com".to_string(), 2201)));
    }

    #[test]
    fn parses_ssh_target_with_default_port() {
        let parsed = parse_ssh_target("dev@example.com");
        assert_eq!(parsed, Some(("example.com".to_string(), 22)));
    }

    #[test]
    fn converts_https_url_to_wss_with_ws_path() {
        let url = normalize_ws_url("https://gateway.example.com", 0).unwrap();
        assert_eq!(url, "wss://gateway.example.com/ws");
    }

    #[test]
    fn accepts_ws_url_as_is() {
        let url = normalize_ws_url("ws://127.0.0.1:18789/ws", 0).unwrap();
        assert_eq!(url, "ws://127.0.0.1:18789/ws");
    }

    #[test]
    fn rejects_host_without_port() {
        let err = normalize_ws_url("127.0.0.1", 0).unwrap_err();
        assert!(err.contains("Port must be greater than 0"));
    }

    #[test]
    fn remote_direct_updates_runtime_address_port() {
        let mut config = Config::default();
        config.gateway_mode = "remote-direct".to_string();
        config.remote_url = Some("wss://gateway.example.com:443".to_string());

        apply_gateway_connection_preferences(&mut config);

        assert_eq!(config.gateway_type, "remote");
        assert_eq!(config.address, "gateway.example.com");
        assert_eq!(config.port, 443);
    }

    #[test]
    fn remote_direct_uses_ws_default_port_when_omitted() {
        let mut config = Config::default();
        config.gateway_mode = "remote-direct".to_string();
        config.remote_url = Some("ws://gateway.example.com".to_string());

        apply_gateway_connection_preferences(&mut config);

        assert_eq!(config.address, "gateway.example.com");
        assert_eq!(config.port, 18789);
    }

    #[test]
    fn remote_direct_uses_wss_default_port_when_omitted() {
        let mut config = Config::default();
        config.gateway_mode = "remote-direct".to_string();
        config.remote_url = Some("wss://gateway.example.com".to_string());

        apply_gateway_connection_preferences(&mut config);

        assert_eq!(config.address, "gateway.example.com");
        assert_eq!(config.port, 443);
    }

    #[test]
    fn remote_ssh_sets_host_and_default_port() {
        let mut config = Config::default();
        config.gateway_mode = "remote-ssh".to_string();
        config.remote_ssh_target = Some("dev@example.com:22".to_string());

        apply_gateway_connection_preferences(&mut config);

        assert_eq!(config.gateway_type, "remote-ssh");
        assert_eq!(config.address, "example.com");
        assert_eq!(config.port, 18789);
        assert_eq!(config.ssh_host, Some("example.com".to_string()));
    }

    #[test]
    fn local_mode_forces_loopback_runtime_target() {
        let mut config = Config::default();
        config.gateway_mode = "local".to_string();
        config.gateway_type = "remote".to_string();
        config.address = "10.0.0.2".to_string();
        config.port = 0;

        apply_gateway_connection_preferences(&mut config);

        assert_eq!(config.address, "127.0.0.1");
        assert_eq!(config.port, 18789);
        assert_eq!(config.gateway_type, "local");
    }

    #[test]
    fn detects_connection_profile_change() {
        let mut before = Config::default();
        before.gateway_mode = "local".to_string();
        before.address = "127.0.0.1".to_string();
        before.port = 18789;

        let mut after = before.clone();
        after.gateway_mode = "remote-direct".to_string();
        after.remote_url = Some("wss://gateway.example.com".to_string());

        assert!(connection_profile_changed(&before, &after));
    }

    #[test]
    fn detects_node_capability_profile_change() {
        let mut before = Config::default();
        before.camera_enabled = false;

        let mut after = before.clone();
        after.camera_enabled = true;

        assert!(node_capability_profile_changed(&before, &after));
    }

    #[test]
    fn full_config_response_serializes_with_camel_case_keys() {
        let mut config = Config::default();
        config.start_on_login = true;
        config.debug_pane_enabled = true;
        config.gateway_mode = "remote-direct".to_string();

        let payload = FullConfigResponse::from(config);
        let value = serde_json::to_value(payload).expect("serializes");

        assert_eq!(
            value.get("startOnLogin").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            value.get("debugPaneEnabled").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            value.get("gatewayMode").and_then(|v| v.as_str()),
            Some("remote-direct")
        );
        assert!(value.get("start_on_login").is_none());
    }
}
