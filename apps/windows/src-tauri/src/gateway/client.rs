use crate::models::config::Config;
use crate::services::runtime::BackgroundService;
use crate::services::GatewayService;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

fn resolve_gateway_mode(explicit_mode: Option<&str>, gateway_type: &str) -> String {
    let explicit = explicit_mode
        .map(str::trim)
        .filter(|m| !m.is_empty())
        .map(|m| m.to_ascii_lowercase());
    if let Some(mode) = explicit {
        if matches!(mode.as_str(), "local" | "remote-direct" | "remote-ssh") {
            return mode;
        }
    }

    match gateway_type.trim().to_ascii_lowercase().as_str() {
        "remote-ssh" => "remote-ssh".to_string(),
        "remote" | "remote-direct" => "remote-direct".to_string(),
        _ => "local".to_string(),
    }
}

fn resolve_remote_url(explicit_url: Option<&str>, address: &str, port: u16) -> Option<String> {
    if let Some(raw) = explicit_url {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    let host = address.trim();
    if host.is_empty() {
        return None;
    }

    if port == 0 {
        Some(format!("ws://{}", host))
    } else {
        Some(format!("ws://{}:{}", host, port))
    }
}

fn resolve_remote_ssh_target(
    ssh_user: Option<&str>,
    ssh_host: Option<&str>,
    ssh_port: Option<u16>,
    fallback_host: &str,
) -> Option<String> {
    let host = ssh_host
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| fallback_host.trim());
    if host.is_empty() {
        return None;
    }

    let user = ssh_user.map(str::trim).filter(|u| !u.is_empty());
    let port = ssh_port.unwrap_or(22);
    Some(match user {
        Some(user) if port == 22 => format!("{}@{}", user, host),
        Some(user) => format!("{}@{}:{}", user, host, port),
        None if port == 22 => host.to_string(),
        None => format!("{}:{}", host, port),
    })
}

fn connection_profile_changed(before: &Config, after: &Config) -> bool {
    before.gateway_mode != after.gateway_mode
        || before.gateway_type != after.gateway_type
        || before.address != after.address
        || before.port != after.port
        || before.auth_token != after.auth_token
        || before.remote_url != after.remote_url
        || before.remote_ssh_target != after.remote_ssh_target
}

#[tauri::command]
pub async fn connect_gateway(
    app: AppHandle,
    address: String,
    port: u16,
    token: String,
    gateway_type: String,
    gateway_mode: Option<String>,
    remote_url: Option<String>,
    ssh_user: Option<String>,
    ssh_host: Option<String>,
    ssh_port: Option<u16>,
    ssh_key_path: Option<String>,
    config_service: State<'_, Arc<crate::services::ConfigService>>,
) -> Result<bool, String> {
    let before = config_service.load().await.map_err(|e| e.to_string())?;

    let next_address = address.trim().to_string();
    let next_gateway_mode = resolve_gateway_mode(gateway_mode.as_deref(), &gateway_type);
    let next_remote_url = if next_gateway_mode == "remote-direct" {
        resolve_remote_url(remote_url.as_deref(), &next_address, port)
    } else {
        None
    };
    let next_remote_ssh_target = if next_gateway_mode == "remote-ssh" {
        resolve_remote_ssh_target(
            ssh_user.as_deref(),
            ssh_host.as_deref(),
            ssh_port,
            &next_address,
        )
    } else {
        None
    };

    config_service
        .update(|c| {
            c.address = next_address.clone();
            c.port = port;
            c.auth_token = token.clone();
            c.gateway_type = gateway_type.clone();
            c.gateway_mode = next_gateway_mode.clone();
            if let Some(url) = next_remote_url.clone() {
                c.remote_url = Some(url);
            }
            if let Some(target) = next_remote_ssh_target.clone() {
                c.remote_ssh_target = Some(target);
            }
            c.ssh_user = ssh_user.clone();
            c.ssh_host = ssh_host.clone();
            c.ssh_port = ssh_port;
            c.ssh_key_path = ssh_key_path.clone();
        })
        .await
        .map_err(|e| e.to_string())?;

    let after = config_service.load().await.map_err(|e| e.to_string())?;
    if connection_profile_changed(&before, &after) {
        let gateway = app.state::<Arc<GatewayService>>().inner().clone();
        <GatewayService as BackgroundService>::stop(gateway.as_ref())
            .await
            .map_err(|e| format!("Failed to stop gateway service for reconnect: {}", e))?;
        if !after.is_paused {
            <GatewayService as BackgroundService>::start(gateway.as_ref(), app.clone())
                .await
                .map_err(|e| format!("Failed to restart gateway service after connect: {}", e))?;
        }
    }

    Ok(true)
}

#[tauri::command]
pub async fn gateway_request(
    service: State<'_, Arc<GatewayService>>,
    request: String,
) -> Result<serde_json::Value, String> {
    service.request(request).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_gateway_status(
    service: State<'_, Arc<GatewayService>>,
) -> crate::error::Result<serde_json::Value> {
    service.get_status().await
}
