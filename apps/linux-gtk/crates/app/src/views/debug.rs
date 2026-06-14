use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::{AppState, SharedClient};

pub struct DebugView {
    container: gtk4::Box,
}

impl DebugView {
    pub fn new(state: AppState, client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        let scroll = gtk4::ScrolledWindow::builder()
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .build();

        let content = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(24)
            .margin_start(32)
            .margin_end(32)
            .margin_top(24)
            .margin_bottom(24)
            .build();

        // Quick actions
        let actions_group = adw::PreferencesGroup::builder()
            .title("Quick Actions")
            .description("Debug and diagnostic tools")
            .build();

        let health_btn = Self::action_row("Run Health Check", "Check gateway health status");
        let probe_btn = Self::action_row("Probe Channels", "Test all channel connections");
        let status_btn = Self::action_row("Full Status", "Get comprehensive status dump");

        actions_group.add(&health_btn);
        actions_group.add(&probe_btn);
        actions_group.add(&status_btn);
        content.append(&actions_group);

        // Result display
        let result_text = gtk4::TextView::builder()
            .editable(false)
            .monospace(true)
            .wrap_mode(gtk4::WrapMode::WordChar)
            .left_margin(12)
            .right_margin(12)
            .top_margin(8)
            .bottom_margin(8)
            .build();

        let result_scroll = gtk4::ScrolledWindow::builder()
            .child(&result_text)
            .min_content_height(200)
            .max_content_height(400)
            .propagate_natural_height(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .css_classes(vec!["card".to_string()])
            .build();
        content.append(&result_scroll);

        // App info
        let info_group = adw::PreferencesGroup::builder()
            .title("App Info")
            .build();

        let version_row = adw::ActionRow::builder()
            .title("App Version")
            .subtitle(env!("CARGO_PKG_VERSION"))
            .build();
        info_group.add(&version_row);

        let gw_row = adw::ActionRow::builder()
            .title("Gateway Version")
            .subtitle("--")
            .build();
        info_group.add(&gw_row);

        let mem_row = adw::ActionRow::builder()
            .title("Memory (RSS)")
            .subtitle("--")
            .build();
        info_group.add(&mem_row);

        content.append(&info_group);

        let clamp = adw::Clamp::builder()
            .maximum_size(700)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));
        container.append(&scroll);

        // Wire health button
        let c1 = client.clone();
        let rt = result_text.clone();
        health_btn.set_activatable(true);
        health_btn.connect_activated(move |_| {
            Self::run_rpc(&c1, "health", serde_json::json!({"probe": true}), &rt);
        });

        // Probe channels
        let c2 = client.clone();
        let rt2 = result_text.clone();
        probe_btn.set_activatable(true);
        probe_btn.connect_activated(move |_| {
            Self::run_rpc(
                &c2,
                "channels.status",
                serde_json::json!({"probe": true}),
                &rt2,
            );
        });

        // Full status
        let c3 = client;
        let rt3 = result_text;
        status_btn.set_activatable(true);
        status_btn.connect_activated(move |_| {
            Self::run_rpc(&c3, "status", serde_json::json!({}), &rt3);
        });

        // Poll gateway version + memory
        let s = state;
        let gr = gw_row;
        let mr = mem_row;
        glib::timeout_add_local(std::time::Duration::from_secs(2), move || {
            if s.is_connected() {
                gr.set_subtitle(&format!("v{}", s.server_version()));
            }
            // Read own RSS from /proc/self/status
            if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
                for line in status.lines() {
                    if line.starts_with("VmRSS:") {
                        let rss = line
                            .split_whitespace()
                            .nth(1)
                            .unwrap_or("?");
                        mr.set_subtitle(&format!("{rss} kB"));
                        break;
                    }
                }
            }
            glib::ControlFlow::Continue
        });

        Self { container }
    }

    fn action_row(title: &str, subtitle: &str) -> adw::ActionRow {
        let row = adw::ActionRow::builder()
            .title(title)
            .subtitle(subtitle)
            .build();
        row.add_suffix(
            &gtk4::Image::from_icon_name("go-next-symbolic"),
        );
        row
    }

    fn run_rpc(
        client: &SharedClient,
        method: &str,
        params: serde_json::Value,
        result_text: &gtk4::TextView,
    ) {
        if let Some(gw) = client.lock().unwrap().clone() {
            let rt = result_text.clone();
            let method = method.to_string();
            rt.buffer().set_text("Running...");
            glib::spawn_future_local(async move {
                match gw.request(&method, params).await {
                    Ok(val) => {
                        let pretty = serde_json::to_string_pretty(&val)
                            .unwrap_or_else(|_| val.to_string());
                        rt.buffer().set_text(&pretty);
                    }
                    Err(e) => {
                        rt.buffer().set_text(&format!("Error: {e}"));
                    }
                }
            });
        }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
