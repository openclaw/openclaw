//! MCP tool definitions (JSON schema) and tool implementation functions.

use std::time::Instant;

use serde_json::{json, Value};

use crate::api::{auth, client::SynoClient, download_station, file_station, note_station, system};
use crate::crypto;
use crate::markdown;

use super::session::*;

// ── Tool definitions ──

pub(crate) fn tool_definitions() -> Value {
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
            },
            {
                "name": "syno_note_pull",
                "description": "Pull a note from NoteStation to a local file. Auto-detects if HTML→Markdown conversion is viable; if not, saves as raw HTML and adjusts the file extension accordingly.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID" },
                        "path": { "type": "string", "description": "Local file path to save (e.g. C:/tmp/note.md). Extension may be auto-changed to .html if conversion fails." }
                    },
                    "required": ["id", "path"]
                }
            },
            {
                "name": "syno_note_push",
                "description": "Push a local file to update a note in NoteStation. Auto-detects format by file extension: .html/.htm files are pushed as raw HTML, .md files are converted to HTML first.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "nas_session_id": { "type": "string", "description": "Session ID from syno_login. Optional if headers auth is configured." },
                        "id": { "type": "string", "description": "Note object ID to update" },
                        "path": { "type": "string", "description": "Local file path (.md or .html) to read and push" },
                        "title": { "type": "string", "description": "Optionally update the note title" }
                    },
                    "required": ["id", "path"]
                }
            }
        ]
    })
}

// ── Tool implementations ──

pub(crate) async fn tool_login(state: &AppState, params: &Value) -> Result<String, String> {
    let host = get_str(params, "host").ok_or("Missing host")?;
    let port = get_u64(params, "port", 5000) as u16;
    let https = get_bool(params, "https", false);
    let username = get_str(params, "username").ok_or("Missing username")?;
    let password = get_str(params, "password").ok_or("Missing password")?;
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

pub(crate) async fn tool_info(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
    let info = system::get_info(client, sid, token).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&json!({
        "model": info.model,
        "serial": info.serial,
        "version": info.version_string,
        "temperature": info.temperature,
        "uptime": info.uptime
    })).unwrap())
}

pub(crate) async fn tool_fs_ls(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_fs_info(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let path = get_str(params, "path").ok_or("Missing path")?;
    let result = file_station::get_info(client, sid, token, &path).await.map_err(|e| e.to_string())?;
    let files: Vec<Value> = result.files.unwrap_or_default().iter().map(|f| {
        json!({"name": f.name, "path": f.path, "isdir": f.isdir, "additional": f.additional})
    }).collect();
    Ok(serde_json::to_string_pretty(&json!({"files": files})).unwrap())
}

pub(crate) async fn tool_fs_mkdir(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let folder_path = get_str(params, "folder_path").ok_or("Missing folder_path")?;
    let name = get_str(params, "name").ok_or("Missing name")?;
    let data = file_station::create_folder(client, sid, token, &folder_path, &name).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

pub(crate) async fn tool_fs_rename(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let path = get_str(params, "path").ok_or("Missing path")?;
    let name = get_str(params, "name").ok_or("Missing name")?;
    let data = file_station::rename(client, sid, token, &path, &name).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

pub(crate) async fn tool_fs_delete(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let path = get_str(params, "path").ok_or("Missing path")?;
    file_station::delete(client, sid, token, &path).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Deleted", "path": path}).to_string())
}

pub(crate) async fn tool_dl_ls(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
    let tasks = download_station::list(client, sid, token).await.map_err(|e| e.to_string())?;
    let items: Vec<Value> = tasks.tasks.unwrap_or_default().iter().map(|t| {
        json!({"id": t.id, "title": t.title, "status": t.status, "size": t.size})
    }).collect();
    Ok(serde_json::to_string_pretty(&json!({"tasks": items, "total": tasks.total})).unwrap())
}

pub(crate) async fn tool_dl_create(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let uri = get_str(params, "uri").ok_or("Missing uri")?;
    let dest = get_str(params, "destination");
    download_station::create(client, sid, token, &uri, dest.as_deref()).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Download task created"}).to_string())
}

pub(crate) async fn tool_dl_action(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value, action: &str) -> Result<String, String> {
    let ids = get_str(params, "ids").ok_or("Missing ids")?;
    match action {
        "delete" => download_station::delete(client, sid, token, &ids).await.map_err(|e| e.to_string())?,
        "pause" => download_station::pause(client, sid, token, &ids).await.map_err(|e| e.to_string())?,
        "resume" => download_station::resume(client, sid, token, &ids).await.map_err(|e| e.to_string())?,
        _ => return Err(format!("Unknown action: {action}")),
    }
    Ok(json!({"message": format!("Task(s) {action}d")}).to_string())
}

pub(crate) async fn tool_note_notebooks(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
    let t = Instant::now();
    let data = note_station::list_notebook(client, sid, token).await.map_err(|e| e.to_string())?;
    eprintln!("[timing] note_notebooks: api_call={:?}", t.elapsed());
    let notebooks: Vec<Value> = data["notebooks"]
        .as_array()
        .map(|arr| arr.iter().map(|nb| {
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

pub(crate) async fn tool_note_list(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_note_get(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_note_create(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let notebook_id = get_str(params, "notebook_id").ok_or("Missing notebook_id")?;
    let title = get_str(params, "title").ok_or("Missing title")?;
    let content = get_str(params, "content").unwrap_or_default();
    let md = get_bool(params, "md", false);
    let html = if md { markdown::md_to_html(&content) } else { content };
    let data = note_station::create_note(client, sid, token, &notebook_id, &title, &html)
        .await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

pub(crate) async fn tool_note_update(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_note_delete(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    note_station::delete_note(client, sid, token, &id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Note deleted"}).to_string())
}

pub(crate) async fn tool_note_search(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_note_tags(client: &SynoClient, sid: &str, token: Option<&str>) -> Result<String, String> {
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

pub(crate) async fn tool_note_tag(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_note_untag(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_note_move(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let notebook_id = get_str(params, "notebook_id").ok_or("Missing notebook_id")?;
    note_station::move_note(client, sid, token, &id, &notebook_id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Note moved"}).to_string())
}

pub(crate) async fn tool_note_create_notebook(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let title = get_str(params, "title").ok_or("Missing title")?;
    let data = note_station::create_notebook(client, sid, token, &title).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

pub(crate) async fn tool_note_rename_notebook(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let title = get_str(params, "title").ok_or("Missing title")?;
    note_station::rename_notebook(client, sid, token, &id, &title).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Notebook renamed"}).to_string())
}

pub(crate) async fn tool_note_delete_notebook(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    note_station::delete_notebook(client, sid, token, &id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Notebook deleted"}).to_string())
}

pub(crate) async fn tool_todo_list(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_todo_create(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let title = get_str(params, "title").ok_or("Missing title")?;
    let data = note_station::create_todo(client, sid, token, &title).await.map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&data).unwrap())
}

pub(crate) async fn tool_todo_update(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
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

pub(crate) async fn tool_todo_delete(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    note_station::delete_todo(client, sid, token, &id).await.map_err(|e| e.to_string())?;
    Ok(json!({"message": "Todo deleted"}).to_string())
}

pub(crate) async fn tool_todo_done(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let undo = get_bool(params, "undo", false);
    let done_val = !undo;
    note_station::update_todo(client, sid, token, &id, None, Some(done_val), None, None, None, None)
        .await.map_err(|e| e.to_string())?;
    Ok(json!({"message": if done_val { "Marked as done" } else { "Marked as undone" }}).to_string())
}

pub(crate) async fn tool_note_pull(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let path = get_str(params, "path").ok_or("Missing path")?;

    let data = note_station::get_note(client, sid, token, &id, None)
        .await.map_err(|e| e.to_string())?;

    let title = data["title"].as_str().unwrap_or("Untitled");
    let html_content = data["content"].as_str().unwrap_or("");

    let md = markdown::html_to_md(html_content);
    let html_text_len = html_content.len();
    let md_text_len = md.trim().len();

    let (content, format) = if html_text_len == 0 || md_text_len == 0 {
        (html_content.to_string(), "html")
    } else if md_text_len * 100 / html_text_len < 20 {
        (html_content.to_string(), "html")
    } else {
        (format!("# {}\n\n{}", title, md), "markdown")
    };

    let final_path = if format == "html" && !path.ends_with(".html") && !path.ends_with(".htm") {
        let p = std::path::Path::new(&path);
        p.with_extension("html").to_string_lossy().to_string()
    } else if format == "markdown" && !path.ends_with(".md") {
        let p = std::path::Path::new(&path);
        p.with_extension("md").to_string_lossy().to_string()
    } else {
        path.clone()
    };

    std::fs::write(&final_path, &content).map_err(|e| format!("Failed to write file: {e}"))?;

    Ok(json!({
        "message": format!("Note pulled as {format}"),
        "path": final_path,
        "format": format,
        "title": title,
        "size": content.len()
    }).to_string())
}

pub(crate) async fn tool_note_push(client: &SynoClient, sid: &str, token: Option<&str>, params: &Value) -> Result<String, String> {
    let id = get_str(params, "id").ok_or("Missing id")?;
    let path = get_str(params, "path").ok_or("Missing path")?;
    let title = get_str(params, "title");

    let file_content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read file: {e}"))?;

    let is_html = path.ends_with(".html") || path.ends_with(".htm");
    let html = if is_html {
        file_content
    } else {
        markdown::md_to_html(&file_content)
    };

    let data = note_station::update_note(client, sid, token, &id, title.as_deref(), Some(&html))
        .await.map_err(|e| e.to_string())?;

    Ok(serde_json::to_string_pretty(&json!({
        "message": if is_html { "Note updated from HTML file" } else { "Note updated from Markdown file" },
        "path": path,
        "data": data
    })).unwrap())
}
