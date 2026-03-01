use anyhow::Context;
use async_trait::async_trait;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::Mutex;

/// Trait for background services that need a persistent lifecycle.
#[async_trait]
pub trait BackgroundService: Send + Sync {
    fn name(&self) -> &'static str;
    async fn start(&self, app: AppHandle) -> anyhow::Result<()>;
    async fn stop(&self) -> anyhow::Result<()>;
}

#[derive(Clone)]
pub struct RuntimeManager {
    inner: Arc<RuntimeManagerInner>,
}

struct RuntimeManagerInner {
    app: AppHandle,
    services: Arc<Mutex<Vec<Arc<dyn BackgroundService>>>>,
}

impl RuntimeManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            inner: Arc::new(RuntimeManagerInner {
                app,
                services: Arc::new(Mutex::new(Vec::new())),
            }),
        }
    }

    pub async fn register(&self, service: Arc<dyn BackgroundService>) -> anyhow::Result<()> {
        let name = service.name();
        service
            .start(self.inner.app.clone())
            .await
            .with_context(|| format!("Failed to start background service: {}", name))?;

        let mut services = self.inner.services.lock().await;
        services.push(service);
        Ok(())
    }

    pub async fn stop_all(&self) {
        let mut services = self.inner.services.lock().await;
        for service in services.drain(..) {
            if let Err(e) = service.stop().await {
                tracing::error!("Error stopping service {}: {}", service.name(), e);
            }
        }
    }
}
