use anyhow::Result;
use clap::Args;

use crate::api::{client::SynoClient, note_station};
use crate::config::{Config, Session};
use crate::crypto;

#[derive(Args)]
pub struct NoteListArgs {
    /// Notebook ID to filter notes (optional, lists all if omitted)
    #[arg(long)]
    pub notebook: Option<String>,

    /// Offset for pagination
    #[arg(long, default_value = "0")]
    pub offset: u64,

    /// Limit for pagination
    #[arg(long, default_value = "50")]
    pub limit: u64,
}

#[derive(Args)]
pub struct NoteGetArgs {
    /// Note object ID
    pub id: String,

    /// Password for encrypted notes
    #[arg(short, long)]
    pub password: Option<String>,
}

#[derive(Args)]
pub struct NoteCreateArgs {
    /// Notebook ID to create the note in
    pub notebook_id: String,
    /// Note title
    #[arg(short, long)]
    pub title: String,
    /// Note content (HTML)
    #[arg(short, long, default_value = "")]
    pub content: String,
}

#[derive(Args)]
pub struct NoteDeleteArgs {
    /// Note object ID to delete
    pub id: String,
}

#[derive(Args)]
pub struct NoteUpdateArgs {
    /// Note object ID
    pub id: String,
    /// New title (optional)
    #[arg(short, long)]
    pub title: Option<String>,
    /// New content (HTML, optional)
    #[arg(short, long)]
    pub content: Option<String>,
}

#[derive(Args)]
pub struct NoteMoveArgs {
    /// Note object ID
    pub id: String,
    /// Target notebook ID
    #[arg(long)]
    pub notebook: String,
}

#[derive(Args)]
pub struct NoteTagArgs {
    /// Note object ID
    pub id: String,
    /// Tag name (will be auto-created if not exists)
    #[arg(long)]
    pub tag: String,
}

#[derive(Args)]
pub struct CreateNotebookArgs {
    /// Notebook title
    #[arg(short, long)]
    pub title: String,
}

#[derive(Args)]
pub struct RenameNotebookArgs {
    /// Notebook object ID
    pub id: String,
    /// New title
    #[arg(short, long)]
    pub title: String,
}

#[derive(Args)]
pub struct DeleteNotebookArgs {
    /// Notebook object ID
    pub id: String,
}

#[derive(Args)]
pub struct SearchArgs {
    /// Search keyword
    pub keyword: String,

    /// Exact phrase match
    #[arg(short, long)]
    pub exact: bool,

    /// Offset for pagination
    #[arg(long, default_value = "0")]
    pub offset: u64,

    /// Limit for pagination
    #[arg(long, default_value = "50")]
    pub limit: u64,
}

/// Show NoteStation info.
pub async fn info() -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::get_info(&client, sid, token).await?;
    println!("{}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// List notebooks.
pub async fn notebooks() -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::list_notebook(&client, sid, token).await?;
    if let Some(notebooks) = data["notebooks"].as_array() {
        for nb in notebooks {
            let id = nb["object_id"].as_str().unwrap_or("?");
            let title = nb["title"].as_str().unwrap_or("<untitled>");
            // note_count is not returned by API; use items array length instead
            let count = nb["items"].as_array().map(|a| a.len()).unwrap_or(0);
            println!("{:<40} {:<30} ({} notes)", id, title, count);
        }
        let total = data["total"].as_u64().unwrap_or(notebooks.len() as u64);
        println!("\nTotal: {total}");
    } else {
        println!("No notebooks found.");
    }
    Ok(())
}

/// List notes.
pub async fn notes(args: &NoteListArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::list_note(
        &client,
        sid,
        token,
        args.notebook.as_deref(),
        args.offset,
        args.limit,
    )
    .await?;

    if let Some(notes) = data["notes"].as_array() {
        for n in notes {
            let id = n["object_id"].as_str().unwrap_or("?");
            let title = n["title"].as_str().unwrap_or("<untitled>");
            let brief = n["brief"].as_str().unwrap_or("");
            let brief_short: String = brief.chars().take(50).collect();
            println!("{:<40} {:<30} {}", id, title, brief_short);
        }
        let total = data["total"].as_u64().unwrap_or(notes.len() as u64);
        println!("\nTotal: {total}");
    } else {
        println!("No notes found.");
    }
    Ok(())
}

/// Get a single note with content.
pub async fn get(args: &NoteGetArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let encrypt_token = match &args.password {
        Some(pw) => {
            let t = note_station::decrypt_note(&client, sid, token, &args.id, pw).await?;
            Some(t)
        }
        None => None,
    };

    let mut data = note_station::get_note(&client, sid, token, &args.id, encrypt_token.as_deref()).await?;

    // If encrypted and password provided, decrypt the content client-side
    if let Some(pw) = &args.password {
        if let Some(content) = data["content"].as_str() {
            match crypto::decrypt_aes256cbc(content, pw) {
                Ok(plaintext) => {
                    data["content"] = serde_json::Value::String(plaintext);
                }
                Err(e) => {
                    eprintln!("Warning: failed to decrypt content: {e}");
                }
            }
        }
        // Also decrypt title if it looks encrypted
        if let Some(title) = data["title"].as_str() {
            if title.starts_with("U2FsdGVkX1") {
                if let Ok(plain_title) = crypto::decrypt_aes256cbc(title, pw) {
                    data["title"] = serde_json::Value::String(plain_title);
                }
            }
        }
    }

    println!("{}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// Create a note.
pub async fn create(args: &NoteCreateArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::create_note(
        &client,
        sid,
        token,
        &args.notebook_id,
        &args.title,
        &args.content,
    )
    .await?;
    println!("Note created: {}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// Delete a note.
pub async fn delete(args: &NoteDeleteArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    note_station::delete_note(&client, sid, token, &args.id).await?;
    println!("Note deleted.");
    Ok(())
}

/// List tags.
pub async fn tags() -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::list_tag(&client, sid, token).await?;
    if let Some(tags) = data["tags"].as_array() {
        for t in tags {
            let id = t["tag_id"].as_str().unwrap_or("?");
            let name = t["title"].as_str().unwrap_or("<unnamed>");
            let count = t["items"].as_array().map(|a| a.len()).unwrap_or(0);
            println!("{:<40} {:<20} ({} notes)", id, name, count);
        }
    } else {
        println!("No tags found.");
    }
    Ok(())
}

/// List todos.
pub async fn todos() -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::list_todo(&client, sid, token).await?;
    if let Some(todos) = data["todos"].as_array() {
        for t in todos {
            let id = t["object_id"].as_str().unwrap_or("?");
            let title = t["title"].as_str().unwrap_or("<untitled>");
            let done = t["completed"].as_bool().unwrap_or(false);
            let mark = if done { "[x]" } else { "[ ]" };
            println!("{mark} {:<40} {title}", id);
        }
    } else {
        println!("No todos found.");
    }
    Ok(())
}

/// Update a note (title and/or content).
pub async fn update(args: &NoteUpdateArgs) -> Result<()> {
    if args.title.is_none() && args.content.is_none() {
        anyhow::bail!("At least one of --title or --content must be provided");
    }
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::update_note(
        &client,
        sid,
        token,
        &args.id,
        args.title.as_deref(),
        args.content.as_deref(),
    )
    .await?;
    println!("Note updated: {}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// Move a note to another notebook.
pub async fn move_note(args: &NoteMoveArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    note_station::move_note(&client, sid, token, &args.id, &args.notebook).await?;
    println!("Note moved.");
    Ok(())
}

/// Create a notebook.
pub async fn create_notebook(args: &CreateNotebookArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::create_notebook(&client, sid, token, &args.title).await?;
    println!("Notebook created: {}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// Rename a notebook.
pub async fn rename_notebook(args: &RenameNotebookArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    note_station::rename_notebook(&client, sid, token, &args.id, &args.title).await?;
    println!("Notebook renamed.");
    Ok(())
}

/// Delete a notebook.
pub async fn delete_notebook(args: &DeleteNotebookArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    note_station::delete_notebook(&client, sid, token, &args.id).await?;
    println!("Notebook deleted.");
    Ok(())
}

/// Tag a note (add a tag, preserving existing tags).
pub async fn tag(args: &NoteTagArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    // Get current note to read existing tags and ver
    let data = note_station::get_note(&client, sid, token, &args.id, None).await?;
    let ver = data["ver"].as_str().unwrap_or("").to_string();
    let mut tags: Vec<String> = data["tag"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();

    if !tags.contains(&args.tag) {
        tags.push(args.tag.clone());
    }

    note_station::set_note_tags(&client, sid, token, &args.id, &ver, &tags).await?;
    println!("Tag added to note.");
    Ok(())
}

/// Untag a note (remove a tag, preserving other tags).
pub async fn untag(args: &NoteTagArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    // Get current note to read existing tags and ver
    let data = note_station::get_note(&client, sid, token, &args.id, None).await?;
    let ver = data["ver"].as_str().unwrap_or("").to_string();
    let tags: Vec<String> = data["tag"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|t| t != &args.tag)
        .collect();

    note_station::set_note_tags(&client, sid, token, &args.id, &ver, &tags).await?;
    println!("Tag removed from note.");
    Ok(())
}

/// Full-text search notes.
pub async fn search(args: &SearchArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::search(&client, sid, token, &args.keyword, args.exact, args.offset, args.limit).await?;
    // FTS returns "matches" array
    let arr = data["matches"].as_array().or_else(|| data["notes"].as_array());
    if let Some(notes) = arr {
        for n in notes {
            let id = n["object_id"].as_str().unwrap_or("?");
            let title = n["title"].as_str().unwrap_or("<untitled>");
            let brief = n["brief"].as_str().unwrap_or("");
            let brief_short: String = brief.chars().take(60).collect();
            println!("{:<40} {:<30} {}", id, title, brief_short);
        }
        println!("\nFound: {} results", notes.len());
    } else {
        println!("No results.");
    }
    Ok(())
}
