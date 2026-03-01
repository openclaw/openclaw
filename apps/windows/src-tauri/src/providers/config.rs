use crate::models::config::Config;
use std::fs;
use std::path::PathBuf;

pub trait ConfigProvider: Send + Sync {
    fn load(&self, path: PathBuf) -> crate::error::Result<Config>;
    fn save(&self, path: PathBuf, config: &Config) -> crate::error::Result<()>;
}

pub struct JsonConfigProvider;

impl ConfigProvider for JsonConfigProvider {
    fn load(&self, path: PathBuf) -> crate::error::Result<Config> {
        if !path.exists() {
            return Ok(Config::default());
        }

        let data = fs::read_to_string(&path).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to read config file: {}", e))
        })?;

        let parsed: Config = serde_json::from_str(&data).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to parse config: {}", e))
        })?;

        Ok(parsed)
    }

    fn save(&self, path: PathBuf, config: &Config) -> crate::error::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to create config directory: {}",
                    e
                ))
            })?;
        }

        let json = serde_json::to_string_pretty(config).map_err(|e| {
            crate::error::OpenClawError::Internal(format!("Failed to serialize config: {}", e))
        })?;

        let tmp_path = path.with_extension("tmp");
        fs::write(&tmp_path, json).map_err(|e| {
            crate::error::OpenClawError::Internal(format!(
                "Failed to write temporary config file: {}",
                e
            ))
        })?;

        // `rename(tmp, path)` fails on Windows when `path` already exists.
        // Fall back to copy+remove for cross-platform overwrite semantics.
        if let Err(rename_err) = fs::rename(&tmp_path, &path) {
            fs::copy(&tmp_path, &path).map_err(|copy_err| {
                crate::error::OpenClawError::Internal(format!(
                    "Failed to commit config file (rename: {}; copy fallback: {})",
                    rename_err, copy_err
                ))
            })?;
            let _ = fs::remove_file(&tmp_path);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{ConfigProvider, JsonConfigProvider};
    use crate::models::config::Config;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn test_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after unix epoch")
            .as_nanos();
        dir.push(format!(
            "openclaw-config-provider-test-{}-{}",
            std::process::id(),
            stamp
        ));
        dir
    }

    #[test]
    fn save_overwrites_existing_config_file() {
        let provider = JsonConfigProvider;
        let dir = test_dir();
        let path = dir.join("config.json");

        let mut first = Config::default();
        first.gateway_mode = "local".to_string();
        first.start_on_login = false;
        provider
            .save(path.clone(), &first)
            .expect("first save should work");

        let mut second = first.clone();
        second.gateway_mode = "remote-direct".to_string();
        second.start_on_login = true;
        provider
            .save(path.clone(), &second)
            .expect("second save should overwrite existing file");

        let loaded = provider.load(path.clone()).expect("load should work");
        assert_eq!(loaded.gateway_mode, "remote-direct");
        assert!(loaded.start_on_login);

        let _ = fs::remove_file(path);
        let _ = fs::remove_dir_all(dir);
    }
}
