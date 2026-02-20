use std::io::Read;

use anyhow::Result;
use clap::Args;

use crate::api::{client::SynoClient, note_station};
use crate::config::{Config, Session};
use crate::crypto;
use crate::markdown;

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
    /// Read content from stdin instead of --content (for long/complex HTML)
    #[arg(long)]
    pub content_stdin: bool,
    /// Read content from a file (UTF-8)
    #[arg(long)]
    pub content_file: Option<String>,
    /// Treat content as Markdown and convert to HTML
    #[arg(long)]
    pub md: bool,
    /// Read Markdown from a file and convert to HTML
    #[arg(long)]
    pub md_file: Option<String>,
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
    /// Read content from stdin instead of --content (for long/complex HTML)
    #[arg(long)]
    pub content_stdin: bool,
    /// Read content from a file (UTF-8)
    #[arg(long)]
    pub content_file: Option<String>,
    /// Treat content as Markdown and convert to HTML
    #[arg(long)]
    pub md: bool,
    /// Read Markdown from a file and convert to HTML
    #[arg(long)]
    pub md_file: Option<String>,
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

#[derive(Args)]
pub struct TodoListArgs {
    /// Filter: show only done (true) or undone (false) todos
    #[arg(long)]
    pub done: Option<bool>,

    /// Offset for pagination
    #[arg(long, default_value = "0")]
    pub offset: u64,

    /// Limit for pagination
    #[arg(long, default_value = "100")]
    pub limit: u64,
}

#[derive(Args)]
pub struct TodoCreateArgs {
    /// Todo title
    pub title: String,
}

#[derive(Args)]
pub struct TodoUpdateArgs {
    /// Todo object ID
    pub id: String,

    /// New title
    #[arg(short, long)]
    pub title: Option<String>,

    /// Mark as done or undone
    #[arg(long)]
    pub done: Option<bool>,

    /// Star or unstar
    #[arg(long)]
    pub star: Option<bool>,

    /// Due date as unix timestamp (-1 to clear)
    #[arg(long)]
    pub due_date: Option<i64>,

    /// Comment text
    #[arg(long)]
    pub comment: Option<String>,

    /// Priority: none, low, medium, high
    #[arg(long)]
    pub priority: Option<String>,
}

#[derive(Args)]
pub struct TodoDeleteArgs {
    /// Todo object ID
    pub id: String,
}

#[derive(Args)]
pub struct TodoDoneArgs {
    /// Todo object ID
    pub id: String,

    /// Mark as undone instead of done
    #[arg(long)]
    pub undo: bool,
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

/// Resolve content from the various input sources, with optional Markdown→HTML conversion.
fn resolve_content_create(args: &NoteCreateArgs) -> Result<String> {
    if let Some(ref path) = args.md_file {
        let md = std::fs::read_to_string(path)?;
        return Ok(markdown::md_to_html(&md));
    }
    if args.content_stdin {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        return Ok(if args.md { markdown::md_to_html(&buf) } else { buf });
    }
    if let Some(ref path) = args.content_file {
        return Ok(std::fs::read_to_string(path)?);
    }
    if args.md && !args.content.is_empty() {
        return Ok(markdown::md_to_html(&args.content));
    }
    Ok(args.content.clone())
}

/// Resolve content for update, with optional Markdown→HTML conversion.
fn resolve_content_update(args: &NoteUpdateArgs) -> Result<Option<String>> {
    if let Some(ref path) = args.md_file {
        let md = std::fs::read_to_string(path)?;
        return Ok(Some(markdown::md_to_html(&md)));
    }
    if args.content_stdin {
        let mut buf = String::new();
        std::io::stdin().read_to_string(&mut buf)?;
        return Ok(Some(if args.md { markdown::md_to_html(&buf) } else { buf }));
    }
    if let Some(ref path) = args.content_file {
        return Ok(Some(std::fs::read_to_string(path)?));
    }
    if args.md {
        if let Some(ref c) = args.content {
            return Ok(Some(markdown::md_to_html(c)));
        }
    }
    Ok(args.content.clone())
}

/// Create a note.
pub async fn create(args: &NoteCreateArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let content = resolve_content_create(args)?;

    let data = note_station::create_note(
        &client,
        sid,
        token,
        &args.notebook_id,
        &args.title,
        &content,
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
pub async fn todos(args: &TodoListArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::list_todo(&client, sid, token, args.done, args.offset, args.limit).await?;
    if let Some(todos) = data["todos"].as_array() {
        for t in todos {
            let id = t["object_id"].as_str().unwrap_or("?");
            let title = t["title"].as_str().unwrap_or("<untitled>");
            let done = t["done"].as_bool().unwrap_or(false);
            let star = t["star"].as_bool().unwrap_or(false);
            let mark = if done { "[x]" } else { "[ ]" };
            let star_mark = if star { "*" } else { " " };
            let priority = match t["priority"].as_i64().unwrap_or(-1) {
                300 => " !!!",
                200 => " !! ",
                100 => " !  ",
                _ => "    ",
            };
            let due = t["due_date"].as_i64().unwrap_or(-1);
            let due_str = if due > 0 {
                let d = chrono_lite(due);
                format!(" (due: {})", d)
            } else {
                String::new()
            };
            println!("{mark}{star_mark}{priority} {:<50} {title}{due_str}", id);
        }
        let total = data["total"].as_u64().unwrap_or(todos.len() as u64);
        println!("\nTotal: {total}");
    } else {
        println!("No todos found.");
    }
    Ok(())
}

/// Simple unix-timestamp to YYYY-MM-DD string (no chrono dep needed).
fn chrono_lite(ts: i64) -> String {
    // days since epoch
    let secs_per_day: i64 = 86400;
    let mut days = ts / secs_per_day;
    let mut year = 1970i64;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year {
            break;
        }
        days -= days_in_year;
        year += 1;
    }
    let leap = is_leap(year);
    let month_days = [
        31,
        if leap { 29 } else { 28 },
        31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 0usize;
    for (i, &md) in month_days.iter().enumerate() {
        if days < md {
            month = i + 1;
            break;
        }
        days -= md;
    }
    let day = days + 1;
    format!("{year:04}-{month:02}-{day:02}")
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// Create a todo.
pub async fn create_todo(args: &TodoCreateArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::create_todo(&client, sid, token, &args.title).await?;
    let id = data["object_id"].as_str().unwrap_or("?");
    let title = data["title"].as_str().unwrap_or(&args.title);
    println!("Todo created: {id}  {title}");
    Ok(())
}

/// Update a todo (title, done, star, due_date, comment, priority).
pub async fn update_todo(args: &TodoUpdateArgs) -> Result<()> {
    if args.title.is_none()
        && args.done.is_none()
        && args.star.is_none()
        && args.due_date.is_none()
        && args.comment.is_none()
        && args.priority.is_none()
    {
        anyhow::bail!(
            "At least one of --title, --done, --star, --due-date, --comment, or --priority must be provided"
        );
    }

    let priority_val = match args.priority.as_deref() {
        Some("none") => Some(-1i64),
        Some("low") => Some(100),
        Some("medium") | Some("med") => Some(200),
        Some("high") => Some(300),
        Some(other) => anyhow::bail!(
            "Invalid priority '{}'. Use: none, low, medium (med), high",
            other
        ),
        None => None,
    };

    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = note_station::update_todo(
        &client,
        sid,
        token,
        &args.id,
        args.title.as_deref(),
        args.done,
        args.star,
        args.due_date,
        args.comment.as_deref(),
        priority_val,
    )
    .await?;
    println!("Todo updated: {}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// Delete a todo.
pub async fn delete_todo(args: &TodoDeleteArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    note_station::delete_todo(&client, sid, token, &args.id).await?;
    println!("Todo deleted.");
    Ok(())
}

/// Mark a todo as done (or undone with --undo).
pub async fn done_todo(args: &TodoDoneArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let done_val = !args.undo;
    note_station::update_todo(
        &client,
        sid,
        token,
        &args.id,
        None,
        Some(done_val),
        None,
        None,
        None,
        None,
    )
    .await?;
    if done_val {
        println!("Todo marked as done.");
    } else {
        println!("Todo marked as undone.");
    }
    Ok(())
}

/// Update a note (title and/or content).
pub async fn update(args: &NoteUpdateArgs) -> Result<()> {
    let content = resolve_content_update(args)?;

    if args.title.is_none() && content.is_none() {
        anyhow::bail!("At least one of --title, --content, --content-stdin, --content-file, --md, or --md-file must be provided");
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
        content.as_deref(),
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

#[derive(Args)]
pub struct NotePullArgs {
    /// Note object ID
    pub id: String,
    /// Local file path to save to (extension auto-adjusted: .md or .html)
    pub path: String,
    /// Password for encrypted notes
    #[arg(short, long)]
    pub password: Option<String>,
}

#[derive(Args)]
pub struct NotePushArgs {
    /// Note object ID to update
    pub id: String,
    /// Local file path to read from (.md auto-converted to HTML, .html/.htm pushed as-is)
    pub path: String,
    /// Optionally update the note title
    #[arg(short, long)]
    pub title: Option<String>,
}

/// Pull a note from NoteStation to a local file.
/// Auto-detects if HTML→Markdown conversion is viable; if not, saves as raw HTML.
pub async fn pull(args: &NotePullArgs) -> Result<()> {
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

    // Decrypt if needed
    if let Some(pw) = &args.password {
        if let Some(content) = data["content"].as_str() {
            if let Ok(plaintext) = crypto::decrypt_aes256cbc(content, pw) {
                data["content"] = serde_json::Value::String(plaintext);
            }
        }
        if let Some(title) = data["title"].as_str() {
            if title.starts_with("U2FsdGVkX1") {
                if let Ok(plain_title) = crypto::decrypt_aes256cbc(title, pw) {
                    data["title"] = serde_json::Value::String(plain_title);
                }
            }
        }
    }

    let title = data["title"].as_str().unwrap_or("Untitled");
    let html_content = data["content"].as_str().unwrap_or("");

    let md = markdown::html_to_md(html_content);
    let html_len = html_content.len();
    let md_len = md.trim().len();

    // Decide format: if markdown conversion lost too much content, keep HTML
    let (content, format) = if html_len == 0 || md_len == 0 {
        (html_content.to_string(), "html")
    } else if md_len * 100 / html_len < 20 {
        (html_content.to_string(), "html")
    } else {
        (format!("# {}\n\n{}", title, md), "markdown")
    };

    // Auto-adjust file extension
    let final_path = if format == "html" && !args.path.ends_with(".html") && !args.path.ends_with(".htm") {
        std::path::Path::new(&args.path).with_extension("html").to_string_lossy().to_string()
    } else if format == "markdown" && !args.path.ends_with(".md") {
        std::path::Path::new(&args.path).with_extension("md").to_string_lossy().to_string()
    } else {
        args.path.clone()
    };

    std::fs::write(&final_path, &content)?;
    println!("Pulled as {format}: {final_path} ({} bytes)", content.len());
    Ok(())
}

/// Push a local file to update a note in NoteStation.
/// .md files are converted to HTML; .html/.htm files are pushed as-is.
pub async fn push(args: &NotePushArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let file_content = std::fs::read_to_string(&args.path)?;

    let is_html = args.path.ends_with(".html") || args.path.ends_with(".htm");
    let html = if is_html {
        file_content
    } else {
        markdown::md_to_html(&file_content)
    };

    note_station::update_note(&client, sid, token, &args.id, args.title.as_deref(), Some(&html)).await?;

    let fmt = if is_html { "HTML" } else { "Markdown→HTML" };
    println!("Pushed ({fmt}): {} → note {}", args.path, args.id);
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
