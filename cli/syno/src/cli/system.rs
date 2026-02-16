use anyhow::Result;

use crate::api::{client::SynoClient, system};
use crate::config::{Config, Session};

pub async fn info() -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::ensure(&cfg).await?;
    let sid = session.require_sid()?;
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let info = system::get_info(&client, sid, session.synotoken()).await?;
    println!("Model:       {}", info.model.as_deref().unwrap_or("N/A"));
    println!("Serial:      {}", info.serial.as_deref().unwrap_or("N/A"));
    println!("DSM Version: {}", info.version_string.as_deref().unwrap_or("N/A"));
    println!("Temperature: {}°C", info.temperature.map(|t| t.to_string()).unwrap_or("N/A".into()));
    println!("Uptime:      {}s", info.uptime.map(|u| u.to_string()).unwrap_or("N/A".into()));

    Ok(())
}
