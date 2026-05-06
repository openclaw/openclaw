use gtk4::{self, glib, Orientation};
use gtk4::prelude::*;
use libadwaita as adw;
use libadwaita::prelude::*;
use tracing::{debug, warn};

use crate::state::{AppState, SharedClient};
use crate::widgets::status_placeholder;

pub struct ChannelsView {
    container: gtk4::Box,
}

impl ChannelsView {
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
            .spacing(16)
            .margin_start(32)
            .margin_end(32)
            .margin_top(24)
            .margin_bottom(24)
            .build();

        let group = adw::PreferencesGroup::builder()
            .title("Messaging Channels")
            .description("Connected messaging platforms")
            .build();

        content.append(&group);

        let clamp = adw::Clamp::builder()
            .maximum_size(700)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));

        // Initial loading state (swapped out once the snapshot arrives).
        let loading = status_placeholder::loading("Loading channels...");
        container.append(&loading);

        let s = state;
        let container_ref = container.clone();
        let scroll_ref = scroll.clone();
        let mut populated = false;
        glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            if !populated && s.is_connected() {
                let channels = s.channels();
                if channels.is_empty() {
                    let empty = status_placeholder::empty(
                        "network-transmit-symbolic",
                        "No channels configured",
                        Some("Add Telegram, WhatsApp, or Discord channels in the gateway config"),
                    );
                    status_placeholder::swap_child(&container_ref, &empty);
                } else {
                    for ch in &channels {
                        let name = ch
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let channel_id = ch
                            .get("id")
                            .and_then(|v| v.as_str())
                            .or_else(|| ch.get("channelId").and_then(|v| v.as_str()))
                            .unwrap_or(&name)
                            .to_string();
                        let status = ch
                            .get("status")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();

                        let row = adw::ActionRow::builder()
                            .title(&name)
                            .subtitle(&format!("Status: {status}"))
                            .build();

                        // Status chip.
                        let chip_class = if status == "connected" {
                            "chip-ok"
                        } else {
                            "chip-error"
                        };
                        let chip = gtk4::Label::builder()
                            .label(&status)
                            .css_classes(vec![
                                "status-chip".to_string(),
                                chip_class.to_string(),
                            ])
                            .valign(gtk4::Align::Center)
                            .build();
                        row.add_suffix(&chip);

                        // Probe button.
                        let probe_btn = gtk4::Button::builder()
                            .label("Probe")
                            .css_classes(vec!["flat".to_string()])
                            .valign(gtk4::Align::Center)
                            .build();
                        {
                            let client = client.clone();
                            let channel_id = channel_id.clone();
                            let chip = chip.clone();
                            probe_btn.connect_clicked(move |btn| {
                                let Some(gw) = client.lock().unwrap().clone() else {
                                    return;
                                };
                                btn.set_sensitive(false);
                                let btn2 = btn.clone();
                                let channel_id = channel_id.clone();
                                let chip = chip.clone();
                                glib::spawn_future_local(async move {
                                    let params =
                                        serde_json::json!({ "channelId": channel_id });
                                    match gw.request("channels.status", params).await {
                                        Ok(result) => {
                                            debug!("channels.probe ok for {channel_id}");
                                            let new_status = result
                                                .get("status")
                                                .and_then(|v| v.as_str())
                                                .unwrap_or("probed");
                                            chip.set_label(new_status);
                                            chip.remove_css_class("chip-error");
                                            chip.remove_css_class("chip-ok");
                                            if new_status == "connected" {
                                                chip.add_css_class("chip-ok");
                                            } else {
                                                chip.add_css_class("chip-error");
                                            }
                                        }
                                        Err(e) => {
                                            warn!("channels.probe: {e}");
                                            chip.set_label("error");
                                            chip.remove_css_class("chip-ok");
                                            chip.add_css_class("chip-error");
                                        }
                                    }
                                    btn2.set_sensitive(true);
                                });
                            });
                        }
                        row.add_suffix(&probe_btn);

                        // Logout button with confirmation.
                        let logout_btn = gtk4::Button::builder()
                            .label("Logout")
                            .css_classes(vec!["destructive-action".to_string()])
                            .valign(gtk4::Align::Center)
                            .build();
                        {
                            let client = client.clone();
                            let channel_id = channel_id.clone();
                            let name = name.clone();
                            logout_btn.connect_clicked(move |btn| {
                                let Some(gw) = client.lock().unwrap().clone() else {
                                    return;
                                };
                                let channel_id = channel_id.clone();
                                let btn2 = btn.clone();
                                let dialog = adw::AlertDialog::builder()
                                    .heading("Logout Channel?")
                                    .body(format!(
                                        "Disconnect the \"{name}\" channel? You will need to re-authenticate to reconnect."
                                    ))
                                    .build();
                                dialog.add_responses(&[
                                    ("cancel", "Cancel"),
                                    ("logout", "Logout"),
                                ]);
                                dialog.set_response_appearance(
                                    "logout",
                                    adw::ResponseAppearance::Destructive,
                                );
                                dialog.set_default_response(Some("cancel"));
                                let root = btn2.root().and_downcast::<gtk4::Window>();
                                dialog.connect_response(None, move |_, response| {
                                    if response != "logout" {
                                        return;
                                    }
                                    let gw = gw.clone();
                                    let channel_id = channel_id.clone();
                                    glib::spawn_future_local(async move {
                                        let params = serde_json::json!({
                                            "channelId": channel_id,
                                        });
                                        match gw
                                            .request("channels.logout", params)
                                            .await
                                        {
                                            Ok(_) => {
                                                debug!(
                                                    "channels.logout ok for {channel_id}"
                                                );
                                            }
                                            Err(e) => {
                                                warn!("channels.logout: {e}");
                                            }
                                        }
                                    });
                                });
                                dialog.present(root.as_ref());
                            });
                        }
                        row.add_suffix(&logout_btn);

                        group.add(&row);
                    }
                    status_placeholder::swap_child(&container_ref, &scroll_ref);
                }
                populated = true;
            }
            glib::ControlFlow::Continue
        });

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
