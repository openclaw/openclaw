use crate::models::config::Config;
use crate::providers::ConfigProvider;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// How long a cached config is considered fresh.
const CACHE_TTL: Duration = Duration::from_secs(5);

struct CacheEntry {
    config: Config,
    loaded_at: Instant,
}

pub struct ConfigService {
    app: AppHandle,
    provider: Box<dyn ConfigProvider>,
    cache: Arc<Mutex<Option<CacheEntry>>>,
}

impl ConfigService {
    pub fn new(app: AppHandle, provider: Box<dyn ConfigProvider>) -> Self {
        Self {
            app,
            provider,
            cache: Arc::new(Mutex::new(None)),
        }
    }

    fn get_path(&self) -> crate::error::Result<PathBuf> {
        self.app
            .path()
            .app_data_dir()
            .map(|d| d.join("config.json"))
            .map_err(|e| {
                crate::error::OpenClawError::Internal(format!("Failed to get app data dir: {}", e))
            })
    }

    /// Invalidate the in-memory cache, forcing the next `load()` to re-read from disk.
    pub async fn invalidate_cache(&self) {
        *self.cache.lock().await = None;
    }

    pub async fn load(&self) -> crate::error::Result<Config> {
        let mut cache = self.cache.lock().await;

        // Return cached value if it's still within the TTL
        if let Some(entry) = &*cache {
            if entry.loaded_at.elapsed() < CACHE_TTL {
                return Ok(entry.config.clone());
            }
        }

        // Cache miss or stale entry; reload from disk.
        let path = self.get_path()?;
        let config = self.provider.load(path)?;
        *cache = Some(CacheEntry {
            config: config.clone(),
            loaded_at: Instant::now(),
        });
        Ok(config)
    }

    pub async fn save(&self, config: &Config) -> crate::error::Result<()> {
        let path = self.get_path()?;
        self.provider.save(path, config)?;
        // Update cache with fresh value and reset TTL
        *self.cache.lock().await = Some(CacheEntry {
            config: config.clone(),
            loaded_at: Instant::now(),
        });
        Ok(())
    }

    pub async fn update<F>(&self, update_fn: F) -> crate::error::Result<()>
    where
        F: FnOnce(&mut Config),
    {
        let mut config = self.load().await?;
        update_fn(&mut config);
        self.save(&config).await
    }
}
