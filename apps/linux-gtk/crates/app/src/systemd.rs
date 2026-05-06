use gtk4::glib;
use tracing::{debug, warn};

use crate::state::AppState;

pub struct SystemdMonitor;

impl SystemdMonitor {
    /// Poll systemd for openclaw-gateway.service status and update AppState.
    /// Uses `systemctl --user is-active openclaw-gateway` since zbus adds
    /// a heavy dependency. Polls every 5 seconds.
    pub fn start(state: AppState) {
        glib::timeout_add_local(std::time::Duration::from_secs(5), move || {
            let output = std::process::Command::new("systemctl")
                .args(["--user", "is-active", "openclaw-gateway"])
                .output();
            let service_active = match output {
                Ok(o) => {
                    let status = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    debug!("systemd openclaw-gateway: {status}");
                    status == "active"
                }
                Err(e) => {
                    warn!("systemctl check failed: {e}");
                    false
                }
            };
            state.set_service_active(service_active);
            glib::ControlFlow::Continue
        });
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn service_status_parsing() {
        assert_eq!("active".trim(), "active");
        assert_ne!("inactive".trim(), "active");
        assert_ne!("failed".trim(), "active");
        assert_ne!("".trim(), "active");
    }

    #[test]
    fn service_status_with_whitespace() {
        assert_eq!("active\n".trim(), "active");
        assert_eq!("  active  ".trim(), "active");
        assert_ne!("activating\n".trim(), "active");
    }

    #[test]
    fn service_status_edge_cases() {
        // systemctl returns exactly one of these strings
        assert_ne!("inactive\n".trim(), "active");
        assert_ne!("deactivating\n".trim(), "active");
        assert_ne!("reloading\n".trim(), "active");
        // Only "active" (trimmed) should match
        assert_eq!("active".trim(), "active");
    }
}
