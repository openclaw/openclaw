use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::SharedClient;

pub struct WorkflowsView {
    container: gtk4::Box,
}

impl WorkflowsView {
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
            .title("Agent Bindings")
            .description("How agents are routed to messaging channels")
            .build();

        let list_box = gtk4::ListBox::builder()
            .selection_mode(gtk4::SelectionMode::None)
            .css_classes(vec!["boxed-list".to_string()])
            .build();

        content.append(&group);
        content.append(&list_box);

        let clamp = adw::Clamp::builder()
            .maximum_size(700)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));
        container.append(&scroll);

        // Load bindings from config
        let c = client;
        let lb = list_box;
        let mut loaded = false;
        glib::timeout_add_local(std::time::Duration::from_secs(2), move || {
            if !loaded
                && let Some(gw) = c.lock().unwrap().clone() {
                    loaded = true;
                    let lb2 = lb.clone();
                    glib::spawn_future_local(async move {
                        match gw.request("config.get", serde_json::json!({})).await {
                            Ok(payload) => {
                                let bindings = payload
                                    .get("config")
                                    .and_then(|c| c.get("bindings"))
                                    .and_then(|b| b.as_array());

                                if let Some(bindings) = bindings {
                                    for binding in bindings {
                                        let agent = binding
                                            .get("agentId")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("?");
                                        let channel = binding
                                            .get("match")
                                            .and_then(|m| m.get("channel"))
                                            .and_then(|c| c.as_str())
                                            .unwrap_or("?");
                                        let peer = binding
                                            .get("match")
                                            .and_then(|m| m.get("peer"))
                                            .map(|p| {
                                                let kind = p
                                                    .get("kind")
                                                    .and_then(|k| k.as_str())
                                                    .unwrap_or("any");
                                                let id = p
                                                    .get("id")
                                                    .and_then(|i| i.as_str())
                                                    .unwrap_or("*");
                                                format!("{kind}:{id}")
                                            })
                                            .unwrap_or_else(|| "any".to_string());

                                        let row = adw::ActionRow::builder()
                                            .title(format!("{agent} -> {channel}"))
                                            .subtitle(format!("Peer: {peer}"))
                                            .build();

                                        let chip = gtk4::Label::builder()
                                            .label(channel)
                                            .css_classes(vec!["status-chip".to_string()])
                                            .valign(gtk4::Align::Center)
                                            .build();
                                        row.add_suffix(&chip);
                                        lb2.append(&row);
                                    }
                                }

                                if lb2.first_child().is_none() {
                                    let row = adw::ActionRow::builder()
                                        .title("No bindings configured")
                                        .subtitle(
                                            "Add bindings in config to route agents to channels",
                                        )
                                        .build();
                                    lb2.append(&row);
                                }
                            }
                            Err(e) => {
                                let row = adw::ActionRow::builder()
                                    .title("Failed to load bindings")
                                    .subtitle(format!("{e}"))
                                    .build();
                                lb2.append(&row);
                            }
                        }
                    });
                }
            glib::ControlFlow::Continue
        });

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
