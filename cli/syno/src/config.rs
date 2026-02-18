use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::api::{auth, client::SynoClient};

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Config {
    pub host: Option<String>,
    pub port: Option<u16>,
    pub https: Option<bool>,
    pub username: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Session {
    pub sid: Option<String>,
    pub synotoken: Option<String>,
    pub device_id: Option<String>,
}

fn config_dir() -> Result<PathBuf> {
    let dir = dirs::config_dir()
        .context("Cannot determine config directory")?
        .join("synology-api");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn config_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

fn session_path() -> Result<PathBuf> {
    Ok(config_dir()?.join("session.toml"))
}

impl Config {
    pub fn load() -> Result<Self> {
        let path = config_path()?;
        let mut cfg = if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            toml::from_str(&content)?
        } else {
            Config::default()
        };

        // Environment variables override config file values
        if let Ok(host) = std::env::var("SYNO_HOST") {
            cfg.host = Some(host);
        }
        if let Ok(port) = std::env::var("SYNO_PORT") {
            if let Ok(p) = port.parse::<u16>() {
                cfg.port = Some(p);
            }
        }
        if let Ok(https) = std::env::var("SYNO_HTTPS") {
            cfg.https = Some(https == "true" || https == "1");
        }
        if let Ok(username) = std::env::var("SYNO_USERNAME") {
            cfg.username = Some(username);
        }

        Ok(cfg)
    }

    pub fn save(&self) -> Result<()> {
        let path = config_path()?;
        let content = toml::to_string_pretty(self)?;
        std::fs::write(&path, content)?;
        Ok(())
    }

    pub fn base_url(&self) -> String {
        let scheme = if self.https.unwrap_or(false) {
            "https"
        } else {
            "http"
        };
        let host = self.host.as_deref().unwrap_or("localhost");
        let port = self.port.unwrap_or(5000);
        format!("{scheme}://{host}:{port}")
    }
}

impl Session {
    pub fn load() -> Result<Self> {
        let path = session_path()?;
        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            let s: Session = toml::from_str(&content)?;
            Ok(s)
        } else {
            Ok(Session::default())
        }
    }

    pub fn save(&self) -> Result<()> {
        let path = session_path()?;
        let content = toml::to_string_pretty(self)?;
        std::fs::write(&path, content)?;
        Ok(())
    }

    pub fn clear() -> Result<()> {
        let path = session_path()?;
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }

    pub fn require_sid(&self) -> Result<&str> {
        self.sid
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Not logged in. Please run `syno login` first."))
    }

    pub fn synotoken(&self) -> Option<&str> {
        self.synotoken.as_deref().filter(|s| !s.is_empty())
    }

    /// Ensure we have a valid session. If no session file or sid is empty,
    /// auto-login using SYNO_USERNAME / SYNO_PASSWORD env vars (or config username).
    pub async fn ensure(cfg: &Config) -> Result<Self> {
        let session = Self::load()?;
        if session.sid.as_deref().filter(|s| !s.is_empty()).is_some() {
            return Ok(session);
        }

        // Auto-login from env vars
        let username = std::env::var("SYNO_USERNAME")
            .ok()
            .or_else(|| cfg.username.clone())
            .ok_or_else(|| anyhow::anyhow!(
                "No session and SYNO_USERNAME not set. Run `syno login` or set SYNO_USERNAME + SYNO_PASSWORD"
            ))?;

        let password = std::env::var("SYNO_PASSWORD")
            .ok()
            .ok_or_else(|| anyhow::anyhow!(
                "No session and SYNO_PASSWORD not set. Run `syno login` or set SYNO_PASSWORD"
            ))?;

        eprintln!("Auto-login as {username}...");
        let client = SynoClient::new(&cfg.base_url(), cfg.https.unwrap_or(false))?;
        let data = auth::login(&client, &username, &password, None).await?;
        let session = Session {
            sid: Some(data.sid),
            synotoken: data.synotoken,
            device_id: data.device_id,
        };
        session.save()?;
        eprintln!("Auto-login successful.");
        Ok(session)
    }
}
