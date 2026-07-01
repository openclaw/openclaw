use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;
use tracing::{debug, warn};

use crate::state::SharedClient;
use crate::widgets::status_placeholder;

pub struct InstancesView {
    container: gtk4::Box,
}

impl InstancesView {
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

        // -- Pending pair requests section --
        let pair_group = adw::PreferencesGroup::builder()
            .title("Pending Pair Requests")
            .description("Nodes waiting to be paired with this gateway")
            .build();
        content.append(&pair_group);

        // -- Connected nodes section --
        let nodes_group = adw::PreferencesGroup::builder()
            .title("Connected Instances")
            .description("Gateway nodes and connected clients")
            .build();
        content.append(&nodes_group);

        // -- Copy debug info button --
        let debug_btn = gtk4::Button::builder()
            .label("Copy Debug Info")
            .css_classes(vec!["flat".to_string()])
            .halign(gtk4::Align::Start)
            .margin_top(8)
            .build();
        content.append(&debug_btn);

        let clamp = adw::Clamp::builder()
            .maximum_size(700)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));

        let loading = status_placeholder::loading("Loading instances...");
        container.append(&loading);

        let c = client;
        let container_ref = container.clone();
        let scroll_ref = scroll.clone();
        let mut loaded = false;
        glib::timeout_add_local(std::time::Duration::from_secs(2), move || {
            if !loaded
                && let Some(gw) = c.lock().unwrap().clone()
            {
                loaded = true;
                let cr = container_ref.clone();
                let sr = scroll_ref.clone();
                let pg = pair_group.clone();
                let ng = nodes_group.clone();
                let db = debug_btn.clone();
                let gw_outer = gw.clone();
                glib::spawn_future_local(async move {
                    // Fetch nodes and pair requests in parallel-ish (sequential
                    // for simplicity; both are fast RPCs).
                    let nodes_result = gw_outer
                        .request("node.list", serde_json::json!({}))
                        .await;
                    let pairs_result = gw_outer
                        .request("node.pair.list", serde_json::json!({}))
                        .await;

                    // -- Pair requests --
                    let mut debug_lines: Vec<String> = Vec::new();
                    match &pairs_result {
                        Ok(payload) => {
                            let requests = payload
                                .get("requests")
                                .and_then(|r| r.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if requests.is_empty() {
                                let row = adw::ActionRow::builder()
                                    .title("No pending requests")
                                    .subtitle("All pair requests have been handled")
                                    .build();
                                pg.add(&row);
                            } else {
                                for req in &requests {
                                    build_pair_request_row(&pg, req, &gw_outer);
                                }
                            }
                            debug_lines.push(format!(
                                "Pair requests: {}",
                                requests.len()
                            ));
                        }
                        Err(e) => {
                            let row = adw::ActionRow::builder()
                                .title("Failed to load pair requests")
                                .subtitle(format!("{e}"))
                                .build();
                            pg.add(&row);
                            debug_lines
                                .push(format!("Pair requests error: {e}"));
                        }
                    }

                    // -- Nodes --
                    match &nodes_result {
                        Ok(payload) => {
                            let nodes = payload
                                .get("nodes")
                                .and_then(|n| n.as_array())
                                .cloned()
                                .unwrap_or_default();
                            if nodes.is_empty() {
                                let row = adw::ActionRow::builder()
                                    .title("No remote nodes")
                                    .subtitle("This is a standalone gateway instance")
                                    .build();
                                ng.add(&row);
                            } else {
                                for node in &nodes {
                                    let id = node
                                        .get("id")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("?");
                                    let name = node
                                        .get("name")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or(id);
                                    let status = node
                                        .get("status")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("unknown");
                                    let last_seen = node
                                        .get("lastSeen")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("--");

                                    let row = adw::ActionRow::builder()
                                        .title(name)
                                        .subtitle(format!(
                                            "{id} | Last seen: {last_seen}"
                                        ))
                                        .build();

                                    let chip_class = if status == "online" {
                                        "chip-ok"
                                    } else {
                                        "chip-error"
                                    };
                                    let chip = gtk4::Label::builder()
                                        .label(status)
                                        .css_classes(vec![
                                            "status-chip".to_string(),
                                            chip_class.to_string(),
                                        ])
                                        .valign(gtk4::Align::Center)
                                        .build();
                                    row.add_suffix(&chip);
                                    ng.add(&row);

                                    debug_lines.push(format!(
                                        "Node: {name} ({id}) status={status} last_seen={last_seen}"
                                    ));
                                }
                            }
                            debug_lines.push(format!(
                                "Total nodes: {}",
                                nodes.len()
                            ));
                        }
                        Err(e) => {
                            let row = adw::ActionRow::builder()
                                .title("Failed to load nodes")
                                .subtitle(format!("{e}"))
                                .build();
                            ng.add(&row);
                            debug_lines.push(format!("Nodes error: {e}"));
                        }
                    }

                    // Wire debug copy button
                    let debug_text = debug_lines.join("\n");
                    db.connect_clicked(move |btn| {
                        if let Some(display) = gtk4::gdk::Display::default() {
                            let clipboard = display.clipboard();
                            clipboard.set_text(&debug_text);
                            btn.set_label("Copied!");
                            let btn2 = btn.clone();
                            glib::timeout_add_local_once(
                                std::time::Duration::from_secs(2),
                                move || {
                                    btn2.set_label("Copy Debug Info");
                                },
                            );
                        }
                    });

                    status_placeholder::swap_child(&cr, &sr);
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

/// Build a row for a pending pair request with Approve/Reject buttons.
fn build_pair_request_row(
    group: &adw::PreferencesGroup,
    request: &serde_json::Value,
    gw: &std::sync::Arc<openclaw_gateway_client::GatewayClient>,
) {
    let request_id = request
        .get("requestId")
        .or_else(|| request.get("id"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let name = request
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown device");
    let device_type = request
        .get("deviceType")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    let subtitle = if device_type.is_empty() {
        request_id.clone()
    } else {
        format!("{request_id} ({device_type})")
    };

    let row = adw::ActionRow::builder()
        .title(name)
        .subtitle(&subtitle)
        .build();

    let btn_box = gtk4::Box::builder()
        .orientation(Orientation::Horizontal)
        .spacing(4)
        .valign(gtk4::Align::Center)
        .build();

    // Approve button
    let approve_btn = gtk4::Button::builder()
        .icon_name("emblem-ok-symbolic")
        .css_classes(vec!["flat".to_string(), "success".to_string()])
        .tooltip_text("Approve")
        .build();

    let gw_approve = gw.clone();
    let rid_approve = request_id.clone();
    let row_approve = row.clone();
    let group_approve = group.clone();
    approve_btn.connect_clicked(move |btn| {
        btn.set_sensitive(false);
        let gw2 = gw_approve.clone();
        let rid = rid_approve.clone();
        let r = row_approve.clone();
        let g = group_approve.clone();
        glib::spawn_future_local(async move {
            let params = serde_json::json!({ "requestId": rid });
            match gw2.request("node.pair.approve", params).await {
                Ok(_) => {
                    debug!("nodes.pair.approve ok for {rid}");
                    g.remove(&r);
                }
                Err(e) => {
                    warn!("nodes.pair.approve failed: {e}");
                }
            }
        });
    });

    // Reject button
    let reject_btn = gtk4::Button::builder()
        .icon_name("window-close-symbolic")
        .css_classes(vec!["flat".to_string(), "error".to_string()])
        .tooltip_text("Reject")
        .build();

    let gw_reject = gw.clone();
    let rid_reject = request_id.clone();
    let row_reject = row.clone();
    let group_reject = group.clone();
    reject_btn.connect_clicked(move |btn| {
        btn.set_sensitive(false);
        let gw2 = gw_reject.clone();
        let rid = rid_reject.clone();
        let r = row_reject.clone();
        let g = group_reject.clone();
        glib::spawn_future_local(async move {
            let params = serde_json::json!({ "requestId": rid });
            match gw2.request("node.pair.reject", params).await {
                Ok(_) => {
                    debug!("nodes.pair.reject ok for {rid}");
                    g.remove(&r);
                }
                Err(e) => {
                    warn!("nodes.pair.reject failed: {e}");
                }
            }
        });
    });

    btn_box.append(&approve_btn);
    btn_box.append(&reject_btn);
    row.add_suffix(&btn_box);
    group.add(&row);
}
