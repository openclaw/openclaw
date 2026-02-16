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
