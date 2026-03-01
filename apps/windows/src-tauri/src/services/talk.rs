use crate::providers::{AudioHandle, AudioProvider};
use crate::services::runtime::BackgroundService;
use async_trait::async_trait;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

pub struct TalkState {
    pub is_enabled: Arc<Mutex<bool>>,
}

pub struct TalkService {
    provider: Arc<dyn AudioProvider>,
    is_enabled: Arc<Mutex<bool>>,
    handle: Arc<Mutex<Option<Box<dyn AudioHandle>>>>,
}

impl TalkService {
    pub fn new(provider: Arc<dyn AudioProvider>) -> Self {
        Self {
            provider,
            is_enabled: Arc::new(Mutex::new(false)),
            handle: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn set_enabled(&self, enabled: bool) -> crate::error::Result<()> {
        let mut is_enabled = self.is_enabled.lock().await;
        *is_enabled = enabled;

        if enabled {
            let mut handle_lock = self.handle.lock().await;
            if handle_lock.is_none() {
                let handle = self.provider.build_input_stream(Box::new(|data| {
                    if data.is_empty() {
                        return;
                    }
                    let mut sum = 0.0;
                    for &sample in data {
                        sum += sample * sample;
                    }
                    let rms = (sum / data.len() as f32).sqrt();
                    if rms > 0.01 {
                        tracing::info!("Audio captured - RMS: {:.4}", rms);
                    }
                }))?;
                handle.play()?;
                *handle_lock = Some(handle);
            }
        } else {
            let mut handle_lock = self.handle.lock().await;
            *handle_lock = None;
        }
        Ok(())
    }

    pub async fn is_enabled(&self) -> bool {
        *self.is_enabled.lock().await
    }
}

#[async_trait]
impl BackgroundService for TalkService {
    fn name(&self) -> &'static str {
        "TalkService"
    }

    async fn start(&self, _app: AppHandle) -> anyhow::Result<()> {
        tracing::info!("Starting TalkService (Windows)...");
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        tracing::info!("Stopping TalkService...");
        self.set_enabled(false).await.ok();
        Ok(())
    }
}

#[tauri::command]
pub async fn set_talk_mode_enabled(app: AppHandle, enabled: bool) -> crate::error::Result<()> {
    let service = app.state::<Arc<TalkService>>();
    service.set_enabled(enabled).await
}

#[tauri::command]
pub async fn get_talk_mode_status(app: AppHandle) -> crate::error::Result<bool> {
    let service = app.state::<Arc<TalkService>>();
    Ok(service.is_enabled().await)
}
