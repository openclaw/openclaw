use crate::providers::MediaProvider;
use crate::services::runtime::BackgroundService;
use crate::services::ConfigService;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub struct MediaService {
    provider: Arc<dyn MediaProvider>,
}

impl MediaService {
    pub fn new(provider: Arc<dyn MediaProvider>) -> Self {
        Self { provider }
    }
}

#[async_trait]
impl BackgroundService for MediaService {
    fn name(&self) -> &'static str {
        "MediaService"
    }

    async fn start(&self, _app: AppHandle) -> anyhow::Result<()> {
        tracing::info!("Starting MediaService (Windows)...");
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        tracing::info!("Stopping MediaService...");
        Ok(())
    }
}

#[tauri::command]
pub async fn start_screen_capture(_app: AppHandle) -> crate::error::Result<()> {
    tracing::info!("Request to start screen capture received.");
    Ok(())
}

#[tauri::command]
pub async fn stop_screen_capture(_app: AppHandle) -> crate::error::Result<()> {
    tracing::info!("Request to stop screen capture received.");
    Ok(())
}

async fn ensure_camera_enabled(app: &AppHandle) -> crate::error::Result<()> {
    let config_service = app.state::<Arc<ConfigService>>();
    let cfg = config_service.load().await?;
    if cfg.camera_enabled {
        Ok(())
    } else {
        Err(crate::error::OpenClawError::Internal(
            "Camera feature is disabled in Settings > General.".to_string(),
        ))
    }
}

pub async fn handle_camera_list(app: &AppHandle, _params: &Value) -> crate::error::Result<Value> {
    ensure_camera_enabled(app).await?;
    let service = app.state::<Arc<MediaService>>();
    service.provider.list_cameras()
}

pub async fn handle_camera_snap(app: &AppHandle, params: &Value) -> crate::error::Result<Value> {
    ensure_camera_enabled(app).await?;
    let index = params["deviceId"]
        .as_str()
        .map(|s| s.parse::<u32>().unwrap_or(0))
        .unwrap_or(0);

    let service = app.state::<Arc<MediaService>>();
    service.provider.capture_camera_frame(index)
}

pub async fn handle_screen_record(app: &AppHandle, params: &Value) -> crate::error::Result<Value> {
    let monitor_index = params["monitorIndex"].as_u64().unwrap_or(0) as usize;
    let service = app.state::<Arc<MediaService>>();
    service.provider.capture_screen(monitor_index)
}
