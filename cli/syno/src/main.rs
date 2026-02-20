use clap::{Parser, Subcommand};

mod api;
mod cli;
mod config;
mod crypto;
mod markdown;
mod mcp;

#[derive(Parser)]
#[command(name = "syno", version, about = "Synology DSM API CLI")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Configure connection settings
    #[command(subcommand)]
    Config(ConfigCmd),

    /// Login to Synology DSM
    Login(cli::auth::LoginArgs),

    /// Logout from Synology DSM
    Logout,

    /// Show DSM system info
    Info,

    /// FileStation operations
    #[command(subcommand)]
    Fs(FsCmd),

    /// DownloadStation operations
    #[command(subcommand)]
    Dl(DlCmd),

    /// NoteStation operations
    #[command(subcommand)]
    Note(NoteCmd),

    /// Start MCP SSE server
    Mcp(McpArgs),

    /// Start MCP stdio server (for local use, saves AI tokens)
    McpStdio(McpStdioArgs),
}

#[derive(clap::Args)]
struct McpArgs {
    /// Listen host (default 0.0.0.0)
    #[arg(long, default_value = "0.0.0.0")]
    host: String,
    /// Listen port (default 3000)
    #[arg(long, default_value = "3000")]
    port: u16,
}

#[derive(clap::Args)]
struct McpStdioArgs {
    /// NAS host (IP or domain). Can also be set via SYNO_HOST env var.
    #[arg(long, env = "SYNO_HOST")]
    host: String,
    /// NAS port (default 5000). Can also be set via SYNO_PORT env var.
    #[arg(long, env = "SYNO_PORT", default_value = "5000")]
    port: u16,
    /// Use HTTPS. Can also be set via SYNO_HTTPS env var.
    #[arg(long, env = "SYNO_HTTPS", default_value = "false")]
    https: bool,
    /// Login username. Can also be set via SYNO_USERNAME env var.
    #[arg(long, env = "SYNO_USERNAME")]
    username: String,
    /// Login password. Can also be set via SYNO_PASSWORD env var.
    #[arg(long, env = "SYNO_PASSWORD")]
    password: String,
}

#[derive(Subcommand)]
enum ConfigCmd {
    /// Set configuration values
    Set(cli::config::ConfigSetArgs),
    /// Show current configuration
    Show,
}

#[derive(Subcommand)]
enum FsCmd {
    /// List shared folders or files in a directory
    Ls(cli::file_station::LsArgs),
    /// Get info about a file or folder
    Info(cli::file_station::InfoArgs),
    /// Download a file from NAS
    Download(cli::file_station::DownloadArgs),
    /// Create a folder
    Mkdir(cli::file_station::MkdirArgs),
    /// Rename a file or folder
    Rename(cli::file_station::RenameArgs),
    /// Delete a file or folder
    Delete(cli::file_station::DeleteArgs),
    /// Upload a local file to NAS
    Upload(cli::file_station::UploadArgs),
}

#[derive(Subcommand)]
enum DlCmd {
    /// List download tasks
    Ls,
    /// Create a download task
    Create(cli::download_station::CreateArgs),
    /// Delete download tasks
    Delete(cli::download_station::TaskIdsArgs),
    /// Pause download tasks
    Pause(cli::download_station::TaskIdsArgs),
    /// Resume download tasks
    Resume(cli::download_station::TaskIdsArgs),
}

#[derive(Subcommand)]
enum NoteCmd {
    /// Show NoteStation info
    Info,
    /// List notebooks
    Notebooks,
    /// List notes
    Notes(cli::note_station::NoteListArgs),
    /// Get a note by ID (with content)
    Get(cli::note_station::NoteGetArgs),
    /// Create a note
    Create(cli::note_station::NoteCreateArgs),
    /// Update a note (title and/or content)
    Update(cli::note_station::NoteUpdateArgs),
    /// Delete a note
    Delete(cli::note_station::NoteDeleteArgs),
    /// Move a note to another notebook
    Move(cli::note_station::NoteMoveArgs),
    /// Create a notebook
    CreateNotebook(cli::note_station::CreateNotebookArgs),
    /// Rename a notebook
    RenameNotebook(cli::note_station::RenameNotebookArgs),
    /// Delete a notebook
    DeleteNotebook(cli::note_station::DeleteNotebookArgs),
    /// Add a tag to a note (tag auto-created if not exists)
    Tag(cli::note_station::NoteTagArgs),
    /// Remove a tag from a note
    Untag(cli::note_station::NoteTagArgs),
    /// List tags
    Tags,
    /// List todos
    Todos(cli::note_station::TodoListArgs),
    /// Create a todo
    CreateTodo(cli::note_station::TodoCreateArgs),
    /// Update a todo (title, done, star, due_date, comment)
    UpdateTodo(cli::note_station::TodoUpdateArgs),
    /// Delete a todo
    DeleteTodo(cli::note_station::TodoDeleteArgs),
    /// Mark a todo as done (or --undo to mark undone)
    Done(cli::note_station::TodoDoneArgs),
    /// Full-text search notes
    Search(cli::note_station::SearchArgs),
    /// Pull a note to a local file (auto HTML→Markdown conversion)
    Pull(cli::note_station::NotePullArgs),
    /// Push a local file to update a note (auto Markdown→HTML conversion)
    Push(cli::note_station::NotePushArgs),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env file: try CWD first, then the crate source directory (for `cargo run`
    // invoked from a parent directory with `--manifest-path`).
    if dotenvy::dotenv().is_err() {
        let manifest_env = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".env");
        if manifest_env.is_file() {
            dotenvy::from_path(&manifest_env).ok();
        }
    }

    let cli = Cli::parse();

    match cli.command {
        Commands::Config(cmd) => match cmd {
            ConfigCmd::Set(args) => cli::config::config_set(&args)?,
            ConfigCmd::Show => cli::config::config_show()?,
        },
        Commands::Login(args) => cli::auth::login(&args).await?,
        Commands::Logout => cli::auth::logout().await?,
        Commands::Info => cli::system::info().await?,
        Commands::Fs(cmd) => match cmd {
            FsCmd::Ls(args) => cli::file_station::ls(&args).await?,
            FsCmd::Info(args) => cli::file_station::info(&args).await?,
            FsCmd::Download(args) => cli::file_station::download(&args).await?,
            FsCmd::Mkdir(args) => cli::file_station::mkdir(&args).await?,
            FsCmd::Rename(args) => cli::file_station::rename(&args).await?,
            FsCmd::Delete(args) => cli::file_station::delete(&args).await?,
            FsCmd::Upload(args) => cli::file_station::upload(&args).await?,
        },
        Commands::Dl(cmd) => match cmd {
            DlCmd::Ls => cli::download_station::list().await?,
            DlCmd::Create(args) => cli::download_station::create(&args).await?,
            DlCmd::Delete(args) => cli::download_station::delete(&args).await?,
            DlCmd::Pause(args) => cli::download_station::pause(&args).await?,
            DlCmd::Resume(args) => cli::download_station::resume(&args).await?,
        },
        Commands::Mcp(args) => mcp::run_server(&args.host, args.port).await?,
        Commands::McpStdio(args) => mcp::run_stdio(&args.host, args.port, args.https, &args.username, &args.password).await?,
        Commands::Note(cmd) => match cmd {
            NoteCmd::Info => cli::note_station::info().await?,
            NoteCmd::Notebooks => cli::note_station::notebooks().await?,
            NoteCmd::Notes(args) => cli::note_station::notes(&args).await?,
            NoteCmd::Get(args) => cli::note_station::get(&args).await?,
            NoteCmd::Create(args) => cli::note_station::create(&args).await?,
            NoteCmd::Update(args) => cli::note_station::update(&args).await?,
            NoteCmd::Delete(args) => cli::note_station::delete(&args).await?,
            NoteCmd::Move(args) => cli::note_station::move_note(&args).await?,
            NoteCmd::CreateNotebook(args) => cli::note_station::create_notebook(&args).await?,
            NoteCmd::RenameNotebook(args) => cli::note_station::rename_notebook(&args).await?,
            NoteCmd::DeleteNotebook(args) => cli::note_station::delete_notebook(&args).await?,
            NoteCmd::Tag(args) => cli::note_station::tag(&args).await?,
            NoteCmd::Untag(args) => cli::note_station::untag(&args).await?,
            NoteCmd::Tags => cli::note_station::tags().await?,
            NoteCmd::Todos(args) => cli::note_station::todos(&args).await?,
            NoteCmd::CreateTodo(args) => cli::note_station::create_todo(&args).await?,
            NoteCmd::UpdateTodo(args) => cli::note_station::update_todo(&args).await?,
            NoteCmd::DeleteTodo(args) => cli::note_station::delete_todo(&args).await?,
            NoteCmd::Done(args) => cli::note_station::done_todo(&args).await?,
            NoteCmd::Search(args) => cli::note_station::search(&args).await?,
            NoteCmd::Pull(args) => cli::note_station::pull(&args).await?,
            NoteCmd::Push(args) => cli::note_station::push(&args).await?,
        },
    }

    Ok(())
}
