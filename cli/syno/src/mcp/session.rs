//! NAS session management: types, login, session resolution.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};

use crate::api::{auth, client::SynoClient};

// ── Types ──

/// A cached Synology session (NAS connection).
pub(crate) struct NasSession {
    pub client: SynoClient,
    pub sid: String,
    pub synotoken: Option<String>,
    pub created: Instant,
}

/// An SSE client connection.
pub(crate) struct SseClient {
    pub tx: mpsc::Sender<Result<axum::response::sse::Event, axum::Error>>,
    #[allow(dead_code)]
    pub created: Instant,
}

/// NAS connection config extracted from HTTP headers.
#[derive(Clone)]
pub(crate) struct NasConfig {
    pub host: String,
    pub port: u16,
    pub https: bool,
    pub username: String,
    pub password: String,
}

impl NasConfig {
    /// Try to extract from HTTP headers. Returns None if required headers are missing.
    pub fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
        let host = headers.get("X-Syno-Host")?.to_str().ok().filter(|s| !s.is_empty())?.to_string();
        let username = headers.get("X-Syno-Username")?.to_str().ok().filter(|s| !s.is_empty())?.to_string();
        let password = headers.get("X-Syno-Password")?.to_str().ok().filter(|s| !s.is_empty())?.to_string();
        let port = headers.get("X-Syno-Port")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse().ok())
            .unwrap_or(5000);
        let https = headers.get("X-Syno-Https")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
        Some(Self { host, port, https, username, password })
    }
}

/// Shared application state.
pub(crate) struct AppState {
    /// MCP session_id → SSE client sender
    pub sse_clients: Mutex<HashMap<String, SseClient>>,
    /// NAS session_id → authenticated NAS connection
    pub nas_sessions: Mutex<HashMap<String, NasSession>>,
    /// MCP session_id → NAS config from headers (for auto re-login)
    pub session_configs: Mutex<HashMap<String, NasConfig>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sse_clients: Mutex::new(HashMap::new()),
            nas_sessions: Mutex::new(HashMap::new()),
            session_configs: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Deserialize)]
pub(crate) struct SessionQuery {
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

// ── Session helpers ──

/// Perform login with the given config, return a NasSession.
pub(crate) async fn login_with_config(cfg: &NasConfig) -> Result<NasSession, String> {
    let scheme = if cfg.https { "https" } else { "http" };
    let base_url = format!("{scheme}://{}:{}", cfg.host, cfg.port);
    let client = SynoClient::new(&base_url, cfg.https).map_err(|e| e.to_string())?;
    let data = auth::login(&client, &cfg.username, &cfg.password, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(NasSession {
        client,
        sid: data.sid,
        synotoken: data.synotoken,
        created: Instant::now(),
    })
}

/// Ensure the header-based session for an MCP session exists and is valid. Auto-(re)login if needed.
pub(crate) async fn ensure_header_session(state: &AppState, mcp_session_id: &str) -> Result<(), String> {
    let cfg = {
        let configs = state.session_configs.lock().await;
        configs.get(mcp_session_id).cloned()
    };
    let cfg = cfg.ok_or("No NAS session. Please call syno_login first or configure X-Syno-* headers.")?;

    let nas_key = format!("__header_{mcp_session_id}__");
    let need_login = {
        let sessions = state.nas_sessions.lock().await;
        match sessions.get(&nas_key) {
            None => true,
            Some(s) => s.created.elapsed() > Duration::from_secs(30 * 60),
        }
    };

    if need_login {
        let t = Instant::now();
        let session = login_with_config(&cfg).await?;
        eprintln!("[timing] ensure_header_session: login={:?}", t.elapsed());
        state.nas_sessions.lock().await.insert(nas_key, session);
    }
    Ok(())
}

pub(crate) async fn get_nas_session(
    state: &AppState,
    nas_session_id: &str,
) -> Result<(SynoClient, String, Option<String>), String> {
    // Auto re-login for header-based sessions
    if nas_session_id.starts_with("__header_") {
        let mcp_id = nas_session_id
            .strip_prefix("__header_")
            .and_then(|s| s.strip_suffix("__"))
            .unwrap_or("");
        ensure_header_session(state, mcp_id).await?;
    }

    let sessions = state.nas_sessions.lock().await;
    let s = sessions
        .get(nas_session_id)
        .ok_or_else(|| "Invalid or expired nas_session_id. Please call syno_login first.".to_string())?;
    if !nas_session_id.starts_with("__header_") && s.created.elapsed() > Duration::from_secs(30 * 60) {
        drop(sessions);
        state.nas_sessions.lock().await.remove(nas_session_id);
        return Err("NAS session expired. Please call syno_login again.".to_string());
    }
    Ok((s.client.clone(), s.sid.clone(), s.synotoken.clone()))
}

/// Direct session lookup without header/MCP session resolution (for stdio mode).
pub(crate) async fn get_nas_session_direct(
    state: &AppState,
    nas_session_id: &str,
) -> Result<(SynoClient, String, Option<String>), String> {
    let sessions = state.nas_sessions.lock().await;
    let s = sessions
        .get(nas_session_id)
        .ok_or_else(|| "NAS session not available. Restart the MCP stdio server.".to_string())?;
    Ok((s.client.clone(), s.sid.clone(), s.synotoken.clone()))
}

/// Resolve the session ID: use provided value, or fall back to header-based session.
pub(crate) fn resolve_session_id(params: &Value, mcp_session_id: &str, has_header_config: bool) -> Result<String, String> {
    match get_str(params, "nas_session_id") {
        Some(id) => Ok(id),
        None if has_header_config => Ok(format!("__header_{mcp_session_id}__")),
        None => Err("Missing nas_session_id. Please call syno_login first or configure X-Syno-* headers.".to_string()),
    }
}

// ── Param helpers ──

pub(crate) fn get_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub(crate) fn get_u64(params: &Value, key: &str, default: u64) -> u64 {
    params.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

pub(crate) fn get_bool(params: &Value, key: &str, default: bool) -> bool {
    params.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

pub(crate) fn get_i64_opt(params: &Value, key: &str) -> Option<i64> {
    params.get(key).and_then(|v| v.as_i64())
}

pub(crate) fn get_bool_opt(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| v.as_bool())
}

// ── Session cleanup task ──

pub(crate) async fn cleanup_expired_sessions(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        let now = Instant::now();

        let removed_sse: Vec<String>;
        {
            let mut sse = state.sse_clients.lock().await;
            let before: std::collections::HashSet<String> = sse.keys().cloned().collect();
            sse.retain(|_, c| now.duration_since(c.created) < Duration::from_secs(2 * 60 * 60));
            let after: std::collections::HashSet<String> = sse.keys().cloned().collect();
            removed_sse = before.difference(&after).cloned().collect();
        }

        {
            let mut nas = state.nas_sessions.lock().await;
            nas.retain(|key, s| {
                if key.starts_with("__header_") {
                    let mcp_id = key.strip_prefix("__header_").and_then(|k| k.strip_suffix("__")).unwrap_or("");
                    !removed_sse.contains(&mcp_id.to_string())
                } else {
                    now.duration_since(s.created) < Duration::from_secs(30 * 60)
                }
            });
        }

        if !removed_sse.is_empty() {
            let mut configs = state.session_configs.lock().await;
            for id in &removed_sse {
                configs.remove(id);
            }
        }
    }
}
