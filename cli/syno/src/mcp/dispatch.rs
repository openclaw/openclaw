//! JSON-RPC protocol handling and unified tool dispatch.

use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::api::client::SynoClient;

use super::session::*;
use super::tools::*;

// ── JSON-RPC types ──

#[derive(Deserialize)]
pub(crate) struct JsonRpcRequest {
    #[allow(dead_code)]
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: String,
    pub params: Option<Value>,
}

#[derive(Serialize)]
pub(crate) struct JsonRpcResponse {
    jsonrpc: String,
    id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<Value>,
}

impl JsonRpcResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, code: i64, message: &str) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(json!({ "code": code, "message": message })),
        }
    }
}

// ── Unified tool dispatch ──

/// Dispatch a tool call to the appropriate implementation.
/// This is the single dispatch table shared by both SSE and stdio modes.
pub(crate) async fn dispatch_tool_call(
    state: &AppState,
    name: &str,
    args: &Value,
    client: &SynoClient,
    sid: &str,
    token: Option<&str>,
) -> Result<String, String> {
    match name {
        "syno_login" => tool_login(state, args).await,
        "syno_info" => tool_info(client, sid, token).await,
        "syno_fs_ls" => tool_fs_ls(client, sid, token, args).await,
        "syno_fs_info" => tool_fs_info(client, sid, token, args).await,
        "syno_fs_mkdir" => tool_fs_mkdir(client, sid, token, args).await,
        "syno_fs_rename" => tool_fs_rename(client, sid, token, args).await,
        "syno_fs_delete" => tool_fs_delete(client, sid, token, args).await,
        "syno_dl_ls" => tool_dl_ls(client, sid, token).await,
        "syno_dl_create" => tool_dl_create(client, sid, token, args).await,
        "syno_dl_delete" => tool_dl_action(client, sid, token, args, "delete").await,
        "syno_dl_pause" => tool_dl_action(client, sid, token, args, "pause").await,
        "syno_dl_resume" => tool_dl_action(client, sid, token, args, "resume").await,
        "syno_note_notebooks" => tool_note_notebooks(client, sid, token).await,
        "syno_note_list" => tool_note_list(client, sid, token, args).await,
        "syno_note_get" => tool_note_get(client, sid, token, args).await,
        "syno_note_create" => tool_note_create(client, sid, token, args).await,
        "syno_note_update" => tool_note_update(client, sid, token, args).await,
        "syno_note_delete" => tool_note_delete(client, sid, token, args).await,
        "syno_note_search" => tool_note_search(client, sid, token, args).await,
        "syno_note_tags" => tool_note_tags(client, sid, token).await,
        "syno_note_tag" => tool_note_tag(client, sid, token, args).await,
        "syno_note_untag" => tool_note_untag(client, sid, token, args).await,
        "syno_note_move" => tool_note_move(client, sid, token, args).await,
        "syno_note_create_notebook" => tool_note_create_notebook(client, sid, token, args).await,
        "syno_note_rename_notebook" => tool_note_rename_notebook(client, sid, token, args).await,
        "syno_note_delete_notebook" => tool_note_delete_notebook(client, sid, token, args).await,
        "syno_todo_list" => tool_todo_list(client, sid, token, args).await,
        "syno_todo_create" => tool_todo_create(client, sid, token, args).await,
        "syno_todo_update" => tool_todo_update(client, sid, token, args).await,
        "syno_todo_delete" => tool_todo_delete(client, sid, token, args).await,
        "syno_todo_done" => tool_todo_done(client, sid, token, args).await,
        "syno_note_pull" => tool_note_pull(client, sid, token, args).await,
        "syno_note_push" => tool_note_push(client, sid, token, args).await,
        _ => Err(format!("Unknown tool: {name}")),
    }
}

fn wrap_tool_result(result: Result<String, String>) -> Value {
    match result {
        Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
        Err(e) => json!({ "content": [{ "type": "text", "text": format!("Error: {e}") }], "isError": true }),
    }
}

// ── SSE mode: dispatch with session resolution ──

pub(crate) async fn handle_tool_call_sse(state: &AppState, name: &str, params: &Value, mcp_session_id: &str) -> Value {
    let t0 = Instant::now();
    let has_header_config = {
        state.session_configs.lock().await.contains_key(mcp_session_id)
    };
    let t_config = t0.elapsed();

    // syno_login doesn't need a session
    if name == "syno_login" {
        return wrap_tool_result(tool_login(state, params).await);
    }

    let sid_result = resolve_session_id(params, mcp_session_id, has_header_config);
    let sid_str = match sid_result {
        Ok(s) => s,
        Err(e) => return wrap_tool_result(Err(e)),
    };
    let t_resolve = t0.elapsed();

    let (client, nas_sid, token) = match get_nas_session(state, &sid_str).await {
        Ok(v) => v,
        Err(e) => return wrap_tool_result(Err(e)),
    };
    let t_session = t0.elapsed();
    eprintln!("[timing] {name}: config_check={t_config:?} resolve={t_resolve:?} get_session={t_session:?}");

    let result = dispatch_tool_call(state, name, params, &client, &nas_sid, token.as_deref()).await;
    wrap_tool_result(result)
}

// ── Protocol handler (SSE mode) ──

pub(crate) async fn handle_jsonrpc(state: &AppState, req: JsonRpcRequest, mcp_session_id: &str) -> JsonRpcResponse {
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => {
            JsonRpcResponse::success(id, json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "synology-mcp", "version": "0.1.0" }
            }))
        }
        "notifications/initialized" => JsonRpcResponse::success(id, json!({})),
        "tools/list" => JsonRpcResponse::success(id, tool_definitions()),
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let tool_name = params["name"].as_str().unwrap_or("");
            let tool_args = params.get("arguments").cloned().unwrap_or(json!({}));
            let result = handle_tool_call_sse(state, tool_name, &tool_args, mcp_session_id).await;
            JsonRpcResponse::success(id, result)
        }
        "ping" => JsonRpcResponse::success(id, json!({})),
        _ => JsonRpcResponse::error(id, -32601, &format!("Method not found: {}", req.method)),
    }
}

// ── Protocol handler (stdio mode) ──

pub(crate) async fn handle_jsonrpc_stdio(state: &AppState, req: JsonRpcRequest, nas_session_id: &str) -> JsonRpcResponse {
    let id = req.id.clone().unwrap_or(Value::Null);

    match req.method.as_str() {
        "initialize" => {
            JsonRpcResponse::success(id, json!({
                "protocolVersion": "2024-11-05",
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "synology-mcp-stdio", "version": "0.1.0" }
            }))
        }
        "notifications/initialized" => JsonRpcResponse::success(id, json!({})),
        "tools/list" => JsonRpcResponse::success(id, tool_definitions()),
        "tools/call" => {
            let params = req.params.unwrap_or(Value::Null);
            let tool_name = params["name"].as_str().unwrap_or("");
            let tool_args = params.get("arguments").cloned().unwrap_or(json!({}));

            // Refresh session if near expiry
            {
                let mut sessions = state.nas_sessions.lock().await;
                if let Some(s) = sessions.get(nas_session_id) {
                    if s.created.elapsed() > std::time::Duration::from_secs(25 * 60) {
                        sessions.remove(nas_session_id);
                    }
                }
            }

            let result = match get_nas_session_direct(state, nas_session_id).await {
                Ok((client, sid, token)) => {
                    dispatch_tool_call(state, tool_name, &tool_args, &client, &sid, token.as_deref()).await
                }
                Err(e) => Err(e),
            };
            JsonRpcResponse::success(id, wrap_tool_result(result))
        }
        "ping" => JsonRpcResponse::success(id, json!({})),
        _ => JsonRpcResponse::error(id, -32601, &format!("Method not found: {}", req.method)),
    }
}
