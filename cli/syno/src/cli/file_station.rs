use std::path::PathBuf;

use anyhow::Result;
use clap::Args;

use crate::api::{client::SynoClient, file_station};
use crate::config::{Config, Session};

#[derive(Args)]
pub struct LsArgs {
    /// Folder path, e.g. /volume1/homes. If omitted, lists shared folders.
    pub path: Option<String>,

    /// Offset for pagination
    #[arg(long, default_value = "0")]
    pub offset: u64,

    /// Limit for pagination
    #[arg(long, default_value = "100")]
    pub limit: u64,
}

#[derive(Args)]
pub struct InfoArgs {
    /// File or folder path
    pub path: String,
}

#[derive(Args)]
pub struct DownloadArgs {
    /// Remote file path on NAS, e.g. /home/share/file.txt
    pub path: String,

    /// Local output path. Defaults to current dir with remote filename.
    #[arg(short, long)]
    pub output: Option<PathBuf>,
}

#[derive(Args)]
pub struct MkdirArgs {
    /// Parent folder path, e.g. /home
    pub folder_path: String,

    /// New folder name
    pub name: String,
}

#[derive(Args)]
pub struct RenameArgs {
    /// Full path of the file/folder to rename
    pub path: String,

    /// New name
    pub name: String,
}

#[derive(Args)]
pub struct DeleteArgs {
    /// Full path of the file/folder to delete
    pub path: String,
}

#[derive(Args)]
pub struct UploadArgs {
    /// Local file path to upload
    pub file: PathBuf,

    /// Remote destination folder, e.g. /home/share
    pub dest: String,

    /// Overwrite if file already exists
    #[arg(long, default_value = "false")]
    pub overwrite: bool,
}

pub async fn ls(args: &LsArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    match &args.path {
        None => {
            let shares = file_station::list_share(&client, sid, token).await?;
            if let Some(items) = shares.shares {
                for s in &items {
                    println!("{:<30} {}", s.name, s.path);
                }
                println!("\nTotal: {}", shares.total.unwrap_or(items.len() as u64));
            } else {
                println!("No shared folders found.");
            }
        }
        Some(folder) => {
            let list = file_station::list(&client, sid, token, folder, args.offset, args.limit).await?;
            if let Some(files) = list.files {
                for f in &files {
                    let kind = if f.isdir { "DIR " } else { "FILE" };
                    println!("{} {:<40} {}", kind, f.name, f.path);
                }
                println!("\nTotal: {}", list.total.unwrap_or(files.len() as u64));
            } else {
                println!("No files found.");
            }
        }
    }
    Ok(())
}

pub async fn info(args: &InfoArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let result = file_station::get_info(&client, sid, token, &args.path).await?;
    if let Some(files) = result.files {
        for f in &files {
            println!("Name:  {}", f.name);
            println!("Path:  {}", f.path);
            println!("IsDir: {}", f.isdir);
            if let Some(ref add) = f.additional {
                println!("Info:  {}", serde_json::to_string_pretty(add)?);
            }
        }
    }
    Ok(())
}

/// Download a file from NAS to local.
pub async fn download(args: &DownloadArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let local_path = match &args.output {
        Some(p) => p.clone(),
        None => {
            // Extract filename from remote path
            let filename = args
                .path
                .rsplit('/')
                .next()
                .unwrap_or("download");
            PathBuf::from(filename)
        }
    };

    let bytes = file_station::download(&client, sid, token, &args.path, &local_path).await?;
    println!("Downloaded {} -> {} ({} bytes)", args.path, local_path.display(), bytes);
    Ok(())
}

/// Create a folder.
pub async fn mkdir(args: &MkdirArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = file_station::create_folder(&client, sid, token, &args.folder_path, &args.name).await?;
    println!("Folder created: {}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// Rename a file or folder.
pub async fn rename(args: &RenameArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let data = file_station::rename(&client, sid, token, &args.path, &args.name).await?;
    println!("Renamed: {}", serde_json::to_string_pretty(&data)?);
    Ok(())
}

/// Delete a file or folder.
pub async fn delete(args: &DeleteArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    file_station::delete(&client, sid, token, &args.path).await?;
    println!("Deleted: {}", args.path);
    Ok(())
}

/// Upload a local file to NAS.
pub async fn upload(args: &UploadArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    if !args.file.exists() {
        anyhow::bail!("Local file not found: {}", args.file.display());
    }

    let meta = std::fs::metadata(&args.file)?;
    let data = file_station::upload(&client, sid, token, &args.dest, &args.file, args.overwrite).await?;
    println!(
        "Uploaded {} -> {} ({} bytes)\n{}",
        args.file.display(),
        args.dest,
        meta.len(),
        serde_json::to_string_pretty(&data)?
    );
    Ok(())
}
