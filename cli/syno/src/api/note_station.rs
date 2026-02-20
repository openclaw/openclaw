use anyhow::Result;
use serde::Deserialize;
use serde_json::Value;

use super::client::SynoClient;

// ── Notebook ──

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct NotebookList {
    pub notebooks: Option<Vec<Notebook>>,
    pub total: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct Notebook {
    pub object_id: Option<String>,
    pub title: Option<String>,
    pub items: Option<Vec<Value>>,
}

// ── Note ──

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct NoteList {
    pub notes: Option<Vec<Note>>,
    pub total: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct Note {
    pub object_id: Option<String>,
    pub title: Option<String>,
    pub parent_id: Option<String>,
    pub brief: Option<String>,
    pub mtime: Option<u64>,
    pub ctime: Option<u64>,
    pub content: Option<String>,
    pub encrypt: Option<bool>,
    pub category: Option<String>,
    pub link_id: Option<String>,
    pub perm: Option<String>,
    pub recycle: Option<bool>,
    pub archive: Option<bool>,
    pub owner: Option<Value>,
    pub tag: Option<Vec<String>>,
}

// ── Tag ──

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct TagList {
    pub tags: Option<Vec<Tag>>,
    pub total: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct Tag {
    pub object_id: Option<String>,
    pub name: Option<String>,
    pub note_count: Option<u64>,
}

// ── Todo ──

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct TodoList {
    pub todos: Option<Vec<Todo>>,
    pub total: Option<u64>,
    pub count: Option<u64>,
    pub offset: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct Todo {
    pub object_id: Option<String>,
    pub title: Option<String>,
    pub comment: Option<String>,
    pub done: Option<bool>,
    pub due_date: Option<i64>,
    pub items: Option<Vec<Value>>,
    pub note_id: Option<String>,
    pub note_parent_id: Option<String>,
    pub note_title: Option<String>,
    pub parent_id: Option<String>,
    pub priority: Option<i64>,
    pub reminder_offset: Option<i64>,
    pub star: Option<bool>,
}

// ── API Functions ──

/// Get NoteStation info.
pub async fn get_info(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
) -> Result<Value> {
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Info"),
                ("version", "3"),
                ("method", "get"),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Info failed: {val}");
    }
    Ok(val["data"].clone())
}

/// List all notebooks.
pub async fn list_notebook(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
) -> Result<Value> {
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Notebook"),
                ("version", "2"),
                ("method", "list"),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Notebook.list failed: {val}");
    }
    Ok(val["data"].clone())
}

/// List notes. If notebook_id is None, list all notes.
pub async fn list_note(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    notebook_id: Option<&str>,
    offset: u64,
    limit: u64,
) -> Result<Value> {
    let offset_str = offset.to_string();
    let limit_str = limit.to_string();

    // Build filter JSON: show non-recycled, non-archived notes
    let filter = match notebook_id {
        Some(nb_id) => format!(
            r#"{{"recycle":false,"archive":false,"parent_id":"{}"}}"#,
            nb_id
        ),
        None => r#"{"recycle":false,"archive":false}"#.to_string(),
    };

    let params = vec![
        ("api", "SYNO.NoteStation.Note"),
        ("version", "3"),
        ("method", "list"),
        ("filter", &filter),
        ("offset", &offset_str),
        ("limit", &limit_str),
        ("sort_by", "\"mtime\""),
        ("sort_direction", "\"desc\""),
    ];

    let val = client
        .post_with_sid("entry.cgi", sid, synotoken, &params)
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.list failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Get a note by ID (with content).
pub async fn get_note(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    note_id: &str,
    encrypt_token: Option<&str>,
) -> Result<Value> {
    let mut params = vec![
        ("api", "SYNO.NoteStation.Note"),
        ("version", "3"),
        ("method", "get"),
        ("object_id", note_id),
    ];
    if let Some(token) = encrypt_token {
        params.push(("token", token));
    }
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &params,
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.get failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Decrypt an encrypted note: get a temporary token by providing the password.
/// Returns the token string used to read the note content.
pub async fn decrypt_note(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    note_id: &str,
    password: &str,
) -> Result<String> {
    let object_id_param = format!("\"{}\"", note_id);
    let password_param = format!("\"{}\"", password);
    let val = client
        .post_with_sid(
            "entry.cgi/SYNO.NoteStation.Note.Encrypt",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Note.Encrypt"),
                ("version", "1"),
                ("method", "create"),
                ("object_id", &object_id_param),
                ("password", &password_param),
                ("duration", "120"),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.Encrypt failed: {val}");
    }
    let token = val["data"]["token"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("No token in decrypt response: {val}"))?;
    Ok(token.to_string())
}

/// Create a note.
pub async fn create_note(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    notebook_id: &str,
    title: &str,
    content: &str,
) -> Result<Value> {
    let title_param = format!("\"{}\"", title);
    let parent_id_param = format!("\"{}\"", notebook_id);
    let commit_msg = r#"{"device":"desktop","listable":false}"#;
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Note"),
                ("version", "3"),
                ("method", "create"),
                ("commit_msg", commit_msg),
                ("title", &title_param),
                ("parent_id", &parent_id_param),
                ("content", content),
                ("encrypt", "false"),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.create failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Delete a note by ID (moves to recycle bin).
pub async fn delete_note(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    note_id: &str,
) -> Result<()> {
    let id_param = format!("\"{}\"", note_id);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Note"),
                ("version", "3"),
                ("method", "delete"),
                ("object_id", &id_param),
                ("recycle", "true"),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.delete failed: {val}");
    }
    Ok(())
}

/// List all tags.
pub async fn list_tag(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
) -> Result<Value> {
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Tag"),
                ("version", "2"),
                ("method", "list"),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Tag.list failed: {val}");
    }
    Ok(val["data"].clone())
}

/// List todos.
pub async fn list_todo(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    done: Option<bool>,
    offset: u64,
    limit: u64,
) -> Result<Value> {
    let offset_str = offset.to_string();
    let limit_str = limit.to_string();
    let filter = match done {
        Some(d) => format!(r#"{{"done":{}}}"#, d),
        None => "{}".to_string(),
    };

    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Todo"),
                ("version", "2"),
                ("method", "list"),
                ("field", r#"{"items":true}"#),
                ("filter", &filter),
                ("offset", &offset_str),
                ("limit", &limit_str),
                ("sort_by", "\"due_date\""),
                ("sort_direction", "\"asc\""),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Todo.list failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Create a todo.
pub async fn create_todo(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    title: &str,
) -> Result<Value> {
    let title_param = format!("\"{}\"", title);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Todo"),
                ("version", "2"),
                ("method", "create"),
                ("title", &title_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Todo.create failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Update a todo (title, done, star, due_date, comment, priority).
pub async fn update_todo(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    todo_id: &str,
    title: Option<&str>,
    done: Option<bool>,
    star: Option<bool>,
    due_date: Option<i64>,
    comment: Option<&str>,
    priority: Option<i64>,
) -> Result<Value> {
    let id_param = format!("[\"{}\"]", todo_id);
    let title_param = title.map(|t| format!("\"{}\"", t));
    let done_str = done.map(|d| d.to_string());
    let star_str = star.map(|s| s.to_string());
    let due_str = due_date.map(|d| d.to_string());
    let comment_param = comment.map(|c| format!("\"{}\"", c));
    let priority_str = priority.map(|p| p.to_string());

    let mut params: Vec<(&str, &str)> = vec![
        ("api", "SYNO.NoteStation.Todo"),
        ("version", "2"),
        ("method", "set"),
        ("object_id", &id_param),
    ];
    if let Some(ref t) = title_param {
        params.push(("title", t));
    }
    if let Some(ref d) = done_str {
        params.push(("done", d));
    }
    if let Some(ref s) = star_str {
        params.push(("star", s));
    }
    if let Some(ref d) = due_str {
        params.push(("due_date", d));
    }
    if let Some(ref c) = comment_param {
        params.push(("comment", c));
    }
    if let Some(ref p) = priority_str {
        params.push(("priority", p));
    }
    let val = client
        .post_with_sid("entry.cgi", sid, synotoken, &params)
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Todo.set failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Delete a todo.
pub async fn delete_todo(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    todo_id: &str,
) -> Result<()> {
    let id_param = format!("[\"{}\"]", todo_id);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Todo"),
                ("version", "1"),
                ("method", "delete"),
                ("object_id", &id_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Todo.delete failed: {val}");
    }
    Ok(())
}

/// Update a note (title and/or content).
pub async fn update_note(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    note_id: &str,
    title: Option<&str>,
    content: Option<&str>,
) -> Result<Value> {
    let id_param = format!("\"{}\"", note_id);
    let commit_msg = r#"{"device":"desktop","listable":false}"#;
    let title_param = title.map(|t| format!("\"{}\"", t));
    let mut params: Vec<(&str, &str)> = vec![
        ("api", "SYNO.NoteStation.Note"),
        ("version", "3"),
        ("method", "set"),
        ("object_id", &id_param),
        ("commit_msg", commit_msg),
    ];
    if let Some(ref t) = title_param {
        params.push(("title", t));
    }
    if let Some(c) = content {
        params.push(("content", c));
    }
    let val = client
        .post_with_sid("entry.cgi", sid, synotoken, &params)
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.set failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Move a note to another notebook (uses set method with parent_id).
pub async fn move_note(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    note_id: &str,
    notebook_id: &str,
) -> Result<()> {
    let id_param = format!("[\"{}\"]", note_id);
    let parent_param = format!("\"{}\"", notebook_id);
    let commit_msg = r#"{"device":"desktop"}"#;
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Note"),
                ("version", "3"),
                ("method", "set"),
                ("commit_msg", commit_msg),
                ("object_id", &id_param),
                ("parent_id", &parent_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.move failed: {val}");
    }
    Ok(())
}

/// Create a notebook.
pub async fn create_notebook(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    title: &str,
) -> Result<Value> {
    let title_param = format!("\"{}\"", title);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Notebook"),
                ("version", "2"),
                ("method", "create"),
                ("title", &title_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Notebook.create failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Rename a notebook.
pub async fn rename_notebook(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    notebook_id: &str,
    title: &str,
) -> Result<()> {
    let id_param = format!("\"{}\"", notebook_id);
    let title_param = format!("\"{}\"", title);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Notebook"),
                ("version", "2"),
                ("method", "set"),
                ("object_id", &id_param),
                ("title", &title_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Notebook.set failed: {val}");
    }
    Ok(())
}

/// Delete a notebook.
pub async fn delete_notebook(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    notebook_id: &str,
) -> Result<()> {
    let id_param = format!("\"{}\"", notebook_id);
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Notebook"),
                ("version", "2"),
                ("method", "delete"),
                ("object_id", &id_param),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Notebook.delete failed: {val}");
    }
    Ok(())
}

/// Set tags on a note (replaces all tags). Uses method=set with ver and check_conflict.
pub async fn set_note_tags(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    note_id: &str,
    ver: &str,
    tag_ids: &[String],
) -> Result<Value> {
    let id_param = format!("\"{}\"", note_id);
    let ver_param = format!("\"{}\"", ver);
    let commit_msg = r#"{"device":"desktop"}"#;
    let tags_json: Vec<String> = tag_ids.iter().map(|id| format!("\"{}\"", id)).collect();
    let tags_param = format!("[{}]", tags_json.join(","));
    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.Note"),
                ("version", "3"),
                ("method", "set"),
                ("commit_msg", commit_msg),
                ("object_id", &id_param),
                ("ver", &ver_param),
                ("tag", &tags_param),
                ("check_conflict", "true"),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.Note.set (tag) failed: {val}");
    }
    Ok(val["data"].clone())
}

/// Full-text search notes (SYNO.NoteStation.FTS).
pub async fn search(
    client: &SynoClient,
    sid: &str,
    synotoken: Option<&str>,
    keyword: &str,
    exact: bool,
    offset: u64,
    limit: u64,
) -> Result<Value> {
    let offset_str = offset.to_string();
    let limit_str = limit.to_string();
    // Exact match: wrap keyword with escaped quotes, e.g. "\"keyword\""
    let keyword_param = if exact {
        format!("\"\\\"{}\\\"\"", keyword)
    } else {
        format!("\"{}\"", keyword)
    };

    let val = client
        .post_with_sid(
            "entry.cgi",
            sid,
            synotoken,
            &[
                ("api", "SYNO.NoteStation.FTS"),
                ("version", "1"),
                ("method", "search"),
                ("keyword", &keyword_param),
                ("offset", &offset_str),
                ("limit", &limit_str),
                ("sort_by", "\"mtime\""),
                ("sort_direction", "\"desc\""),
            ],
        )
        .await?;
    let success = val["success"].as_bool().unwrap_or(false);
    if !success {
        anyhow::bail!("NoteStation.FTS.search failed: {val}");
    }
    Ok(val["data"].clone())
}
