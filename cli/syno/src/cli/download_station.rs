use anyhow::Result;
use clap::Args;

use crate::api::{client::SynoClient, download_station};
use crate::config::{Config, Session};

#[derive(Args)]
pub struct CreateArgs {
    /// Download URL
    pub uri: String,
    /// Destination folder on NAS
    #[arg(short, long)]
    pub destination: Option<String>,
}

#[derive(Args)]
pub struct TaskIdsArgs {
    /// Comma-separated task IDs
    pub ids: String,
}

pub async fn list() -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let tasks = download_station::list(&client, sid, token).await?;
    if let Some(items) = tasks.tasks {
        if items.is_empty() {
            println!("No download tasks.");
            return Ok(());
        }
        for t in &items {
            let status = t.status.as_deref().unwrap_or("unknown");
            let title = t.title.as_deref().unwrap_or("<no title>");
            println!("[{status:<12}] {:<20} {title}", t.id);
        }
        println!("\nTotal: {}", tasks.total.unwrap_or(items.len() as u64));
    } else {
        println!("No download tasks.");
    }
    Ok(())
}

pub async fn create(args: &CreateArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    download_station::create(&client, sid, token, &args.uri, args.destination.as_deref()).await?;
    println!("Download task created.");
    Ok(())
}

pub async fn delete(args: &TaskIdsArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    download_station::delete(&client, sid, token, &args.ids).await?;
    println!("Task(s) deleted.");
    Ok(())
}

pub async fn pause(args: &TaskIdsArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    download_station::pause(&client, sid, token, &args.ids).await?;
    println!("Task(s) paused.");
    Ok(())
}

pub async fn resume(args: &TaskIdsArgs) -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let token = session.synotoken();
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    download_station::resume(&client, sid, token, &args.ids).await?;
    println!("Task(s) resumed.");
    Ok(())
}
