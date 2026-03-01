use crate::services::runtime::BackgroundService;
use async_trait::async_trait;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter};

pub struct DiscoveryService {
    running: Arc<AtomicBool>,
}

impl DiscoveryService {
    pub fn new() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn start_browsing(&self, app: AppHandle) -> crate::error::Result<()> {
        if self.running.load(Ordering::Relaxed) {
            return Ok(());
        }

        self.running.store(true, Ordering::Relaxed);
        let running = self.running.clone();

        tauri::async_runtime::spawn(async move {
            let mdns = match ServiceDaemon::new() {
                Ok(d) => d,
                Err(_) => return,
            };

            let local_hostnames = local_hostname_aliases();

            let receiver = match mdns.browse("_openclaw-gw._tcp.local.") {
                Ok(r) => r,
                Err(_) => return,
            };

            // The mDNS receiver iterator is blocking, so run it on the blocking thread pool.
            let running_clone = running.clone();
            let app_clone = app.clone();
            let _ = tokio::task::spawn_blocking(move || {
                for event in receiver {
                    if !running_clone.load(Ordering::Relaxed) {
                        break;
                    }

                    if let ServiceEvent::ServiceResolved(info) = event {
                        let host = info.get_hostname().to_string();
                        let addresses: Vec<String> = info
                            .get_addresses()
                            .iter()
                            .map(ToString::to_string)
                            .collect();

                        for address in addresses {
                            let payload = serde_json::json!({
                                "hostname": host,
                                "port": info.get_port(),
                                "address": address,
                                "fullname": info.get_fullname(),
                                "type": classify_gateway(&address, &host, &local_hostnames),
                            });

                            let _ = app_clone.emit("gateway_found", payload);
                        }
                    }
                }
                running_clone.store(false, Ordering::Relaxed);
            })
            .await;
        });

        Ok(())
    }

    pub fn stop_browsing(&self) {
        self.running.store(false, Ordering::Relaxed);
    }
}

fn normalize_hostname(raw: &str) -> String {
    raw.trim()
        .trim_end_matches('.')
        .trim_end_matches(".local")
        .to_ascii_lowercase()
}

fn local_hostname_aliases() -> HashSet<String> {
    let mut aliases = HashSet::new();
    if let Ok(hostname) = hostname::get() {
        if let Some(raw) = hostname.to_str() {
            let normalized = normalize_hostname(raw);
            if !normalized.is_empty() {
                aliases.insert(normalized.clone());
                if let Some((short, _)) = normalized.split_once('.') {
                    aliases.insert(short.to_string());
                }
            }
        }
    }
    aliases
}

fn is_local_hostname(hostname: &str, local_hostnames: &HashSet<String>) -> bool {
    if local_hostnames.is_empty() {
        return false;
    }

    let normalized = normalize_hostname(hostname);
    if normalized.is_empty() {
        return false;
    }

    local_hostnames.contains(&normalized)
        || normalized
            .split_once('.')
            .is_some_and(|(short, _)| local_hostnames.contains(short))
}

fn classify_gateway(address: &str, hostname: &str, local_hostnames: &HashSet<String>) -> String {
    if let Ok(ip) = address.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(v4) => {
                let octets = v4.octets();
                if v4.is_loopback() {
                    return "local".into();
                }
                if is_local_hostname(hostname, local_hostnames)
                    && octets[0] == 172
                    && (16..=31).contains(&octets[1])
                {
                    return "wsl".into();
                }
                if v4.is_private() {
                    return "remote".into();
                }
            }
            IpAddr::V6(v6) => {
                if v6.is_loopback() {
                    return "local".into();
                }
            }
        }
    }
    "unknown".into()
}

#[async_trait]
impl BackgroundService for DiscoveryService {
    fn name(&self) -> &'static str {
        "DiscoveryService"
    }

    async fn start(&self, _app: AppHandle) -> anyhow::Result<()> {
        Ok(())
    }

    async fn stop(&self) -> anyhow::Result<()> {
        self.stop_browsing();
        Ok(())
    }
}
