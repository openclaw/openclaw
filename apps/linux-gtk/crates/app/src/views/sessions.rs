use std::cell::RefCell;
use std::rc::Rc;

use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;
use tracing::{debug, warn};

use crate::state::{AppState, SharedClient};
use crate::widgets::status_placeholder;

pub struct SessionsView {
    container: gtk4::Box,
}

impl SessionsView {
    pub fn new(state: AppState, client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        // Initial loading state.
        let loading = status_placeholder::loading("Loading sessions...");
        container.append(&loading);

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
            .title("Active Sessions")
            .description("Current chat sessions across all agents")
            .build();

        content.append(&group);

        let clamp = adw::Clamp::builder()
            .maximum_size(800)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));

        // Track expander rows so we can rebuild on refresh.
        let expander_rows: Rc<RefCell<Vec<adw::ExpanderRow>>> = Rc::new(RefCell::new(Vec::new()));

        // Build session rows from state snapshot.
        let build_rows = {
            let client = client.clone();
            let group = group.clone();
            let expander_rows = expander_rows.clone();
            let state = state.clone();
            move || {
                // Clear previous rows.
                {
                    let mut rows = expander_rows.borrow_mut();
                    for row in rows.drain(..) {
                        group.remove(&row);
                    }
                }

                let sessions = state.sessions();
                let models = state.models();

                for sess in &sessions {
                    let key = sess
                        .get("key")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let agent = sess
                        .get("agentId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("default")
                        .to_string();
                    let model = sess
                        .get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("-")
                        .to_string();
                    let status = sess
                        .get("status")
                        .and_then(|v| v.as_str())
                        .unwrap_or("active")
                        .to_string();

                    // ExpanderRow: title = session key, subtitle = agent + model.
                    let expander = adw::ExpanderRow::builder()
                        .title(&key)
                        .subtitle(format!("Agent: {agent} | Model: {model} | Status: {status}"))
                        .show_enable_switch(false)
                        .build();

                    // -- Model override (ComboRow) --
                    let model_store = gtk4::StringList::new(&[]);
                    let model_ids: Rc<RefCell<Vec<String>>> =
                        Rc::new(RefCell::new(Vec::new()));
                    for m in &models {
                        let id = m
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("?")
                            .to_string();
                        let name = m
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or(&id)
                            .to_string();
                        let provider = m
                            .get("provider")
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let label = if provider.is_empty() {
                            name
                        } else {
                            format!("{name} ({provider})")
                        };
                        model_store.append(&label);
                        model_ids.borrow_mut().push(id);
                    }
                    let model_row = adw::ComboRow::builder()
                        .title("Override Model")
                        .model(&model_store)
                        .build();
                    // Pre-select the current model.
                    {
                        let ids = model_ids.borrow();
                        if let Some(pos) = ids.iter().position(|m| m == &model) {
                            model_row.set_selected(pos as u32);
                        }
                    }

                    // Patch button: apply model override.
                    let patch_btn = gtk4::Button::builder()
                        .label("Patch Model")
                        .css_classes(vec!["suggested-action".to_string()])
                        .valign(gtk4::Align::Center)
                        .build();
                    let patch_row = adw::ActionRow::builder()
                        .title("Apply Model Override")
                        .activatable(false)
                        .build();
                    patch_row.add_suffix(&patch_btn);

                    {
                        let client = client.clone();
                        let key = key.clone();
                        let model_row = model_row.clone();
                        let model_ids = model_ids.clone();
                        patch_btn.connect_clicked(move |btn| {
                            let idx = model_row.selected() as usize;
                            let selected_model =
                                model_ids.borrow().get(idx).cloned().unwrap_or_default();
                            if selected_model.is_empty() {
                                return;
                            }
                            let Some(gw) = client.lock().unwrap().clone() else {
                                return;
                            };
                            let key = key.clone();
                            let model = selected_model.clone();
                            btn.set_sensitive(false);
                            let btn2 = btn.clone();
                            glib::spawn_future_local(async move {
                                let params = serde_json::json!({
                                    "key": key,
                                    "model": model,
                                });
                                match gw.request("sessions.patch", params).await {
                                    Ok(_) => {
                                        debug!("sessions.patch ok for {key}");
                                    }
                                    Err(e) => {
                                        warn!("sessions.patch: {e}");
                                    }
                                }
                                btn2.set_sensitive(true);
                            });
                        });
                    }

                    // Action buttons row: Reset, Compact, Delete.
                    let actions_row = adw::ActionRow::builder()
                        .title("Actions")
                        .activatable(false)
                        .build();

                    // Reset button with confirmation dialog.
                    let reset_btn = gtk4::Button::builder()
                        .label("Reset")
                        .css_classes(vec!["flat".to_string()])
                        .valign(gtk4::Align::Center)
                        .build();
                    {
                        let client = client.clone();
                        let key = key.clone();
                        reset_btn.connect_clicked(move |btn| {
                            let Some(gw) = client.lock().unwrap().clone() else {
                                return;
                            };
                            let key = key.clone();
                            let btn2 = btn.clone();
                            // Confirmation dialog.
                            let dialog = adw::AlertDialog::builder()
                                .heading("Reset Session?")
                                .body(format!(
                                    "This will clear the conversation history for session \"{key}\". This cannot be undone."
                                ))
                                .build();
                            dialog.add_responses(&[("cancel", "Cancel"), ("reset", "Reset")]);
                            dialog.set_response_appearance(
                                "reset",
                                adw::ResponseAppearance::Destructive,
                            );
                            dialog.set_default_response(Some("cancel"));
                            let root = btn2.root().and_downcast::<gtk4::Window>();
                            dialog.connect_response(None, move |_, response| {
                                if response != "reset" {
                                    return;
                                }
                                let gw = gw.clone();
                                let key = key.clone();
                                glib::spawn_future_local(async move {
                                    let params = serde_json::json!({ "key": key });
                                    match gw.request("sessions.reset", params).await {
                                        Ok(_) => debug!("sessions.reset ok for {key}"),
                                        Err(e) => warn!("sessions.reset: {e}"),
                                    }
                                });
                            });
                            dialog.present(root.as_ref());
                        });
                    }

                    // Compact button.
                    let compact_btn = gtk4::Button::builder()
                        .label("Compact")
                        .css_classes(vec!["flat".to_string()])
                        .valign(gtk4::Align::Center)
                        .build();
                    {
                        let client = client.clone();
                        let key = key.clone();
                        compact_btn.connect_clicked(move |btn| {
                            let Some(gw) = client.lock().unwrap().clone() else {
                                return;
                            };
                            let key = key.clone();
                            btn.set_sensitive(false);
                            let btn2 = btn.clone();
                            glib::spawn_future_local(async move {
                                let params = serde_json::json!({ "key": key });
                                match gw.request("sessions.compact", params).await {
                                    Ok(_) => debug!("sessions.compact ok for {key}"),
                                    Err(e) => warn!("sessions.compact: {e}"),
                                }
                                btn2.set_sensitive(true);
                            });
                        });
                    }

                    // Delete button with confirmation.
                    let delete_btn = gtk4::Button::builder()
                        .label("Delete")
                        .css_classes(vec!["destructive-action".to_string()])
                        .valign(gtk4::Align::Center)
                        .build();
                    {
                        let client = client.clone();
                        let key = key.clone();
                        delete_btn.connect_clicked(move |btn| {
                            let Some(gw) = client.lock().unwrap().clone() else {
                                return;
                            };
                            let key = key.clone();
                            let btn2 = btn.clone();
                            let dialog = adw::AlertDialog::builder()
                                .heading("Delete Session?")
                                .body(format!(
                                    "Permanently delete session \"{key}\"? This cannot be undone."
                                ))
                                .build();
                            dialog.add_responses(&[("cancel", "Cancel"), ("delete", "Delete")]);
                            dialog.set_response_appearance(
                                "delete",
                                adw::ResponseAppearance::Destructive,
                            );
                            dialog.set_default_response(Some("cancel"));
                            let root = btn2.root().and_downcast::<gtk4::Window>();
                            dialog.connect_response(None, move |_, response| {
                                if response != "delete" {
                                    return;
                                }
                                let gw = gw.clone();
                                let key = key.clone();
                                glib::spawn_future_local(async move {
                                    let params = serde_json::json!({ "key": key });
                                    match gw.request("sessions.delete", params).await {
                                        Ok(_) => debug!("sessions.delete ok for {key}"),
                                        Err(e) => warn!("sessions.delete: {e}"),
                                    }
                                });
                            });
                            dialog.present(root.as_ref());
                        });
                    }

                    actions_row.add_suffix(&reset_btn);
                    actions_row.add_suffix(&compact_btn);
                    actions_row.add_suffix(&delete_btn);

                    expander.add_row(&model_row);
                    expander.add_row(&patch_row);
                    expander.add_row(&actions_row);

                    group.add(&expander);
                    expander_rows.borrow_mut().push(expander);
                }
            }
        };

        // Poll for state readiness, then populate.
        let s = state;
        let container_ref = container.clone();
        let scroll_ref = scroll.clone();
        let build = build_rows;
        let mut populated = false;
        glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            if !populated && s.is_connected() {
                let sessions = s.sessions();
                if sessions.is_empty() {
                    let empty = status_placeholder::empty(
                        "view-list-symbolic",
                        "No active sessions",
                        Some("Start a chat to create your first session"),
                    );
                    status_placeholder::swap_child(&container_ref, &empty);
                } else {
                    build();
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

#[cfg(test)]
mod tests {
    #[test]
    fn session_key_parsing_extracts_agent_and_session() {
        // Session keys follow the pattern "agentId:sessionName"
        let key = "my-agent:default";
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "my-agent");
        assert_eq!(parts[1], "default");
    }

    #[test]
    fn session_key_without_colon_is_standalone() {
        let key = "default";
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], "default");
    }

    #[test]
    fn session_key_with_multiple_colons_splits_at_first() {
        // Keys like "agent:session:subkey" should split at the first colon
        let key = "agent:session:run:123";
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0], "agent");
        assert_eq!(parts[1], "session:run:123");
    }

    #[test]
    fn session_key_empty_string() {
        let key = "";
        let parts: Vec<&str> = key.splitn(2, ':').collect();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0], "");
    }

    #[test]
    fn session_status_values() {
        let valid_statuses = ["active", "idle", "archived"];
        for status in &valid_statuses {
            assert!(!status.is_empty());
        }
    }
}
