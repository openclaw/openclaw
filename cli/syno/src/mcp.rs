//! MCP (Model Context Protocol) SSE server for Synology API.
//!
//! Exposes Synology NAS operations as MCP tools over HTTP SSE transport.
//! Clients connect via GET /sse and send requests via POST /messages?sessionId=xxx.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, Sse};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio_stream::wrappers::ReceiverStream;
use tokio_stream::StreamExt;

use crate::api::{auth, client::SynoClient, download_station, file_station, note_station, system};
use crate::crypto;
use crate::markdown;

// 鈹€鈹€ Types 鈹€鈹€

/// A cached Synology session (NAS connection).
struct NasSession {
    client: SynoClient,
    sid: String,
    synotoken: Option<String>,
    created: Instant,
}

/// An SSE client connection.
struct SseClient {
    tx: mpsc::Sender<Result<Event, axum::Error>>,
    #[allow(dead_code)]
    created: Instant,
}

/// NAS connection config extracted from HTTP headers.
#[derive(Clone)]
struct NasConfig {
    host: String,
    port: u16,
    https: bool,
    username: String,
    password: String,
}

impl NasConfig {
    /// Try to extract from HTTP headers. Returns None if required headers are missing.
    fn from_headers(headers: &axum::http::HeaderMap) -> Option<Self> {
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
struct AppState {
    /// MCP session_id 鈫?SSE client sender
    sse_clients: Mutex<HashMap<String, SseClient>>,
    /// NAS session_id 鈫?authenticated NAS connection
    nas_sessions: Mutex<HashMap<String, NasSession>>,
    /// MCP session_id 鈫?NAS config from headers (for auto re-login)
    session_configs: Mutex<HashMap<String, NasConfig>>,
}

#[derive(Deserialize)]
struct SessionQuery {
    #[serde(rename = "sessionId")]
    session_id: String,
}

// 鈹€鈹€ JSON-RPC 鈹€鈹€

#[derive(Deserialize)]
struct JsonRpcRequest {
    #[allow(dead_code)]
    jsonrpc: Option<String>,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

impl JsonRpcResponse {
    fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    fn error(id: Value, code: i64, message: &str) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(json!({ "code": code, "message": message })),
        }
    }
}

// 鈹€鈹€ Tool definitions 鈹€鈹€

fn tool_definitions() -> Value {
    json!({
        "tools": [
            {
                "name": "syno_login",
                "description": "Login to a Synology NAS. Returns a nas_session_id for subsequent calls. If the SSE connection was established with X-Syno-* headers, a session is auto-created and this call is optional.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "host": { "type": "string", "description": "NAS host (IP or domain)" },
                        "port": { "type": "integer", "description": "NAS port (default 5000)" },
                        "https": { "type": "boolean", "description": "Use HTTPS (default false)" },
                        "username": { "type": "string", "description": "Login username" },
                        "password": { "type": "string", "description": "Login password" },
                        "otp": { "type": "string", "description": "OTP code for 2FA (optional)" }
                    },
                    "required": ["host", "username", "password"]
                }
            },
            {
                "name": "syno_info",
                "description": "Get NAS system info (model, DSM version, temperature, uptime).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." }
                    },
                    "required": []
                }
            },
            {
                "name": "syno_fs_ls",
                "description": "List files in a folder, or list shared folders if no path given.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "path": { "type": "string", "description": "Folder path (e.g. /volume1/homes). Omit to list shared folders." },
                        "offset": { "type": "integer", "description": "Pagination offset (default 0)" },
                        "limit": { "type": "integer", "description": "Pagination limit (default 100)" }
                    },
                    "required": []
                }
            },
            {
                "name": "syno_fs_info",
                "description": "Get info about a file or folder.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "path": { "type": "string", "description": "File or folder path" }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "syno_fs_mkdir",
                "description": "Create a folder.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "folder_path": { "type": "string", "description": "Parent folder path" },
                        "name": { "type": "string", "description": "New folder name" }
                    },
                    "required": ["folder_path", "name"]
                }
            },
            {
                "name": "syno_fs_rename",
                "description": "Rename a file or folder.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "path": { "type": "string", "description": "Full path of the file/folder" },
                        "name": { "type": "string", "description": "New name" }
                    },
                    "required": ["path", "name"]
                }
            },
            {
                "name": "syno_fs_delete",
                "description": "Delete a file or folder (moves to recycle bin).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "path": { "type": "string", "description": "Full path to delete" }
                    },
                    "required": ["path"]
                }
            },
            {
                "name": "syno_dl_ls",
                "description": "List DownloadStation tasks.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." }
                    },
                    "required": []
                }
            },
            {
                "name": "syno_dl_create",
                "description": "Create a download task by URL.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "uri": { "type": "string", "description": "Download URL" },
                        "destination": { "type": "string", "description": "Destination folder on NAS (optional)" }
                    },
                    "required": ["uri"]
                }
            },
            {
                "name": "syno_dl_delete",
                "description": "Delete download tasks by IDs.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "ids": { "type": "string", "description": "Comma-separated task IDs" }
                    },
                    "required": ["ids"]
                }
            },
            {
                "name": "syno_dl_pause",
                "description": "Pause download tasks.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "ids": { "type": "string", "description": "Comma-separated task IDs" }
                    },
                    "required": ["ids"]
                }
            },
            {
                "name": "syno_dl_resume",
                "description": "Resume download tasks.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "ids": { "type": "string", "description": "Comma-separated task IDs" }
                    },
                    "required": ["ids"]
                }
            },
            {
                "name": "syno_note_notebooks",
                "description": "List all notebooks in NoteStation.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." }
                    },
                    "required": []
                }
            },
            {
                "name": "syno_note_list",
                "description": "List notes. Optionally filter by notebook.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "notebook": { "type": "string", "description": "Notebook ID to filter (optional)" },
                        "offset": { "type": "integer", "description": "Pagination offset (default 0)" },
                        "limit": { "type": "integer", "description": "Pagination limit (default 50)" }
                    },
                    "required": []
                }
            },
            {
                "name": "syno_note_get",
                "description": "Get a note by ID with full content. Supports encrypted notes with password.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID" },
                        "password": { "type": "string", "description": "Password for encrypted notes (optional)" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "syno_note_create",
                "description": "Create a note in a notebook. Content can be HTML or Markdown (set md=true).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "notebook_id": { "type": "string", "description": "Target notebook ID" },
                        "title": { "type": "string", "description": "Note title" },
                        "content": { "type": "string", "description": "Note content (HTML or Markdown)" },
                        "md": { "type": "boolean", "description": "Treat content as Markdown and convert to HTML (default false)" }
                    },
                    "required": ["notebook_id", "title"]
                }
            },
            {
                "name": "syno_note_update",
                "description": "Update a note's title and/or content.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID" },
                        "title": { "type": "string", "description": "New title (optional)" },
                        "content": { "type": "string", "description": "New content (optional)" },
                        "md": { "type": "boolean", "description": "Treat content as Markdown (default false)" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "syno_note_delete",
                "description": "Delete a note (moves to recycle bin).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "syno_note_search",
                "description": "Full-text search notes.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "keyword": { "type": "string", "description": "Search keyword" },
                        "exact": { "type": "boolean", "description": "Exact phrase match (default false)" },
                        "offset": { "type": "integer" },
                        "limit": { "type": "integer" }
                    },
                    "required": ["keyword"]
                }
            },
            {
                "name": "syno_note_tags",
                "description": "List all tags in NoteStation.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." }
                    },
                    "required": []
                }
            },
            {
                "name": "syno_note_tag",
                "description": "Add a tag to a note (tag auto-created if not exists).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID" },
                        "tag": { "type": "string", "description": "Tag name" }
                    },
                    "required": ["id", "tag"]
                }
            },
            {
                "name": "syno_note_untag",
                "description": "Remove a tag from a note.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID" },
                        "tag": { "type": "string", "description": "Tag name to remove" }
                    },
                    "required": ["id", "tag"]
                }
            },
            {
                "name": "syno_note_move",
                "description": "Move a note to another notebook.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID" },
                        "notebook_id": { "type": "string", "description": "Target notebook ID" }
                    },
                    "required": ["id", "notebook_id"]
                }
            },
            {
                "name": "syno_note_create_notebook",
                "description": "Create a new notebook.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "title": { "type": "string", "description": "Notebook title" }
                    },
                    "required": ["title"]
                }
            },
            {
                "name": "syno_note_rename_notebook",
                "description": "Rename a notebook.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Notebook object ID" },
                        "title": { "type": "string", "description": "New title" }
                    },
                    "required": ["id", "title"]
                }
            },
            {
                "name": "syno_note_delete_notebook",
                "description": "Delete a notebook.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Notebook object ID" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "syno_todo_list",
                "description": "List todos in NoteStation.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "done": { "type": "boolean", "description": "Filter by done status (optional)" },
                        "offset": { "type": "integer" },
                        "limit": { "type": "integer" }
                    },
                    "required": []
                }
            },
            {
                "name": "syno_todo_create",
                "description": "Create a todo.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "title": { "type": "string", "description": "Todo title" }
                    },
                    "required": ["title"]
                }
            },
            {
                "name": "syno_todo_update",
                "description": "Update a todo (title, done, star, due_date, comment, priority).",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Todo object ID" },
                        "title": { "type": "string" },
                        "done": { "type": "boolean" },
                        "star": { "type": "boolean" },
                        "due_date": { "type": "integer", "description": "Unix timestamp (-1 to clear)" },
                        "comment": { "type": "string" },
                        "priority": { "type": "string", "description": "none, low, medium, high" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "syno_todo_delete",
                "description": "Delete a todo.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Todo object ID" }
                    },
                    "required": ["id"]
                }
            },
            {
                "name": "syno_todo_done",
                "description": "Mark a todo as done or undone.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Todo object ID" },
                        "undo": { "type": "boolean", "description": "Set true to mark as undone (default false)" }
                    },
                    "required": ["id"]
                }
            }
        ]
    })
}

// 鈹€鈹€ Helper: get NAS session from state 鈹€鈹€

/// Perform login with the given config, return a NasSession.
async fn login_with_config(cfg: &NasConfig) -> Result<NasSession, String> {
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
async fn ensure_header_session(state: &AppState, mcp_session_id: &str) -> Result<(), String> {
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

async fn get_nas_session(
    state: &AppState,
    nas_session_id: &str,
) -> Result<(SynoClient, String, Option<String>), String> {
    // Auto re-login for header-based sessions
    if nas_session_id.starts_with("__header_") {
        // mcp_session_id is embedded in the key
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
    // Check 30 min expiry (header sessions auto-renew above, others expire)
    if !nas_session_id.starts_with("__header_") && s.created.elapsed() > Duration::from_secs(30 * 60) {
        drop(sessions);
        state.nas_sessions.lock().await.remove(nas_session_id);
        return Err("NAS session expired. Please call syno_login again.".to_string());
    }
    Ok((s.client.clone(), s.sid.clone(), s.synotoken.clone()))
}

/// Resolve the session ID: use provided value, or fall back to header-based session for this MCP connection.
fn resolve_session_id(params: &Value, mcp_session_id: &str, has_header_config: bool) -> Result<String, String> {
    match get_str(params, "nas_session_id") {
        Some(id) => Ok(id),
        None if has_header_config => Ok(format!("__header_{mcp_session_id}__")),
        None => Err("Missing nas_session_id. Please call syno_login first or configure X-Syno-* headers.".to_string()),
    }
}

fn get_str(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn get_u64(params: &Value, key: &str, default: u64) -> u64 {
    params.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

fn get_bool(params: &Value, key: &str, default: bool) -> bool {
    params.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn get_i64_opt(params: &Value, key: &str) -> Option<i64> {
    params.get(key).and_then(|v| v.as_i64())
}

fn get_bool_opt(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(|v| v.as_bool())
}

// 鈹€鈹€ Tool dispatch 鈹€鈹€

async fn handle_tool_call(state: &AppState, name: &str, params: &Value, mcp_session_id: &str) -> Value {
    match dispatch_tool(state, name, params, mcp_session_id).await {
        Ok(result) => json!({
            "content": [{ "type": "text", "text": result }]
        }),
        Err(e) => json!({
            "content": [{ "type": "text", "text": format!("Error: {e}") }],
            "isError": true
        }),
    }
}

async fn dispatch_tool(state: &AppState, name: &str, params: &Value, mcp_session_id: &str) -> Result<String, String> {
    let t0 = Instant::now();
    let has_header_config = {
        state.session_configs.lock().await.contains_key(mcp_session_id)
    };
    let t_config = t0.elapsed();
    match name {
        "syno_login" => tool_login(state, params).await,
        _ => {
            let sid = resolve_session_id(params, mcp_session_id, has_header_config)?;
            let t_resolve = t0.elapsed();
            let (client, nas_sid, token) = get_nas_session(state, &sid).await?;
            let t_session = t0.elapsed();
            eprintln!("[timing] {name}: config_check={t_config:?} resolve={t_resolve:?} get_session={t_session:?}");
            let token_ref = token.as_deref();

            match name {
                "syno_info" => tool_info(&client, &nas_sid, token_ref).await,
                "syno_fs_ls" => tool_fs_ls(&client, &nas_sid, token_ref, params).await,
                "syno_fs_info" => tool_fs_info(&client, &nas_sid, token_ref, params).await,
                "syno_fs_mkdir" => tool_fs_mkdir(&client, &nas_sid, token_ref, params).await,
                "syno_fs_rename" => tool_fs_rename(&client, &nas_sid, token_ref, params).await,
                "syno_fs_delete" => tool_fs_delete(&client, &nas_sid, token_ref, params).await,
                "syno_dl_ls" => tool_dl_ls(&client, &nas_sid, token_ref).await,
                "syno_dl_create" => tool_dl_create(&client, &nas_sid, token_ref, params).await,
                "syno_dl_delete" => tool_dl_action(&client, &nas_sid, token_ref, params, "delete").await,
                "syno_dl_pause" => tool_dl_action(&client, &nas_sid, token_ref, params, "pause").await,
                "syno_dl_resume" => tool_dl_action(&client, &nas_sid, token_ref, params, "resume").await,
                "syno_note_notebooks" => tool_note_notebooks(&client, &nas_sid, token_ref).await,
                "syno_note_list" => tool_note_list(&client, &nas_sid, token_ref, params).await,
                "syno_note_get" => tool_note_get(&client, &nas_sid, token_ref, params).await,
                "syno_note_create" => tool_note_create(&client, &nas_sid, token_ref, params).await,
                "syno_note_update" => tool_note_update(&client, &nas_sid, token_ref, params).await,
                "syno_note_delete" => tool_note_delete(&client, &nas_sid, token_ref, params).await,
                "syno_note_search" => tool_note_search(&client, &nas_sid, token_ref, params).await,
                "syno_note_tags" => tool_note_tags(&client, &nas_sid, token_ref).await,
                "syno_note_tag" => tool_note_tag(&client, &nas_sid, token_ref, params).await,
                "syno_note_untag" => tool_note_untag(&client, &nas_sid, token_ref, params).await,
                "syno_note_move" => tool_note_move(&client, &nas_sid, token_ref, params).await,
                "syno_note_create_notebook" => tool_note_create_notebook(&client, &nas_sid, token_ref, params).await,
                "syno_note_rename_notebook" => tool_note_rename_notebook(&client, &nas_sid, token_ref, params).await,
                "syno_note_delete_notebook" => tool_note_delete_notebook(&client, &nas_sid, token_ref, params).await,
                "syno_todo_list" => tool_todo_list(&client, &nas_sid, token_ref, params).await,
                "syno_todo_create" => tool_todo_create(&client, &nas_sid, token_ref, params).await,
                "syno_todo_update" => tool_todo_update(&client, &nas_sid, token_ref, params).await,
                "syno_todo_delete" => tool_todo_delete(&client, &nas_sid, token_ref, params).await,
                "syno_todo_done" => tool_todo_done(&client, &nas_sid, token_ref, params).await,
                _ => Err(format!("Unknown tool: {name}")),
            }
        }
    }
}

// 鈹€鈹€ Tool implementations 鈹€鈹€

async fn tool_login(state: &AppState, params: &Value) -> Result<String, String> {
    let host = get_str(params, "host")
        .ok_or("Missing host")?;
    let port = get_u64(params, "port", 5000) as u16;
    let https = get_bool(params, "https", false);
    let username = get_str(params, "username")
        .ok_or("Missing username")?;
    let password = get_str(params, "password")
        .ok_or("Missing password")?;
    let otp = get_str(params, "otp");

    let scheme = if https { "https" } else { "http" };
    let base_url = format!("{scheme}://{host}:{port}");
    let client = SynoClient::new(&base_url, https).map_err(|e| e.to_string())?;
    let data = auth::login(&client, &username, &password, otp.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let nas_session_id = uuid::Uuid::new_v4().to_string();
    let session = NasSession {
        client,
        sid: data.sid,
        synotoken: data.synotoken,
        created: Instant::now(),
    };
    state.nas_sessions.lock().await.insert(nas_session_id.clone(), session);

    Ok(serde_json::to_string_pretty(&json!({
        "nas_session_id": nas_session_id,
        "message": "Login successful"
    })).unwrap())
}

async fn tool_info(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
    let info = system::get_info(client, sid, token).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({
        "model": info.model,
        "serial": info.serial,
        "version": info.version_string,
        "temperature": info.temperature,
        "uptime": info.uptime
    })).unwrap())
}

async fn tool_fs_ls(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let path = get_str(params, "path");
    let offset = get_u64(params, "offset", 0);
    let limit = get_u64(params, "limit", 100);

    match path {
        None => {
            let shares = file_station::list_share(client, sid, token).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&json!({
                "shares": shares.shares.unwrap_or_default().iter().map(|s| json!({"name": s.name, "path": s.path})).collect::<Vec<_>>(),
                "total": shares.total
            })).unwrap())
        }
        Some(folder) => {
            let list = file_station::list(client, sid, token, &folder, offset, limit).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_string_pretty(&json!({
                "files": list.files.unwrap_or_default().iter().map(|f| json!({"name": f.name, "path": f.path, "isdir": f.isdir})).collect::<Vec<_>>(),
                "total": list.total
            })).unwrap())
        }
    }
}

async fn tool_fs_info(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let path = get_str(params, "path").ok_or("Missing path")?;
    let result = file_station::get_info(client, sid, token, &path).await.map_err(|e| e.to_string())?;
    let files: Vec<Value> = result.files.unwrap_or_default().iter().map(|f| {
        json!({"name": f.name, "path": f.path, "isdir": f.isdir, "additional": f.additional})
    }).collect();
    Ok(serde_json::to_string_pretty(&json!({"files": files})).unwrap())
}

async fn tool_fs_mkdir(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let folder_path = get_str(params, "folder_path").ok_or("Missing folder_path")?;
    let name = get_str(params, "name").ok_or("Missing name")?;
    let data = file_station::create_folder(client, sid, token, &folder_path, &name).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

async fn tool_fs_rename(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let path = get_str(params, "path").ok_or("Missing path")?;
    let name = get_str(params, "name").ok_or("Missing name")?;
    let data = file_station::rename(client, sid, token, &path, &name).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

async fn tool_fs_delete(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let path = get_str(params, "path").ok_or("Missing path")?;
    file_station::delete(client, sid, token, &path).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Deleted", "path": path}).to_string())
}

async fn tool_dl_ls(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
    let tasks = download_station::list(client, sid, token).await.map_err(|e| e.to_string())?;
    let items: Vec<Value> = tasks.tasks.unwrap_or_default().iter().map(|t| {
        json!({"id": t.id, "title": t.title, "status": t.status, "size": t.size})
    }).collect();
    Ok(serde_json::to_string_pretty(&json!({"tasks": items, "total": tasks.total})).unwrap())
}

async fn tool_dl_create(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let uri = get_str(params, "uri").ok_or("Missing uri")?;
    let dest = get_str(params, "destination");
    download_station::create(client, sid, token, &uri, dest.as_deref()).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Download task created"}).to_string())
}

async fn tool_dl_action(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value, action: &str) -> Result<String, String> {
    let ids = get_str(params, "ids").ok_or("Missing ids")?;
    match action {
        "delete" => download_station::delete(client, sid, token, &ids).await.map_err(|e| e.to_string())?,
        "pause" => download_station::pause(client, sid, token, &ids).await.map_err(|e| e.to_string())?,
        "resume" => download_station::resume(client, sid, token, &ids).await.map_err(|e| e.to_string())?,
        _ => return Err(format!("Unknown action: {action}")),
    }
    Ok(json!({"message": format!("Task(s) {action}d")}).to_string())
}

async fn tool_note_notebooks(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
    let t = Instant::now();
    let data = note_station::list_notebook(client, sid, token).await.map_err(|e| e.to_string())?;
    eprintln!("[timing] note_notebooks: api_call={:?}", t.elapsed());
    let notebooks: Vec<Value> = data["notebooks"]
        .as_array()
        .map(|arr| arr.iter().map(|nb| {
            // "items" contains the note count (array length or number)
            let count = nb["items"].as_array().map(|a| a.len() as u64)
                .or_else(|| nb["items"].as_u64());
            json!({
                "id": nb["object_id"],
                "title": nb["title"],
                "note_count": count,
            })
        }).collect())
        .unwrap_or_default();
    Ok(serde_json::to_string_pretty(&json!({
        "notebooks": notebooks,
        "total": data["total"],
    })).unwrap())
}

async fn tool_note_list(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let notebook = get_str(params, "notebook");
    let offset = get_u64(params, "offset", 0);
    let limit = get_u64(params, "limit", 50);
    let t = Instant::now();
    let data = note_station::list_note(client, sid, token, notebook.as_deref(), offset, limit)
        .await.map_err(|e| e.to_string())?;
    eprintln!("[timing] note_list: api_call={:?}", t.elapsed());
    let notes: Vec<Value> = data["notes"]
        .as_array()
        .map(|arr| arr.iter().map(|n| {
            let mut note = json!({
                "id": n["object_id"],
                "title": n["title"],
                "parent_id": n["parent_id"],
                "mtime": n["mtime"],
                "ctime": n["ctime"],
            });
            if let Some(brief) = n["brief"].as_str() {
                if !brief.is_empty() {
                    note["brief"] = Value::String(brief.chars().take(200).collect());
                }
            }
            if n["encrypt"].as_bool() == Some(true) {
                note["encrypt"] = json!(true);
            }
            if let Some(tags) = n["tag"].as_array() {
                if !tags.is_empty() {
                    note["tag"] = Value::Array(tags.clone());
                }
            }
            note
        }).collect())
        .unwrap_or_default();
    Ok(serde_json::to_string_pretty(&json!({
        "notes": notes,
        "total": data["total"],
        "offset": data["offset"],
    })).unwrap())
}

async fn tool_note_get(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let password = get_str(params, "password");

    let encrypt_token = match &password {
        Some(pw) => {
            let t = note_station::decrypt_note(client, sid, token, &id, pw)
                .await.map_err(|e| e.to_string())?;
            Some(t)
        }
        None => None,
    };

    let mut data = note_station::get_note(client, sid, token, &id, encrypt_token.as_deref())
        .await.map_err(|e| e.to_string())?;

    if let Some(pw) = &password {
        if let Some(content) = data["content"].as_str() {
            if let Ok(plaintext) = crypto::decrypt_aes256cbc(content, pw) {
                data["content"] = Value::String(plaintext);
            }
        }
        if let Some(title) = data["title"].as_str() {
            if title.starts_with("U2FsdGVkX1") {
                if let Ok(plain_title) = crypto::decrypt_aes256cbc(title, pw) {
                    data["title"] = Value::String(plain_title);
                }
            }
        }
    }

    let mut note = json!({
        "id": data["object_id"],
        "title": data["title"],
        "parent_id": data["parent_id"],
        "content": data["content"],
        "mtime": data["mtime"],
        "ctime": data["ctime"],
    });
    if data["encrypt"].as_bool() == Some(true) {
        note["encrypt"] = json!(true);
    }
    if let Some(tags) = data["tag"].as_array() {
        if !tags.is_empty() {
            note["tag"] = Value::Array(tags.clone());
        }
    }
    Ok(serde_json::to_string_pretty(&note).unwrap())
}

async fn tool_note_create(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let notebook_id = get_str(params, "notebook_id").ok_or("Missing notebook_id")?;
    let title = get_str(params, "title").ok_or("Missing title")?;
    let content = get_str(params, "content").unwrap_or_default();
    let md = get_bool(params, "md", false);
    let html = if md { markdown::md_to_html(&content) } else { content };
    let data = note_station::create_note(client, sid, token, &notebook_id, &title, &html)
        .await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

async fn tool_note_update(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let title = get_str(params, "title");
    let content = get_str(params, "content");
    let md = get_bool(params, "md", false);
    let html = content.map(|c| if md { markdown::md_to_html(&c) } else { c });
    if title.is_none() && html.is_none() {
        return Err("At least one of title or content must be provided".into());
    }
    let data = note_station::update_note(client, sid, token, &id, title.as_deref(), html.as_deref())
        .await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

async fn tool_note_delete(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    note_station::delete_note(client, sid, token, &id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Note deleted"}).to_string())
}

async fn tool_note_search(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let keyword = get_str(params, "keyword").ok_or("Missing keyword")?;
    let exact = get_bool(params, "exact", false);
    let offset = get_u64(params, "offset", 0);
    let limit = get_u64(params, "limit", 50);
    let data = note_station::search(client, sid, token, &keyword, exact, offset, limit)
        .await.map_err(|e| e.to_string())?;
    let notes: Vec<Value> = data["notes"]
        .as_array()
        .map(|arr| arr.iter().map(|n| {
            let mut note = json!({
                "id": n["object_id"],
                "title": n["title"],
                "parent_id": n["parent_id"],
                "mtime": n["mtime"],
            });
            if let Some(brief) = n["brief"].as_str() {
                if !brief.is_empty() {
                    note["brief"] = Value::String(brief.chars().take(200).collect());
                }
            }
            note
        }).collect())
        .unwrap_or_default();
    Ok(serde_json::to_string_pretty(&json!({
        "notes": notes,
        "total": data["total"],
    })).unwrap())
}

async fn tool_note_tags(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
    let data = note_station::list_tag(client, sid, token).await.map_err(|e| e.to_string())?;
    let tags: Vec<Value> = data["tags"]
        .as_array()
        .map(|arr| arr.iter().map(|t| json!({
            "id": t["object_id"],
            "name": t["name"],
            "note_count": t["note_count"],
        })).collect())
        .unwrap_or_default();
    Ok(serde_json::to_string_pretty(&json!({
        "tags": tags,
        "total": data["total"],
    })).unwrap())
}

async fn tool_note_tag(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let tag = get_str(params, "tag").ok_or("Missing tag")?;

    let data = note_station::get_note(client, sid, token, &id, None).await.map_err(|e| e.to_string())?;
    let ver = data["ver"].as_str().unwrap_or("").to_string();
    let mut tags: Vec<String> = data["tag"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    if !tags.contains(&tag) {
        tags.push(tag);
    }
    note_station::set_note_tags(client, sid, token, &id, &ver, &tags).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Tag added"}).to_string())
}

async fn tool_note_untag(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let tag = get_str(params, "tag").ok_or("Missing tag")?;

    let data = note_station::get_note(client, sid, token, &id, None).await.map_err(|e| e.to_string())?;
    let ver = data["ver"].as_str().unwrap_or("").to_string();
    let tags: Vec<String> = data["tag"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|t| t != &tag)
        .collect();
    note_station::set_note_tags(client, sid, token, &id, &ver, &tags).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Tag removed"}).to_string())
}

async fn tool_note_move(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let notebook_id = get_str(params, "notebook_id").ok_or("Missing notebook_id")?;
    note_station::move_note(client, sid, token, &id, &notebook_id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Note moved"}).to_string())
}

async fn tool_note_create_notebook(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let title = get_str(params, "title").ok_or("Missing title")?;
    let data = note_station::create_notebook(client, sid, token, &title).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

async fn tool_note_rename_notebook(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let title = get_str(params, "title").ok_or("Missing title")?;
    note_station::rename_notebook(client, sid, token, &id, &title).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Notebook renamed"}).to_string())
}

async fn tool_note_delete_notebook(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    note_station::delete_notebook(client, sid, token, &id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Notebook deleted"}).to_string())
}

async fn tool_todo_list(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let done = get_bool_opt(params, "done");
    let offset = get_u64(params, "offset", 0);
    let limit = get_u64(params, "limit", 100);
    let data = note_station::list_todo(client, sid, token, done, offset, limit)
        .await.map_err(|e| e.to_string())?;
    let todos: Vec<Value> = data["todos"]
        .as_array()
        .map(|arr| arr.iter().map(|t| {
            let mut todo = json!({
                "id": t["object_id"],
                "title": t["title"],
                "done": t["done"],
            });
            if t["star"].as_bool() == Some(true) {
                todo["star"] = json!(true);
            }
            if let Some(p) = t["priority"].as_i64() {
                if p != -1 {
                    todo["priority"] = json!(p);
                }
            }
            if let Some(d) = t["due_date"].as_i64() {
                if d > 0 {
                    todo["due_date"] = json!(d);
                }
            }
            if let Some(c) = t["comment"].as_str() {
                if !c.is_empty() {
                    todo["comment"] = Value::String(c.to_string());
                }
            }
            if let Some(items) = t["items"].as_array() {
                if !items.is_empty() {
                    todo["items"] = Value::Array(items.clone());
                }
            }
            todo
        }).collect())
        .unwrap_or_default();
    Ok(serde_json::to_string_pretty(&json!({
        "todos": todos,
        "total": data["total"],
    })).unwrap())
}

async fn tool_todo_create(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let title = get_str(params, "title").ok_or("Missing title")?;
    let data = note_station::create_todo(client, sid, token, &title).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

async fn tool_todo_update(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let title = get_str(params, "title");
    let done = get_bool_opt(params, "done");
    let star = get_bool_opt(params, "star");
    let due_date = get_i64_opt(params, "due_date");
    let comment = get_str(params, "comment");
    let priority_str = get_str(params, "priority");

    let priority_val = match priority_str.as_deref() {
        Some("none") => Some(-1i64),
        Some("low") => Some(100),
        Some("medium") | Some("med") => Some(200),
        Some("high") => Some(300),
        Some(other) => return Err(format!("Invalid priority '{other}'. Use: none, low, medium, high")),
        None => None,
    };

    let data = note_station::update_todo(
        client, sid, token, &id,
        title.as_deref(), done, star, due_date, comment.as_deref(), priority_val,
    ).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

async fn tool_todo_delete(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    note_station::delete_todo(client, sid, token, &id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Todo deleted"}).to_string())
}

async fn tool_todo_done(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let undo = get_bool(params, "undo", false);
    let done_val = !undo;
    note_station::update_todo(client, sid, token, &id, None, Some(done_val), None, None, None, None)
        .await.map_err(|e| e.to_string())?;
    Ok(json!({"message": if done_val { "Marked as done" } else { "Marked as undone" }}).to_string())
}

// 鈹€鈹€ MCP protocol handler 鈹€鈹€

async fn handle_jsonrpc(state: &AppState, req: JsonRpcRequest, mcp_session_id: &str) -> JsonRpcResponse {
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => {
            JsonRpcResponse::success(id, json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {}
                },
                "serverInfo": {
                    "name": "synology-mcp",
                    "version": "0.1.0"
                }
            }))
        }
        "notifications/initialized" => {
            // No response needed for notifications, but we return empty result
            JsonRpcResponse::success(id, json!({}))
        }
        "tools/list" => {
            JsonRpcResponse::success(id, tool_definitions())
        }
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let tool_name = params["name"].as_str().unwrap_or("");
            let tool_args = params.get("arguments").cloned().unwrap_or(json!({}));
            let result = handle_tool_call(state, tool_name, &tool_args, mcp_session_id).await;
            JsonRpcResponse::success(id, result)
        }
        "ping" => {
            JsonRpcResponse::success(id, json!({}))
        }
        _ => {
            JsonRpcResponse::error(id, -32601, &format!("Method not found: {}", req.method))
        }
    }
}

// 鈹€鈹€ HTTP handlers 鈹€鈹€

async fn sse_handler(
    State(state): State<Arc<AppState>>,
    headers: axum::http::HeaderMap,
) -> Sse<impl tokio_stream::Stream<Item = Result<Event, axum::Error>>> {
    let session_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::channel::<Result<Event, axum::Error>>(32);

    // Extract NAS config from headers and auto-login
    if let Some(cfg) = NasConfig::from_headers(&headers) {
        eprintln!("SSE {session_id}: headers auth detected ({}:{})", cfg.host, cfg.port);
        let t = Instant::now();
        match login_with_config(&cfg).await {
            Ok(session) => {
                eprintln!("[timing] SSE auto-login: {:?}", t.elapsed());
                let nas_key = format!("__header_{session_id}__");
                state.nas_sessions.lock().await.insert(nas_key, session);
                state.session_configs.lock().await.insert(session_id.clone(), cfg);
                eprintln!("SSE {session_id}: auto-login successful");
            }
            Err(e) => {
                eprintln!("SSE {session_id}: auto-login failed: {e} (config saved for retry)");
                state.session_configs.lock().await.insert(session_id.clone(), cfg);
            }
        }
    }

    // Send the endpoint event so client knows where to POST
    let endpoint_msg = format!("/messages?sessionId={session_id}");
    let _ = tx
        .send(Ok(Event::default().event("endpoint").data(endpoint_msg)))
        .await;

    state.sse_clients.lock().await.insert(
        session_id.clone(),
        SseClient {
            tx,
            created: Instant::now(),
        },
    );

    let stream = ReceiverStream::new(rx);
    // Send keepalive comments every 30s
    let keepalive = tokio_stream::StreamExt::map(
        tokio_stream::wrappers::IntervalStream::new(tokio::time::interval(Duration::from_secs(30))),
        |_| Ok(Event::default().comment("keepalive")),
    );
    let merged = stream.merge(keepalive);

    Sse::new(merged).keep_alive(
        axum::response::sse::KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keepalive"),
    )
}

async fn messages_handler(
    State(state): State<Arc<AppState>>,
    Query(query): Query<SessionQuery>,
    body: String,
) -> impl IntoResponse {
    let session_id = &query.session_id;

    // Parse JSON-RPC request
    let req: JsonRpcRequest = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(e) => {
            let err = JsonRpcResponse::error(Value::Null, -32700, &format!("Parse error: {e}"));
            return (StatusCode::BAD_REQUEST, axum::Json(serde_json::to_value(err).unwrap()));
        }
    };

    let is_notification = req.id.is_none()
        || req.method.starts_with("notifications/");

    // Handle the request, passing MCP session_id for NAS session resolution
    let response = handle_jsonrpc(&state, req, session_id).await;

    // Try to send via SSE
    let clients = state.sse_clients.lock().await;
    if let Some(client) = clients.get(session_id) {
        let response_json = serde_json::to_string(&response).unwrap_or_default();
        let event = Event::default().event("message").data(response_json);
        let _ = client.tx.send(Ok(event)).await;
    }

    if is_notification {
        (StatusCode::ACCEPTED, axum::Json(json!({})))
    } else {
        (StatusCode::ACCEPTED, axum::Json(json!({})))
    }
}

async fn health_handler() -> &'static str {
    "ok"
}

// 鈹€鈹€ Session cleanup task 鈹€鈹€

async fn cleanup_expired_sessions(state: Arc<AppState>) {
    let mut interval = tokio::time::interval(Duration::from_secs(60));
    loop {
        interval.tick().await;
        let now = Instant::now();

        // Clean stale SSE clients (2 hours) and collect removed IDs
        let removed_sse: Vec<String>;
        {
            let mut sse = state.sse_clients.lock().await;
            let before: std::collections::HashSet<String> = sse.keys().cloned().collect();
            sse.retain(|_, c| now.duration_since(c.created) < Duration::from_secs(2 * 60 * 60));
            let after: std::collections::HashSet<String> = sse.keys().cloned().collect();
            removed_sse = before.difference(&after).cloned().collect();
        }

        // Clean NAS sessions: expire non-header sessions (30 min), and remove header sessions for cleaned-up SSE clients
        {
            let mut nas = state.nas_sessions.lock().await;
            nas.retain(|key, s| {
                if key.starts_with("__header_") {
                    // Keep if the parent SSE session still exists
                    let mcp_id = key.strip_prefix("__header_").and_then(|k| k.strip_suffix("__")).unwrap_or("");
                    !removed_sse.contains(&mcp_id.to_string())
                } else {
                    now.duration_since(s.created) < Duration::from_secs(30 * 60)
                }
            });
        }

        // Clean session configs for removed SSE clients
        if !removed_sse.is_empty() {
            let mut configs = state.session_configs.lock().await;
            for id in &removed_sse {
                configs.remove(id);
            }
        }
    }
}

// ── Public entry point ──

pub async fn run_server(host: &str, port: u16) -> anyhow::Result<()> {
    let state = Arc::new(AppState {
        sse_clients: Mutex::new(HashMap::new()),
        nas_sessions: Mutex::new(HashMap::new()),
        session_configs: Mutex::new(HashMap::new()),
    });

    // Spawn cleanup task
    tokio::spawn(cleanup_expired_sessions(state.clone()));

    let app = Router::new()
        .route("/sse", get(sse_handler))
        .route("/messages", post(messages_handler))
        .route("/health", get(health_handler))
        .with_state(state);

    let addr = format!("{host}:{port}");
    eprintln!("Synology MCP server listening on {addr}");
    eprintln!("SSE endpoint: http://{addr}/sse");

    let listener = tokio::net::TcpListener::bind(&addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}
