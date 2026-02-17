use std::time::Duration;

use tokio::time::sleep;

pub async fn run_sampler(interval_secs: u64) {
    let interval = Duration::from_secs(interval_secs.max(1));
    loop {
        #[cfg(target_os = "linux")]
        {
            if let Ok(rss_kib) = read_linux_rss_kib().await {
                info!("memory.rss_kib={rss_kib}");
            }
        }
        sleep(interval).await;
    }
}

#[cfg(target_os = "linux")]
async fn read_linux_rss_kib() -> anyhow::Result<u64> {
    let content = tokio::fs::read_to_string("/proc/self/status").await?;
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let value = rest.trim().split_whitespace().next().unwrap_or("0");
            let kib = value.parse::<u64>().unwrap_or(0);
            return Ok(kib);
        }
    }
    Ok(0)
}
