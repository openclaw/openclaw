use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct Config {
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub private_key: Vec<u8>,
    #[serde(default)]
    pub public_key: Vec<u8>,
    #[serde(default)]
    pub device_token: String,
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub address: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub gateway_type: String,
    pub ssh_user: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_path: Option<String>,

    pub is_setup_completed: bool,
}

fn get_config_path(app: &AppHandle) -> Result<PathBuf> {
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!("Unable to resolve app data directory: {}", e))?;

    if !base_dir.exists() {
        fs::create_dir_all(&base_dir).context("Failed to create app data directory")?;
    }
    Ok(base_dir.join("config.json"))
}

pub fn load_config(app: &AppHandle) -> Result<Config> {
    let path = get_config_path(app)?;

    if !path.exists() {
        return Ok(Config::default());
    }

    let data = fs::read_to_string(&path)
        .with_context(|| format!("Failed to read config file at {:?}", path))?;
    let parsed: Config =
        serde_json::from_str(&data).with_context(|| "Failed to parse config.json")?;

    Ok(parsed)
}

pub fn save_config(app: &AppHandle, config: &Config) -> Result<()> {
    let path = get_config_path(app)?;
    let json = serde_json::to_string_pretty(config).context("Failed to serialize config")?;

    // Atomic-ish write using a temporary file
    let tmp_path = path.with_extension("tmp");
    fs::write(&tmp_path, json).context("Failed to write temporary config file")?;
    if let Err(rename_err) = fs::rename(&tmp_path, &path) {
        fs::copy(&tmp_path, &path).with_context(|| {
            format!(
                "Failed to commit config file (rename: {}; copy fallback failed)",
                rename_err
            )
        })?;
        let _ = fs::remove_file(&tmp_path);
    }

    Ok(())
}

pub fn update_config<F>(app: &AppHandle, update_fn: F) -> Result<()>
where
    F: FnOnce(&mut Config),
{
    let mut config = load_config(app)?;
    update_fn(&mut config);
    save_config(app, &config)?;
    Ok(())
}
