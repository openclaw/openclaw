use clap::Args;

use crate::config::Config;
use anyhow::Result;

#[derive(Args)]
pub struct ConfigSetArgs {
    /// NAS host (IP or hostname)
    #[arg(long)]
    pub host: Option<String>,
    /// NAS port (default 5000)
    #[arg(long)]
    pub port: Option<u16>,
    /// Use HTTPS
    #[arg(long)]
    pub https: Option<bool>,
    /// Default username
    #[arg(long)]
    pub username: Option<String>,
}

pub fn config_set(args: &ConfigSetArgs) -> Result<()> {
    let mut cfg = Config::load()?;
    if let Some(ref h) = args.host {
        cfg.host = Some(h.clone());
    }
    if let Some(p) = args.port {
        cfg.port = Some(p);
    }
    if let Some(s) = args.https {
        cfg.https = Some(s);
    }
    if let Some(ref u) = args.username {
        cfg.username = Some(u.clone());
    }
    cfg.save()?;
    println!("Config saved.");
    Ok(())
}

pub fn config_show() -> Result<()> {
    let cfg = Config::load()?;
    println!("host:     {}", cfg.host.as_deref().unwrap_or("<not set>"));
    println!("port:     {}", cfg.port.map(|p| p.to_string()).unwrap_or("<not set>".into()));
    println!("https:    {}", cfg.https.map(|b| b.to_string()).unwrap_or("<not set>".into()));
    println!("username: {}", cfg.username.as_deref().unwrap_or("<not set>"));
    Ok(())
}
