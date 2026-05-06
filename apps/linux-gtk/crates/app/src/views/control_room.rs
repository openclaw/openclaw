use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::bridge::EventBridge;
use crate::state::{AppState, SharedClient};

pub struct ControlRoomView {
    container: gtk4::Box,
}

impl ControlRoomView {
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

        // --- Gateway section ---
        let gateway_group = adw::PreferencesGroup::builder()
            .title("Gateway")
            .build();

        let health_row = adw::ActionRow::builder()
            .title("Health Status")
            .subtitle("Checking...")
            .build();
        let health_icon = gtk4::Image::from_icon_name("network-offline-symbolic");
        health_row.add_prefix(&health_icon);

        let restart_btn = gtk4::Button::builder()
            .label("Restart")
            .valign(gtk4::Align::Center)
            .css_classes(vec!["destructive-action".to_string()])
            .build();
        health_row.add_suffix(&restart_btn);

        gateway_group.add(&health_row);
        content.append(&gateway_group);

        // Wire restart button
        let c_restart = client.clone();
        let health_row_ref = health_row.clone();
        restart_btn.connect_clicked(move |btn| {
            btn.set_sensitive(false);
            health_row_ref.set_subtitle("Restarting...");
            let c = c_restart.clone();
            let hr = health_row_ref.clone();
            let btn2 = btn.clone();
            glib::spawn_future_local(async move {
                let result = Self::rpc(&c, "gateway.restart", serde_json::json!({})).await;
                match result {
                    Ok(_) => hr.set_subtitle("Restart requested"),
                    Err(e) => hr.set_subtitle(&format!("Restart failed: {e}")),
                }
                btn2.set_sensitive(true);
            });
        });

        // --- Quick Actions section ---
        let actions_group = adw::PreferencesGroup::builder()
            .title("Quick Actions")
            .build();

        // Refresh Snapshot
        let refresh_row = adw::ActionRow::builder()
            .title("Refresh Snapshot")
            .subtitle("Re-fetch agents, sessions, channels, and models")
            .activatable(true)
            .build();
        refresh_row.add_suffix(&gtk4::Image::from_icon_name("view-refresh-symbolic"));
        actions_group.add(&refresh_row);

        let s_refresh = state.clone();
        let c_refresh = client.clone();
        refresh_row.connect_activated(move |row| {
            row.set_subtitle("Refreshing...");
            EventBridge::refresh_snapshot(s_refresh.clone(), c_refresh.clone());
            let row2 = row.clone();
            // Brief delay so the user sees feedback before resetting subtitle
            glib::timeout_add_local_once(std::time::Duration::from_secs(1), move || {
                row2.set_subtitle("Re-fetch agents, sessions, channels, and models");
            });
        });

        // Run Cron Now
        let cron_row = adw::ActionRow::builder()
            .title("Run Cron Now")
            .subtitle("Execute a scheduled job by ID")
            .build();
        let cron_entry = gtk4::Entry::builder()
            .placeholder_text("Job ID")
            .valign(gtk4::Align::Center)
            .width_chars(16)
            .build();
        let cron_btn = gtk4::Button::builder()
            .label("Run")
            .valign(gtk4::Align::Center)
            .css_classes(vec!["suggested-action".to_string()])
            .build();
        cron_row.add_suffix(&cron_entry);
        cron_row.add_suffix(&cron_btn);
        actions_group.add(&cron_row);

        let c_cron = client.clone();
        let cron_entry_ref = cron_entry.clone();
        let cron_row_ref = cron_row.clone();
        cron_btn.connect_clicked(move |btn| {
            let job_id = cron_entry_ref.text().to_string();
            if job_id.is_empty() {
                cron_row_ref.set_subtitle("Enter a job ID first");
                return;
            }
            btn.set_sensitive(false);
            cron_row_ref.set_subtitle(&format!("Running {job_id}..."));
            let c = c_cron.clone();
            let cr = cron_row_ref.clone();
            let btn2 = btn.clone();
            glib::spawn_future_local(async move {
                let result =
                    Self::rpc(&c, "cron.run", serde_json::json!({ "jobId": job_id })).await;
                match result {
                    Ok(_) => cr.set_subtitle(&format!("{job_id}: OK")),
                    Err(e) => cr.set_subtitle(&format!("{job_id}: {e}")),
                }
                btn2.set_sensitive(true);
            });
        });

        // Abort Active Run
        let abort_row = adw::ActionRow::builder()
            .title("Abort Active Run")
            .subtitle("Cancel a running agent session")
            .build();
        let abort_entry = gtk4::Entry::builder()
            .placeholder_text("Session key")
            .valign(gtk4::Align::Center)
            .width_chars(16)
            .build();
        let abort_btn = gtk4::Button::builder()
            .label("Abort")
            .valign(gtk4::Align::Center)
            .css_classes(vec!["destructive-action".to_string()])
            .build();
        abort_row.add_suffix(&abort_entry);
        abort_row.add_suffix(&abort_btn);
        actions_group.add(&abort_row);

        let c_abort = client.clone();
        let abort_entry_ref = abort_entry.clone();
        let abort_row_ref = abort_row.clone();
        abort_btn.connect_clicked(move |btn| {
            let session_key = abort_entry_ref.text().to_string();
            if session_key.is_empty() {
                abort_row_ref.set_subtitle("Enter a session key first");
                return;
            }
            btn.set_sensitive(false);
            abort_row_ref.set_subtitle(&format!("Aborting {session_key}..."));
            let c = c_abort.clone();
            let ar = abort_row_ref.clone();
            let btn2 = btn.clone();
            glib::spawn_future_local(async move {
                let result = Self::rpc(
                    &c,
                    "chat.abort",
                    serde_json::json!({ "sessionKey": session_key }),
                )
                .await;
                match result {
                    Ok(_) => ar.set_subtitle(&format!("{session_key}: aborted")),
                    Err(e) => ar.set_subtitle(&format!("{session_key}: {e}")),
                }
                btn2.set_sensitive(true);
            });
        });

        content.append(&actions_group);

        // --- System Info section ---
        let info_group = adw::PreferencesGroup::builder()
            .title("System Info")
            .build();

        let version_row = adw::ActionRow::builder()
            .title("Server Version")
            .subtitle("...")
            .build();
        let agents_row = adw::ActionRow::builder()
            .title("Connected Agents")
            .subtitle("0")
            .build();
        let sessions_row = adw::ActionRow::builder()
            .title("Active Sessions")
            .subtitle("0")
            .build();

        info_group.add(&version_row);
        info_group.add(&agents_row);
        info_group.add(&sessions_row);
        content.append(&info_group);

        let clamp = adw::Clamp::builder()
            .maximum_size(800)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));
        container.append(&scroll);

        // Poll state for health and system info
        let s = state;
        let hi = health_icon;
        let hr = health_row;
        let vr = version_row;
        let ar = agents_row;
        let sr = sessions_row;
        glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            if s.is_connected() {
                hi.set_icon_name(Some("network-idle-symbolic"));
                hr.set_subtitle("Connected");
                vr.set_subtitle(&format!("v{}", s.server_version()));
                ar.set_subtitle(&format!("{}", s.agents().len()));
                sr.set_subtitle(&format!("{}", s.sessions().len()));
            } else {
                hi.set_icon_name(Some("network-offline-symbolic"));
                hr.set_subtitle("Offline");
                vr.set_subtitle("...");
                ar.set_subtitle("0");
                sr.set_subtitle("0");
            }
            glib::ControlFlow::Continue
        });

        Self { container }
    }

    /// Send an RPC request and return the result payload or error string.
    async fn rpc(
        client: &SharedClient,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let gw = client
            .lock()
            .map_err(|e| format!("lock error: {e}"))?
            .clone()
            .ok_or_else(|| "not connected".to_string())?;
        gw.request(method, params)
            .await
            .map_err(|e| format!("{e}"))
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
