use anyhow::Result;
use clap::Args;
use std::env;

use crate::api::{auth, client::SynoClient};
use crate::config::{Config, Session};

#[derive(Args)]
pub struct LoginArgs {
    /// Username (overrides env SYNO_USERNAME and config)
    #[arg(short, long)]
    pub username: Option<String>,
    /// Password (overrides env SYNO_PASSWORD)
    #[arg(short, long)]
    pub password: Option<String>,
    /// OTP code for 2FA
    #[arg(long)]
    pub otp: Option<String>,
}

pub async fn login(args: &LoginArgs) -> Result<()> {
    let cfg = Config::load()?;
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;

    let username = args
        .username
        .as_deref()
        .or(env::var("SYNO_USERNAME").ok().as_deref())
        .or(cfg.username.as_deref())
        .ok_or_else(|| anyhow::anyhow!("Username is required. Provide --username, set SYNO_USERNAME, or use `syno config set --username <user>`"))?
        .to_string();

    let password = args
        .password
        .as_deref()
        .or(env::var("SYNO_PASSWORD").ok().as_deref())
        .ok_or_else(|| anyhow::anyhow!("Password is required. Provide --password or set SYNO_PASSWORD"))?
        .to_string();

    let data = auth::login(&client, &username, &password, args.otp.as_deref()).await?;
    let session = Session {
        sid: Some(data.sid),
        synotoken: data.synotoken,
        device_id: data.device_id,
    };
    session.save()?;
    println!("Login successful.");
    Ok(())
}

pub async fn logout() -> Result<()> {
    let cfg = Config::load()?;
    let session = Session::load()?;
    let sid = session.require_sid()?;
    let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;
    auth::logout(&client, sid).await?;
    Session::clear()?;
    println!("Logged out.");
    Ok(())
}
