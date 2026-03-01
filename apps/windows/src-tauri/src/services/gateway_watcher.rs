use crate::providers::WslProvider;
use crate::services::runtime::BackgroundService;
use crate::services::ConfigService;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;
use tokio::sync::Mutex;

pub struct GatewayWatcherService {
    config: Arc<ConfigService>,
    wsl: Arc<dyn WslProvider>,
    shutdown_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
}

impl GatewayWatcherService {
    pub fn new(config: Arc<ConfigService>, wsl: Arc<dyn WslProvider>) -> Self {
        Self {
            config,
            wsl,
            shutdown_tx: Mutex::new(None),
        }
    }

    async fn get_gateway_status(&self) -> bool {
        let wsl = self.wsl.clone();
        // Use spawn_blocking for synchronous WSL calls
        let output = tokio::task::spawn_blocking(move || {
            wsl.run_command(&["bash", "-c", "openclaw gateway status --json"], false)
        })
        .await;

        match output {
            Ok(Ok(o)) if o.status.success() => {
                let json: Value = serde_json::from_slice(&o.stdout).unwrap_or_default();
                json["rpc"]["ok"].as_bool().unwrap_or(false)
            }
            _ => false,
        }
    }

    async fn try_start_gateway(&self) -> anyhow::Result<()> {
        let wsl = self.wsl.clone();

        // 1. Check if the systemd service exists and try to start it
        let has_service = {
            let wsl_clone = wsl.clone();
            tokio::task::spawn_blocking(move || {
                wsl_clone.run_command(&["bash", "-c", "systemctl list-unit-files openclaw-gateway.service | grep -q openclaw-gateway.service"], false)
                    .map(|o| o.status.success())
                    .unwrap_or(false)
            }).await.unwrap_or(false)
        };

        if has_service {
            tracing::info!("[GatewayWatcher] Attempting start via systemd...");
            let wsl_clone = wsl.clone();
            let _ = tokio::task::spawn_blocking(move || {
                wsl_clone.run_command(
                    &[
                        "-u",
                        "root",
                        "bash",
                        "-c",
                        "systemctl start openclaw-gateway.service",
                    ],
                    false,
                )
            })
            .await;

            // Short grace period
            tokio::time::sleep(Duration::from_secs(2)).await;
            if self.get_gateway_status().await {
                tracing::info!("[GatewayWatcher] Started successfully via systemd");
                return Ok(());
            }
        }

        // 2. Manual fallback start
        tracing::info!("[GatewayWatcher] Starting gateway manually");
        let wsl_clone = wsl.clone();
        let _ = tokio::task::spawn_blocking(move || {
            wsl_clone.spawn_command(&["bash", "-c", "openclaw gateway"])
        })
        .await??;

        // We don't block here. The main loop will verify status in the next iteration.
        Ok(())
    }
}

#[async_trait]
impl BackgroundService for GatewayWatcherService {
    fn name(&self) -> &'static str {
        "GatewayWatcherService"
    }

    async fn start(&self, _app: AppHandle) -> anyhow::Result<()> {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        {
            let mut lock = self.shutdown_tx.lock().await;
            *lock = Some(tx);
        }

        let config_service = self.config.clone();
        let wsl_provider = self.wsl.clone();
        let service = Arc::new(Self::new(config_service, wsl_provider));

        tokio::spawn(async move {
            tracing::info!("[GatewayWatcher] Background loop started");
            loop {
                let config = match service.config.load().await {
                    Ok(c) => c,
                    Err(_) => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        continue;
                    }
                };

                let is_wsl_mode = config.is_setup_completed
                    && (config.gateway_mode == "local"
                        || config.gateway_type.eq_ignore_ascii_case("wsl"));

                if is_wsl_mode {
                    // Non-blocking check
                    if !service.get_gateway_status().await {
                        if let Err(e) = service.try_start_gateway().await {
                            tracing::error!("[GatewayWatcher] Failed to start gateway: {}", e);
                        }
                    }
                }

                // Sleep or exit on shutdown
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                    _ = &mut rx => break,
                }
            }
            tracing::info!("[GatewayWatcher] Background loop stopped");
        });

        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        let mut lock = self.shutdown_tx.lock().await;
        if let Some(tx) = lock.take() {
            let _ = tx.send(());
        }
        Ok(())
    }
}
