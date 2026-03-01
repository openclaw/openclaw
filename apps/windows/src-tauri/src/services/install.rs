use crate::providers::WslProvider;
use crate::services::EventDispatcher;
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::sync::Arc;

#[derive(Serialize, Clone)]
struct InstallStatus {
    step: String,
    status: String,
    message: Option<String>,
}

pub struct WslInstallService {
    provider: Arc<dyn WslProvider>,
    events: Arc<EventDispatcher>,
}

impl WslInstallService {
    pub fn new(provider: Arc<dyn WslProvider>, events: Arc<EventDispatcher>) -> Self {
        Self { provider, events }
    }

    fn emit_status(&self, step: &str, status: &str, message: Option<&str>) {
        let _ = self.events.emit(
            "install-status",
            InstallStatus {
                step: step.to_string(),
                status: status.to_string(),
                message: message.map(|s| s.to_string()),
            },
        );
    }

    fn decode_wsl_text(output: &[u8]) -> String {
        if output.contains(&0) && output.len().is_multiple_of(2) {
            let utf16: Vec<u16> = output
                .chunks_exact(2)
                .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                .collect();
            String::from_utf16_lossy(&utf16)
        } else {
            String::from_utf8_lossy(output).to_string()
        }
    }

    fn is_helper_distro(name: &str) -> bool {
        let normalized = name.trim().to_ascii_lowercase();
        matches!(normalized.as_str(), "docker-desktop" | "docker-desktop-data")
    }

    fn has_usable_distro_shell(&self, distro: &str) -> bool {
        let args = ["-d", distro, "-e", "sh", "-lc", "true"];
        self.provider
            .run_command(&args, false)
            .map(|output| output.status.success())
            .unwrap_or(false)
    }

    fn find_target_distro(&self) -> Option<String> {
        let output = self.provider.run_command(&["-l", "-q"], false).ok()?;
        if !output.status.success() {
            return None;
        }

        let distros = Self::decode_wsl_text(&output.stdout);
        distros
            .lines()
            .map(|line| line.trim().trim_matches('\0'))
            .filter(|line| !line.is_empty())
            .filter(|line| !Self::is_helper_distro(line))
            .find(|line| self.has_usable_distro_shell(line))
            .map(ToString::to_string)
    }

    pub async fn check_and_install<F>(&self, on_pid: F) -> crate::error::Result<()>
    where
        F: FnOnce(u32) + Send + 'static,
    {
        self.emit_status("wsl", "installing", Some("Checking WSL status..."));
        let mut on_pid = Some(on_pid);

        if let Some(distro) = self.find_target_distro() {
            self.emit_status(
                "wsl",
                "installed",
                Some(&format!("WSL ({}) is ready", distro)),
            );
        } else {
            self.emit_status(
                "wsl",
                "installing",
                Some("No WSL distro found. Starting installation..."),
            );

            let mut child =
                self.provider
                    .spawn_command(&["--install", "-d", "Ubuntu", "--no-launch"])?;
            if let Some(cb) = on_pid.take() {
                cb(child.id());
            }

            let stdout = child
                .stdout
                .take()
                .ok_or(crate::error::OpenClawError::Internal(
                    "Failed to open stdout".to_string(),
                ))?;
            let events_clone = self.events.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    if let Ok(l) = line {
                        let _ = events_clone.emit(
                            "install-status",
                            InstallStatus {
                                step: "wsl".to_string(),
                                status: "installing".to_string(),
                                message: Some(l),
                            },
                        );
                    }
                }
            });

            let status = child.wait().map_err(crate::error::OpenClawError::from)?;
            if status.success() {
                self.emit_status("wsl", "installed", Some("WSL ready"));
            } else {
                self.emit_status("wsl", "failed", Some("WSL installation failed"));
                return Err(crate::error::OpenClawError::Internal(
                    "WSL install failed".to_string(),
                ));
            }
        }

        self.enable_systemd().await?;
        Ok(())
    }

    pub async fn enable_systemd(&self) -> crate::error::Result<()> {
        self.emit_status("wsl", "installing", Some("Enabling systemd in WSL..."));

        let bash_cmd = r#"
if [ ! -f /etc/wsl.conf ]; then
    printf "[boot]\nsystemd=true\n" > /etc/wsl.conf
elif ! grep -q "systemd=true" /etc/wsl.conf; then
    if ! grep -q "\[boot\]" /etc/wsl.conf; then
        printf "\n[boot]\nsystemd=true\n" >> /etc/wsl.conf
    else
        sed -i '/\[boot\]/a systemd=true' /etc/wsl.conf
    fi
fi
"#;
        let output = self
            .provider
            .run_command(&["-u", "root", "-e", "bash", "-c", bash_cmd], false)?;

        if output.status.success() {
            tracing::info!("Systemd enabled in wsl.conf");
            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).to_string();
            Err(crate::error::OpenClawError::Internal(err))
        }
    }

    pub async fn install_openclaw(
        &self,
        on_pid: impl FnOnce(u32) + Send + 'static,
    ) -> crate::error::Result<()> {
        self.emit_status(
            "system",
            "installing",
            Some("Starting OpenClaw installation..."),
        );

        let wsl_cmd = "curr_dir=$(pwd) && cd /tmp && curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard && cd $curr_dir";
        let mut child = self
            .provider
            .spawn_command(&["-e", "bash", "-c", wsl_cmd])?;

        // Capture PID immediately, before stdout is moved into the reader thread.
        // The caller uses this to fill InstallerState so abort_installation can kill the process.
        on_pid(child.id());

        let stdout = child
            .stdout
            .take()
            .ok_or(crate::error::OpenClawError::Internal(
                "Failed to open stdout".to_string(),
            ))?;
        let events_clone = self.events.clone();

        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            let mut current_phase = "system";

            for line in reader.lines() {
                if let Ok(l) = line {
                    let lower = l.to_lowercase();

                    if l.contains("[1/3] Preparing environment") {
                        let _ = events_clone.emit(
                            "install-status",
                            InstallStatus {
                                step: "system".to_string(),
                                status: "installing".to_string(),
                                message: Some("Preparing environment...".to_string()),
                            },
                        );
                    } else if l.contains("[2/3] Installing OpenClaw") {
                        let _ = events_clone.emit(
                            "install-status",
                            InstallStatus {
                                step: "system".to_string(),
                                status: "installed".to_string(),
                                message: None,
                            },
                        );
                        current_phase = "openclaw";
                        let _ = events_clone.emit(
                            "install-status",
                            InstallStatus {
                                step: "openclaw".to_string(),
                                status: "installing".to_string(),
                                message: Some("Installing CLI...".to_string()),
                            },
                        );
                    } else if l.contains("[3/3] Finalizing setup") {
                        if current_phase == "openclaw" {
                            let _ = events_clone.emit(
                                "install-status",
                                InstallStatus {
                                    step: "openclaw".to_string(),
                                    status: "installed".to_string(),
                                    message: None,
                                },
                            );
                        }
                        current_phase = "doctor";
                        let _ = events_clone.emit(
                            "install-status",
                            InstallStatus {
                                step: "doctor".to_string(),
                                status: "installing".to_string(),
                                message: Some("Finalizing setup...".to_string()),
                            },
                        );
                    } else if lower.contains("openclaw installed successfully") {
                        let _ = events_clone.emit(
                            "install-status",
                            InstallStatus {
                                step: "doctor".to_string(),
                                status: "installed".to_string(),
                                message: None,
                            },
                        );
                    }
                }
            }
        });

        let output = child
            .wait_with_output()
            .map_err(crate::error::OpenClawError::from)?;
        if output.status.success() {
            // Final completion cleanup
            let _ = self.events.emit(
                "install-status",
                InstallStatus {
                    step: "system".to_string(),
                    status: "installed".to_string(),
                    message: None,
                },
            );
            let _ = self.events.emit(
                "install-status",
                InstallStatus {
                    step: "openclaw".to_string(),
                    status: "installed".to_string(),
                    message: None,
                },
            );
            let _ = self.events.emit(
                "install-status",
                InstallStatus {
                    step: "doctor".to_string(),
                    status: "installed".to_string(),
                    message: None,
                },
            );

            // Ensure PATH is in .bashrc
            let _ = self.provider.run_command(&[
                "-e", "bash", "-c",
                "grep -q \"npm-global/bin\" ~/.bashrc || echo 'export PATH=\"$HOME/.npm-global/bin:$PATH\"' >> ~/.bashrc",
            ], false);

            Ok(())
        } else {
            let err = String::from_utf8_lossy(&output.stderr).to_string();
            let _ = self.events.emit(
                "install-status",
                InstallStatus {
                    step: "openclaw".to_string(),
                    status: "failed".to_string(),
                    message: Some("Installation failed or aborted".to_string()),
                },
            );
            Err(crate::error::OpenClawError::Internal(format!(
                "Script failed: {}",
                err
            )))
        }
    }
}
