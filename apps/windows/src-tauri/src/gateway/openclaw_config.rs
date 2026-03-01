use crate::error::OpenClawError;
use crate::providers::WslProvider;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Deserialize, Serialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum FetchMethod {
    Local,
    Ssh {
        user: String,
        host: String,
        port: u16,
        key_path: Option<String>,
    },
}

#[derive(Deserialize, Serialize, Debug)]
pub struct GatewayAuthConfig {
    pub token: String,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct GatewayConfig {
    pub port: u16,
    pub mode: String, // "local" or "remote"
    pub auth: GatewayAuthConfig,
    pub remote: Option<GatewayRemoteConfig>,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct GatewayRemoteConfig {
    pub url: String,
    pub token: String,
}

#[derive(Deserialize, Serialize, Debug)]
pub struct OpenClawConfig {
    pub gateway: GatewayConfig,
}

fn extract_token(content: &str) -> Option<String> {
    let config: OpenClawConfig = serde_json::from_str(content).ok()?;
    Some(config.gateway.auth.token)
}

use crate::services::system::SystemService;

async fn fetch_token_from_ssh(
    system: &SystemService,
    user: &str,
    host: &str,
    port: u16,
    key_path: Option<String>,
) -> crate::error::Result<String> {
    let mut args = vec![
        "-p".to_string(),
        port.to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "ConnectTimeout=5".to_string(),
    ];

    if let Some(path) = key_path {
        args.push("-i".to_string());
        args.push(path);
    }

    args.push(format!("{}@{}", user, host));
    args.push("cat ~/.openclaw/openclaw.json".to_string());

    let mut full_command = vec!["ssh.exe".to_string()];
    full_command.extend(args);

    let output = system.run_command(&full_command, None, None, None).await?;

    if !output.status.success() {
        return Err(OpenClawError::Internal(format!(
            "SSH command failed (code {}): {}",
            output.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&output.stderr)
        )));
    }

    let content = String::from_utf8_lossy(&output.stdout);
    extract_token(&content)
        .ok_or_else(|| OpenClawError::Internal("Token not found in remote config".to_string()))
}

#[tauri::command]
pub async fn read_openclaw_config(
    _app: AppHandle,
    wsl: State<'_, Arc<dyn WslProvider>>,
    distro: Option<String>,
) -> crate::error::Result<OpenClawConfig> {
    let distros = if let Some(d) = distro {
        vec![d]
    } else {
        let mut ds = Vec::new();
        if let Some(d) = wsl.get_distro() {
            ds.push(d);
        }
        ds
    };

    if distros.is_empty() {
        return Err(OpenClawError::Internal("No WSL distros found".to_string()));
    }

    for distro in distros {
        let args = ["-d", &distro, "cat", "~/.openclaw/openclaw.json"];
        let output = wsl
            .run_command(&args, false)
            .map_err(|e| OpenClawError::Internal(format!("WSL execution failed: {}", e)))?;

        if output.status.success() {
            let content = String::from_utf8_lossy(&output.stdout);
            let config: OpenClawConfig = serde_json::from_str(&content)
                .map_err(|e| OpenClawError::Internal(format!("Failed to parse config: {}", e)))?;
            return Ok(config);
        }
    }

    Err(OpenClawError::Internal(
        "Could not find openclaw.json in any WSL distro".to_string(),
    ))
}

#[tauri::command]
pub async fn get_gateway_token(
    app: AppHandle,
    wsl: State<'_, Arc<dyn WslProvider>>,
    system: State<'_, Arc<SystemService>>,
    method: Option<FetchMethod>,
) -> crate::error::Result<String> {
    match method {
        None | Some(FetchMethod::Local) => {
            let config = read_openclaw_config(app, wsl, None).await?;
            Ok(config.gateway.auth.token)
        }
        Some(FetchMethod::Ssh {
            user,
            host,
            port,
            key_path,
        }) => fetch_token_from_ssh(&system, &user, &host, port, key_path).await,
    }
}
