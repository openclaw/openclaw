use ksni::{self, TrayMethods};

pub fn start_tray() {
    std::thread::spawn(|| {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tray tokio runtime");

        rt.block_on(async {
            let tray = OpenClawTray { connected: false };
            match tray.spawn().await {
                Ok(handle) => {
                    // Keep handle alive — the tray runs until shutdown
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        handle.update(|_| {}).await;
                    }
                }
                Err(e) => {
                    // Expected on tiling WMs (bspwm, i3, sway) and minimal
                    // desktops without a tray daemon. Demoted to debug so
                    // the warning doesn't clutter normal startup logs.
                    tracing::debug!("system tray unavailable: {e}");
                }
            }
        });
    });
}

#[derive(Clone)]
struct OpenClawTray {
    connected: bool,
}

impl ksni::Tray for OpenClawTray {
    fn id(&self) -> String {
        "openclaw-desktop".to_string()
    }

    fn title(&self) -> String {
        "OpenClaw".to_string()
    }

    fn icon_name(&self) -> String {
        if self.connected {
            "network-transmit-symbolic".to_string()
        } else {
            "network-offline-symbolic".to_string()
        }
    }

    fn category(&self) -> ksni::Category {
        ksni::Category::ApplicationStatus
    }

    fn menu(&self) -> Vec<ksni::MenuItem<Self>> {
        use ksni::menu::*;

        let status_text = if self.connected {
            "Connected"
        } else {
            "Disconnected"
        };

        vec![
            StandardItem {
                label: format!("OpenClaw — {status_text}"),
                enabled: false,
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Show Window".to_string(),
                icon_name: "window-new-symbolic".to_string(),
                activate: Box::new(|_| {
                    let _ = std::process::Command::new("gdbus")
                        .args([
                            "call",
                            "--session",
                            "--dest",
                            "ai.openclaw.desktop",
                            "--object-path",
                            "/ai/openclaw/desktop",
                            "--method",
                            "org.gtk.Application.Activate",
                            "[]",
                        ])
                        .spawn();
                }),
                ..Default::default()
            }
            .into(),
            MenuItem::Separator,
            StandardItem {
                label: "Quit".to_string(),
                icon_name: "application-exit-symbolic".to_string(),
                activate: Box::new(|_| {
                    std::process::exit(0);
                }),
                ..Default::default()
            }
            .into(),
        ]
    }
}
