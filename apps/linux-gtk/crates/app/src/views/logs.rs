use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::SharedClient;

pub struct LogsView {
    container: gtk4::Box,
}

impl LogsView {
    pub fn new(client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        // Level filter chips
        let filter_bar = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(16)
            .margin_end(16)
            .margin_top(8)
            .margin_bottom(4)
            .build();

        let levels = ["info", "warn", "error", "debug"];
        let chips: Vec<gtk4::ToggleButton> = levels
            .iter()
            .map(|level| {
                let btn = gtk4::ToggleButton::builder()
                    .label(*level)
                    .css_classes(vec!["flat".to_string(), "caption".to_string()])
                    .active(matches!(*level, "info" | "warn" | "error"))
                    .build();
                filter_bar.append(&btn);
                btn
            })
            .collect();

        let refresh_btn = gtk4::Button::builder()
            .icon_name("view-refresh-symbolic")
            .css_classes(vec!["flat".to_string()])
            .tooltip_text("Refresh logs")
            .build();
        filter_bar.append(&gtk4::Box::builder().hexpand(true).build()); // spacer
        filter_bar.append(&refresh_btn);

        container.append(&filter_bar);
        container.append(&gtk4::Separator::new(Orientation::Horizontal));

        // Log output
        let log_text = gtk4::TextView::builder()
            .editable(false)
            .monospace(true)
            .wrap_mode(gtk4::WrapMode::WordChar)
            .left_margin(12)
            .right_margin(12)
            .top_margin(8)
            .bottom_margin(8)
            .vexpand(true)
            .build();

        let log_scroll = gtk4::ScrolledWindow::builder()
            .child(&log_text)
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .build();

        container.append(&log_scroll);

        // Debug RPC console
        container.append(&gtk4::Separator::new(Orientation::Horizontal));

        let rpc_bar = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(16)
            .margin_end(16)
            .margin_top(8)
            .margin_bottom(8)
            .build();

        let method_entry = adw::EntryRow::builder()
            .title("RPC Method")
            .text("health")
            .build();

        let params_entry = adw::EntryRow::builder()
            .title("Params (JSON)")
            .text("{}")
            .build();

        let send_btn = gtk4::Button::builder()
            .label("Send")
            .css_classes(vec!["suggested-action".to_string(), "pill".to_string()])
            .valign(gtk4::Align::Center)
            .build();

        let rpc_form = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(4)
            .hexpand(true)
            .build();
        rpc_form.append(&method_entry);
        rpc_form.append(&params_entry);

        rpc_bar.append(&rpc_form);
        rpc_bar.append(&send_btn);
        container.append(&rpc_bar);

        let rpc_result = gtk4::Label::builder()
            .label("")
            .xalign(0.0)
            .wrap(true)
            .selectable(true)
            .css_classes(vec!["caption".to_string(), "monospace".to_string()])
            .margin_start(16)
            .margin_end(16)
            .margin_bottom(8)
            .visible(false)
            .build();
        container.append(&rpc_result);

        // Load logs function
        let load_logs = {
            let client = client.clone();
            let log_text = log_text.clone();
            let chips = chips.clone();
            let log_scroll = log_scroll.clone();
            move || {
                if let Some(gw) = client.lock().unwrap().clone() {
                    let lt = log_text.clone();
                    let cs = chips.clone();
                    let ls = log_scroll.clone();
                    glib::spawn_future_local(async move {
                        match gw
                            .request("logs.tail", serde_json::json!({ "limit": 200 }))
                            .await
                        {
                            Ok(payload) => {
                                let active_levels: Vec<String> = cs
                                    .iter()
                                    .filter(|c| c.is_active())
                                    .map(|c| c.label().unwrap_or_default().to_string())
                                    .collect();

                                if let Some(lines) =
                                    payload.get("lines").and_then(|l| l.as_array())
                                {
                                    let filtered: Vec<String> = lines
                                        .iter()
                                        .filter_map(|l| l.as_str())
                                        .filter(|line| {
                                            active_levels.iter().any(|level| {
                                                line.to_lowercase().contains(level)
                                            }) || active_levels.contains(&"debug".to_string())
                                        })
                                        .map(|s| s.to_string())
                                        .collect();

                                    let text = if filtered.is_empty() {
                                        lines
                                            .iter()
                                            .filter_map(|l| l.as_str())
                                            .collect::<Vec<_>>()
                                            .join("\n")
                                    } else {
                                        filtered.join("\n")
                                    };
                                    lt.buffer().set_text(&text);

                                    // Auto-scroll to bottom
                                    let adj = ls.vadjustment();
                                    glib::idle_add_local_once(move || {
                                        adj.set_value(adj.upper());
                                    });
                                }
                            }
                            Err(e) => {
                                lt.buffer()
                                    .set_text(&format!("Failed to load logs: {e}"));
                            }
                        }
                    });
                }
            }
        };

        // Initial load
        let load = load_logs.clone();
        glib::timeout_add_local_once(std::time::Duration::from_secs(1), move || {
            load();
        });

        // Refresh button
        let load2 = load_logs.clone();
        refresh_btn.connect_clicked(move |_| {
            load2();
        });

        // Auto-refresh every 5s
        let load3 = load_logs;
        glib::timeout_add_local(std::time::Duration::from_secs(5), move || {
            load3();
            glib::ControlFlow::Continue
        });

        // RPC send button
        let c2 = client;
        send_btn.connect_clicked(move |_| {
            let method = method_entry.text().to_string();
            let params_str = params_entry.text().to_string();
            let params: serde_json::Value =
                serde_json::from_str(&params_str).unwrap_or(serde_json::json!({}));
            let rr = rpc_result.clone();

            if let Some(gw) = c2.lock().unwrap().clone() {
                rr.set_label("Sending...");
                rr.set_visible(true);
                glib::spawn_future_local(async move {
                    match gw.request(&method, params).await {
                        Ok(val) => {
                            let pretty = serde_json::to_string_pretty(&val)
                                .unwrap_or_else(|_| val.to_string());
                            // Truncate for display
                            let display = if pretty.len() > 2000 {
                                format!("{}...(truncated)", &pretty[..2000])
                            } else {
                                pretty
                            };
                            rr.set_label(&display);
                        }
                        Err(e) => {
                            rr.set_label(&format!("Error: {e}"));
                        }
                    }
                });
            }
        });

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
