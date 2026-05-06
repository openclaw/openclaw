use gtk4::{self, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;
use tracing::{debug, warn};

use crate::state::SharedClient;
use crate::widgets::status_placeholder;

pub struct SkillsView {
    container: gtk4::Box,
}

impl SkillsView {
    pub fn new(client: SharedClient) -> Self {
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
            .title("Installed Skills")
            .description("Agent skills and capabilities")
            .build();

        content.append(&group);

        let clamp = adw::Clamp::builder()
            .maximum_size(700)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));

        let loading = status_placeholder::loading("Loading skills...");
        container.append(&loading);

        let c = client;
        let container_ref = container.clone();
        let scroll_ref = scroll.clone();
        let mut loaded = false;
        gtk4::glib::timeout_add_local(std::time::Duration::from_secs(2), move || {
            if !loaded
                && let Some(gw) = c.lock().unwrap().clone()
            {
                loaded = true;
                let cr = container_ref.clone();
                let sr = scroll_ref.clone();
                let group2 = group.clone();
                let client_inner = gw.clone();
                gtk4::glib::spawn_future_local(async move {
                    match client_inner
                        .request("skills.status", serde_json::json!({}))
                        .await
                    {
                        Ok(payload) => {
                            let skills = payload
                                .get("skills")
                                .and_then(|s| s.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if skills.is_empty() {
                                let empty = status_placeholder::empty(
                                    "applications-system-symbolic",
                                    "No skills installed",
                                    Some("Skills are loaded from the agent's skills directory"),
                                );
                                status_placeholder::swap_child(&cr, &empty);
                                return;
                            }
                            for skill in &skills {
                                let skill_id = skill
                                    .get("id")
                                    .or_else(|| skill.get("skillId"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown")
                                    .to_string();
                                let name = skill
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unnamed");
                                let status = skill
                                    .get("status")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("unknown");
                                let enabled = skill
                                    .get("enabled")
                                    .and_then(|v| v.as_bool())
                                    .unwrap_or(true);
                                let installed = status != "not-installed";

                                if installed {
                                    // Installed skill: show a switch row for enable/disable
                                    let row = adw::SwitchRow::builder()
                                        .title(name)
                                        .subtitle(format!("{skill_id} - {status}"))
                                        .active(enabled)
                                        .build();

                                    let gw_toggle = gw.clone();
                                    let sid = skill_id.clone();
                                    row.connect_active_notify(move |switch| {
                                        let new_enabled = switch.is_active();
                                        let gw2 = gw_toggle.clone();
                                        let sid2 = sid.clone();
                                        debug!(
                                            "skills.enable: {sid2} -> enabled={new_enabled}"
                                        );
                                        gtk4::glib::spawn_future_local(async move {
                                            let params = serde_json::json!({
                                                "skillId": sid2,
                                                "enabled": new_enabled,
                                            });
                                            match gw2.request("skills.update", params).await {
                                                Ok(_) => {
                                                    debug!("skills.enable ok for {sid2}");
                                                }
                                                Err(e) => {
                                                    warn!("skills.enable failed: {e}");
                                                }
                                            }
                                        });
                                    });
                                    group2.add(&row);
                                } else {
                                    // Not installed: show an action row with install button
                                    let row = adw::ActionRow::builder()
                                        .title(name)
                                        .subtitle(format!("{skill_id} - not installed"))
                                        .build();

                                    let install_btn = gtk4::Button::builder()
                                        .label("Install")
                                        .css_classes(vec!["suggested-action".to_string()])
                                        .valign(gtk4::Align::Center)
                                        .build();

                                    let gw_install = gw.clone();
                                    let sid = skill_id.clone();
                                    install_btn.connect_clicked(move |btn| {
                                        btn.set_sensitive(false);
                                        btn.set_label("Installing...");
                                        let gw2 = gw_install.clone();
                                        let sid2 = sid.clone();
                                        let btn2 = btn.clone();
                                        gtk4::glib::spawn_future_local(async move {
                                            let params = serde_json::json!({
                                                "skillId": sid2,
                                            });
                                            match gw2.request("skills.install", params).await {
                                                Ok(_) => {
                                                    debug!("skills.install ok for {sid2}");
                                                    btn2.set_label("Installed");
                                                }
                                                Err(e) => {
                                                    warn!("skills.install failed: {e}");
                                                    btn2.set_label("Failed");
                                                    btn2.set_sensitive(true);
                                                }
                                            }
                                        });
                                    });

                                    row.add_suffix(&install_btn);
                                    group2.add(&row);
                                }
                            }
                            status_placeholder::swap_child(&cr, &sr);
                        }
                        Err(e) => {
                            let err = status_placeholder::error(
                                "Failed to load skills",
                                Some(&format!("{e}")),
                            );
                            status_placeholder::swap_child(&cr, &err);
                        }
                    }
                });
            }
            gtk4::glib::ControlFlow::Continue
        });

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
