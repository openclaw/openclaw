use std::cell::RefCell;
use std::rc::Rc;

use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;
use tracing::{debug, warn};

use crate::state::{AppState, SharedClient};
use crate::widgets::status_placeholder;

pub struct AgentsView {
    container: gtk4::Box,
}

impl AgentsView {
    pub fn new(state: AppState, client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        // Loading placeholder is swapped out once the agents list is known.
        let loading = status_placeholder::loading("Loading agents...");
        container.append(&loading);

        // ---- Root split: left list, right detail --------------------------
        let paned = gtk4::Paned::builder()
            .orientation(Orientation::Horizontal)
            .position(280)
            .wide_handle(true)
            .vexpand(true)
            .hexpand(true)
            .build();

        // ---- Left: agent list --------------------------------------------
        let list_scroll = gtk4::ScrolledWindow::builder()
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .vexpand(true)
            .width_request(240)
            .build();
        let list_box = gtk4::ListBox::builder()
            .selection_mode(gtk4::SelectionMode::Single)
            .css_classes(vec!["navigation-sidebar".to_string()])
            .build();
        list_scroll.set_child(Some(&list_box));
        paned.set_start_child(Some(&list_scroll));

        // ---- Right: detail pane (scrollable) -----------------------------
        let detail_scroll = gtk4::ScrolledWindow::builder()
            .hscrollbar_policy(gtk4::PolicyType::Never)
            .vexpand(true)
            .hexpand(true)
            .build();

        let detail_content = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .spacing(16)
            .margin_start(24)
            .margin_end(24)
            .margin_top(20)
            .margin_bottom(20)
            .build();

        // Header: agent name + id + save status
        let title_label = gtk4::Label::builder()
            .label("Select an agent")
            .css_classes(vec!["title-2".to_string()])
            .halign(gtk4::Align::Start)
            .xalign(0.0)
            .build();
        let subtitle_label = gtk4::Label::builder()
            .label("")
            .css_classes(vec!["dim-label".to_string(), "caption".to_string()])
            .halign(gtk4::Align::Start)
            .xalign(0.0)
            .build();
        detail_content.append(&title_label);
        detail_content.append(&subtitle_label);

        // Settings group — editable agent config.
        let settings_group = adw::PreferencesGroup::builder()
            .title("Settings")
            .description("Update the agent's name, workspace, avatar, and model")
            .build();

        let name_row = adw::EntryRow::builder().title("Name").build();
        let workspace_row = adw::EntryRow::builder().title("Workspace").build();
        let avatar_row = adw::EntryRow::builder().title("Avatar (emoji or URL)").build();

        // Model is a drop-down populated from state.models.
        let model_store = gtk4::StringList::new(&[]);
        let model_row = adw::ComboRow::builder()
            .title("Model")
            .model(&model_store)
            .build();

        settings_group.add(&name_row);
        settings_group.add(&workspace_row);
        settings_group.add(&avatar_row);
        settings_group.add(&model_row);
        detail_content.append(&settings_group);

        // Save button below settings.
        let save_btn = gtk4::Button::builder()
            .label("Save Changes")
            .css_classes(vec!["suggested-action".to_string()])
            .halign(gtk4::Align::End)
            .build();
        detail_content.append(&save_btn);

        // Files group.
        let files_group = adw::PreferencesGroup::builder()
            .title("Workspace Files")
            .description("Files in the agent's workspace directory")
            .build();
        detail_content.append(&files_group);

        let clamp = adw::Clamp::builder()
            .maximum_size(820)
            .child(&detail_content)
            .build();
        detail_scroll.set_child(Some(&clamp));
        paned.set_end_child(Some(&detail_scroll));

        // ---- Wiring: state watchers --------------------------------------
        // We share across closures with Rc<RefCell<...>>.
        let agents_cache: Rc<RefCell<Vec<serde_json::Value>>> =
            Rc::new(RefCell::new(Vec::new()));
        let selected_idx: Rc<std::cell::Cell<Option<usize>>> =
            Rc::new(std::cell::Cell::new(None));
        let model_ids: Rc<RefCell<Vec<String>>> = Rc::new(RefCell::new(Vec::new()));

        // Populate model dropdown from state.models (once).
        let state_mdl = state.clone();
        let model_ids_init = model_ids.clone();
        let model_store_init = model_store.clone();
        // Defer one tick so state.models has populated.
        glib::timeout_add_local(std::time::Duration::from_millis(500), move || {
            let models = state_mdl.models();
            if models.is_empty() {
                return glib::ControlFlow::Continue;
            }
            let mut ids: Vec<String> = Vec::with_capacity(models.len());
            // Clear the existing store first (idempotent rebuild).
            while model_store_init.n_items() > 0 {
                model_store_init.remove(0);
            }
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
                model_store_init.append(&label);
                ids.push(id);
            }
            *model_ids_init.borrow_mut() = ids;
            glib::ControlFlow::Break
        });

        // Show detail pane for a given agent index.
        let tl = title_label.clone();
        let stl = subtitle_label.clone();
        let nr = name_row.clone();
        let wr = workspace_row.clone();
        let ar = avatar_row.clone();
        let mr = model_row.clone();
        let fg = files_group.clone();
        let client_files = client.clone();
        let agents_cache_sel = agents_cache.clone();
        let model_ids_sel = model_ids.clone();
        let files_group_rc: Rc<RefCell<Vec<adw::ActionRow>>> =
            Rc::new(RefCell::new(Vec::new()));
        let files_group_rc_clone = files_group_rc.clone();
        let show_agent_detail = Rc::new(move |idx: usize| {
            let agents = agents_cache_sel.borrow();
            let Some(agent) = agents.get(idx) else {
                return;
            };
            let id = agent.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
            let name = agent
                .get("identity")
                .and_then(|i| i.get("name"))
                .and_then(|n| n.as_str())
                .or_else(|| agent.get("name").and_then(|v| v.as_str()))
                .unwrap_or(id);
            let emoji = agent
                .get("identity")
                .and_then(|i| i.get("emoji"))
                .and_then(|e| e.as_str())
                .unwrap_or("");
            let model = agent.get("model").and_then(|v| v.as_str()).unwrap_or("");
            let workspace = agent
                .get("workspace")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let avatar = agent
                .get("identity")
                .and_then(|i| i.get("avatar"))
                .and_then(|v| v.as_str())
                .or_else(|| agent.get("avatar").and_then(|v| v.as_str()))
                .unwrap_or(emoji);

            tl.set_label(&format!("{emoji} {name}"));
            stl.set_label(&format!("id: {id}"));
            nr.set_text(name);
            wr.set_text(workspace);
            ar.set_text(avatar);

            // Set model dropdown to the current model.
            let ids = model_ids_sel.borrow();
            if let Some(pos) = ids.iter().position(|m| m == model) {
                mr.set_selected(pos as u32);
            }

            // Clear existing file rows from the group.
            {
                let mut rows = files_group_rc_clone.borrow_mut();
                for row in rows.drain(..) {
                    fg.remove(&row);
                }
            }

            // Fetch files for this agent.
            let Some(gw) = client_files.lock().unwrap().clone() else {
                return;
            };
            let agent_id = id.to_string();
            let fg2 = fg.clone();
            let rows_ref = files_group_rc_clone.clone();
            glib::spawn_future_local(async move {
                let params = serde_json::json!({ "agentId": agent_id });
                match gw.request("agents.files.list", params).await {
                    Ok(payload) => {
                        let files = payload
                            .get("files")
                            .and_then(|f| f.as_array())
                            .cloned()
                            .unwrap_or_default();
                        debug!("agents.files.list for {agent_id}: {} files", files.len());
                        if files.is_empty() {
                            let row = adw::ActionRow::builder()
                                .title("No workspace files")
                                .subtitle("This agent's workspace is empty")
                                .build();
                            fg2.add(&row);
                            rows_ref.borrow_mut().push(row);
                            return;
                        }
                        for file in &files {
                            let name = file
                                .get("name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?");
                            let size = file
                                .get("size")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            let missing = file
                                .get("missing")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let subtitle = if missing {
                                "missing".to_string()
                            } else {
                                format_size(size)
                            };
                            let row = adw::ActionRow::builder()
                                .title(name)
                                .subtitle(&subtitle)
                                .activatable(true)
                                .build();
                            fg2.add(&row);
                            rows_ref.borrow_mut().push(row);
                        }
                    }
                    Err(e) => {
                        warn!("agents.files.list: {e}");
                        let row = adw::ActionRow::builder()
                            .title("Failed to load files")
                            .subtitle(format!("{e}"))
                            .build();
                        fg2.add(&row);
                        rows_ref.borrow_mut().push(row);
                    }
                }
            });
        });

        // List row selection → show detail.
        let selected_idx_list = selected_idx.clone();
        let show_agent_detail_list = show_agent_detail.clone();
        list_box.connect_row_selected(move |_, row| {
            if let Some(row) = row {
                let idx = row.index() as usize;
                selected_idx_list.set(Some(idx));
                show_agent_detail_list(idx);
            }
        });

        // Save button → agents.update.
        let client_save = client.clone();
        let selected_idx_save = selected_idx.clone();
        let agents_cache_save = agents_cache.clone();
        let model_ids_save = model_ids.clone();
        let nr_save = name_row.clone();
        let wr_save = workspace_row.clone();
        let ar_save = avatar_row.clone();
        let mr_save = model_row.clone();
        save_btn.connect_clicked(move |_| {
            let Some(idx) = selected_idx_save.get() else {
                return;
            };
            let agent_id = agents_cache_save
                .borrow()
                .get(idx)
                .and_then(|a| a.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()));
            let Some(agent_id) = agent_id else { return };
            let Some(gw) = client_save.lock().unwrap().clone() else {
                return;
            };
            let name = nr_save.text().to_string();
            let workspace = wr_save.text().to_string();
            let avatar = ar_save.text().to_string();
            let model_idx = mr_save.selected() as usize;
            let model = model_ids_save.borrow().get(model_idx).cloned();

            let mut params = serde_json::json!({ "agentId": agent_id });
            if !name.is_empty() {
                params["name"] = name.into();
            }
            if !workspace.is_empty() {
                params["workspace"] = workspace.into();
            }
            if !avatar.is_empty() {
                params["avatar"] = avatar.into();
            }
            if let Some(m) = model {
                params["model"] = m.into();
            }
            glib::spawn_future_local(async move {
                match gw.request("agents.update", params).await {
                    Ok(_) => debug!("agents.update ok"),
                    Err(e) => warn!("agents.update: {e}"),
                }
            });
        });

        // ---- Populate the agent list from state --------------------------
        let state_list = state;
        let agents_cache_poll = agents_cache;
        let container_ref = container.clone();
        let paned_ref = paned.clone();
        let list_box_poll = list_box;
        let show_detail_poll = show_agent_detail.clone();
        let mut populated = false;
        glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            if populated {
                return glib::ControlFlow::Continue;
            }
            if !state_list.is_connected() {
                return glib::ControlFlow::Continue;
            }
            let agents = state_list.agents();
            if agents.is_empty() {
                let empty = status_placeholder::empty(
                    "system-users-symbolic",
                    "No agents configured",
                    Some("Add agents in ~/.openclaw/openclaw.json under agents.list[]"),
                );
                status_placeholder::swap_child(&container_ref, &empty);
                populated = true;
                return glib::ControlFlow::Continue;
            }

            // Populate the sidebar list.
            for (i, agent) in agents.iter().enumerate() {
                let id = agent
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown");
                let name = agent
                    .get("identity")
                    .and_then(|ident| ident.get("name"))
                    .and_then(|n| n.as_str())
                    .or_else(|| agent.get("name").and_then(|v| v.as_str()))
                    .unwrap_or(id);
                let emoji = agent
                    .get("identity")
                    .and_then(|ident| ident.get("emoji"))
                    .and_then(|e| e.as_str())
                    .unwrap_or("");
                let model = agent.get("model").and_then(|v| v.as_str()).unwrap_or("-");

                let row = adw::ActionRow::builder()
                    .title(format!("{emoji} {name}"))
                    .subtitle(format!("{id} • {model}"))
                    .activatable(true)
                    .build();
                // Stash the index on the row for later lookup. index() also
                // works since rows are added in order.
                list_box_poll.append(&row);
                let _ = i;
            }

            *agents_cache_poll.borrow_mut() = agents.clone();
            status_placeholder::swap_child(&container_ref, &paned_ref);
            populated = true;

            // Auto-select the first agent.
            if let Some(row) = list_box_poll.row_at_index(0) {
                list_box_poll.select_row(Some(&row));
                show_detail_poll(0);
            }
            glib::ControlFlow::Continue
        });

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}

/// Format a byte count with k/M/G suffixes.
pub(crate) fn format_size(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = 1024 * KB;
    const GB: u64 = 1024 * MB;
    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{bytes} B")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_size_bytes() {
        assert_eq!(format_size(0), "0 B");
        assert_eq!(format_size(512), "512 B");
        assert_eq!(format_size(1023), "1023 B");
    }

    #[test]
    fn format_size_kilobytes() {
        assert_eq!(format_size(1024), "1.0 KB");
        assert_eq!(format_size(1536), "1.5 KB");
        assert_eq!(format_size(1024 * 100), "100.0 KB");
    }

    #[test]
    fn format_size_megabytes() {
        assert_eq!(format_size(1024 * 1024), "1.0 MB");
        assert_eq!(format_size(1024 * 1024 * 3 + 1024 * 512), "3.5 MB");
    }

    #[test]
    fn format_size_gigabytes() {
        assert_eq!(format_size(1024 * 1024 * 1024), "1.0 GB");
        assert_eq!(format_size(1024u64 * 1024 * 1024 * 2 + 1024u64 * 1024 * 256), "2.2 GB");
    }
}
