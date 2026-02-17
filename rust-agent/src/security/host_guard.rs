use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::Result;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

pub struct HostIntegrityGuard {
    baseline: HashMap<PathBuf, String>,
    tick: Mutex<IntegrityTick>,
}

struct IntegrityTick {
    next_check_at: Instant,
    interval: Duration,
}

impl HostIntegrityGuard {
    pub async fn new(paths: &[PathBuf]) -> Result<Self> {
        let mut baseline = HashMap::new();
        for path in paths {
            if let Some(hash) = sha256_path(path).await? {
                baseline.insert(path.clone(), hash);
            }
        }

        Ok(Self {
            baseline,
            tick: Mutex::new(IntegrityTick {
                next_check_at: Instant::now(),
                interval: Duration::from_secs(20),
            }),
        })
    }

    pub async fn check_for_tampering(&self) -> Result<Vec<String>> {
        {
            let mut tick = self.tick.lock().await;
            if Instant::now() < tick.next_check_at {
                return Ok(Vec::new());
            }
            tick.next_check_at = Instant::now() + tick.interval;
        }

        let mut alerts = Vec::new();
        for (path, baseline_hash) in &self.baseline {
            match sha256_path(path).await? {
                Some(current_hash) if &current_hash != baseline_hash => {
                    alerts.push(format!(
                        "{} hash changed (baseline={}, current={})",
                        path.display(),
                        baseline_hash,
                        current_hash
                    ));
                }
                None => {
                    alerts.push(format!("{} is missing", path.display()));
                }
                _ => {}
            }
        }
        Ok(alerts)
    }
}

async fn sha256_path(path: &Path) -> Result<Option<String>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = tokio::fs::read(path).await?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let hash = format!("{:x}", hasher.finalize());
    Ok(Some(hash))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::HostIntegrityGuard;

    fn temp_file_path(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        p.push(format!("openclaw-rs-{name}-{stamp}.tmp"));
        p
    }

    #[tokio::test]
    async fn no_alert_when_file_unchanged() {
        let file = temp_file_path("host-ok");
        tokio::fs::write(&file, b"baseline").await.expect("write");

        let guard = HostIntegrityGuard::new(std::slice::from_ref(&file))
            .await
            .expect("guard");
        let alerts = guard.check_for_tampering().await.expect("check");
        assert!(alerts.is_empty());

        let _ = tokio::fs::remove_file(file).await;
    }

    #[tokio::test]
    async fn alert_when_file_changes() {
        let file = temp_file_path("host-change");
        tokio::fs::write(&file, b"baseline").await.expect("write");
        let guard = HostIntegrityGuard::new(std::slice::from_ref(&file))
            .await
            .expect("guard");

        tokio::fs::write(&file, b"modified").await.expect("rewrite");
        let alerts = guard.check_for_tampering().await.expect("check");
        assert!(!alerts.is_empty());
        assert!(alerts.iter().any(|a| a.contains("hash changed")));

        let _ = tokio::fs::remove_file(file).await;
    }
}
