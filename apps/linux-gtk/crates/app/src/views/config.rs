use gtk4::{self, glib, Orientation};
use libadwaita::prelude::*;
use sourceview5::prelude::*;
use tracing::{debug, warn};

use crate::state::SharedClient;

pub struct ConfigView {
    container: gtk4::Box,
}

impl ConfigView {
    pub fn new(client: SharedClient) -> Self {
        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .vexpand(true)
            .hexpand(true)
            .build();

        // Toolbar
        let toolbar = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(16)
            .margin_end(16)
            .margin_top(8)
            .margin_bottom(4)
            .build();

        let title = gtk4::Label::builder()
            .label("Gateway Configuration")
            .css_classes(vec!["heading".to_string()])
            .halign(gtk4::Align::Start)
            .hexpand(true)
            .build();

        let status_label = gtk4::Label::builder()
            .label("")
            .css_classes(vec!["caption".to_string(), "dim-label".to_string()])
            .valign(gtk4::Align::Center)
            .build();

        let reload_btn = gtk4::Button::builder()
            .label("Reload")
            .css_classes(vec!["flat".to_string()])
            .tooltip_text("Reload config from gateway")
            .build();

        let save_btn = gtk4::Button::builder()
            .label("Save")
            .css_classes(vec!["suggested-action".to_string(), "pill".to_string()])
            .tooltip_text("Validate and save config to gateway")
            .sensitive(false)
            .build();

        toolbar.append(&title);
        toolbar.append(&status_label);
        toolbar.append(&reload_btn);
        toolbar.append(&save_btn);
        container.append(&toolbar);
        container.append(&gtk4::Separator::new(Orientation::Horizontal));

        // Source view with JSON syntax highlighting.
        let lang_manager = sourceview5::LanguageManager::default();
        let json_lang = lang_manager.language("json");

        let buffer = sourceview5::Buffer::new(None);
        if let Some(ref lang) = json_lang {
            buffer.set_language(Some(lang));
        }
        buffer.set_highlight_syntax(true);

        // Use a dark style scheme if available.
        let scheme_manager = sourceview5::StyleSchemeManager::default();
        if let Some(scheme) = scheme_manager
            .scheme("Adwaita-dark")
            .or_else(|| scheme_manager.scheme("oblivion"))
        {
            buffer.set_style_scheme(Some(&scheme));
        }

        let editor = sourceview5::View::builder()
            .buffer(&buffer)
            .monospace(true)
            .show_line_numbers(true)
            .auto_indent(true)
            .indent_width(2)
            .tab_width(2)
            .insert_spaces_instead_of_tabs(true)
            .wrap_mode(gtk4::WrapMode::WordChar)
            .left_margin(12)
            .right_margin(12)
            .top_margin(12)
            .bottom_margin(12)
            .vexpand(true)
            .build();

        let scroll = gtk4::ScrolledWindow::builder()
            .child(&editor)
            .vexpand(true)
            .hscrollbar_policy(gtk4::PolicyType::Automatic)
            .build();

        container.append(&scroll);

        // Validation bar at the bottom.
        let validation_bar = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(8)
            .margin_start(16)
            .margin_end(16)
            .margin_top(4)
            .margin_bottom(8)
            .build();

        let valid_label = gtk4::Label::builder()
            .label("")
            .css_classes(vec!["caption".to_string()])
            .halign(gtk4::Align::Start)
            .hexpand(true)
            .build();
        validation_bar.append(&valid_label);
        container.append(&validation_bar);

        // Load config from gateway.
        let load_config = {
            let client = client.clone();
            let buffer = buffer.clone();
            let status_label = status_label.clone();
            let save_btn = save_btn.clone();
            move || {
                if let Some(gw) = client.lock().unwrap().clone() {
                    let buf = buffer.clone();
                    let sl = status_label.clone();
                    let sb = save_btn.clone();
                    glib::spawn_future_local(async move {
                        let params = serde_json::json!({ "path": "" });
                        match gw.request("config.get", params).await {
                            Ok(payload) => {
                                if let Some(config) = payload.get("config") {
                                    let pretty = serde_json::to_string_pretty(config)
                                        .unwrap_or_else(|_| config.to_string());
                                    buf.set_text(&pretty);
                                    sl.set_label("Loaded");
                                    sb.set_sensitive(false);
                                    debug!("config.get loaded");
                                } else {
                                    buf.set_text("// No config returned from gateway");
                                    sl.set_label("Empty");
                                }
                            }
                            Err(e) => {
                                buf.set_text(&format!("// Failed to load: {e}"));
                                sl.set_label("Error");
                                warn!("config.get: {e}");
                            }
                        }
                    });
                }
            }
        };

        // Load on startup after a short delay for connection.
        let load = load_config.clone();
        glib::timeout_add_local_once(std::time::Duration::from_secs(2), move || {
            load();
        });

        // Reload button.
        let load2 = load_config;
        reload_btn.connect_clicked(move |_| {
            load2();
        });

        // Mark dirty on edit + live JSON validation.
        let sb2 = save_btn.clone();
        let sl2 = status_label.clone();
        let vl = valid_label.clone();
        buffer.connect_changed(move |buf| {
            sb2.set_sensitive(true);
            sl2.set_label("Modified");
            let (start, end) = buf.bounds();
            let text = buf.text(&start, &end, false);
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(_) => {
                    vl.set_label("Valid JSON");
                    vl.remove_css_class("chip-error");
                    vl.add_css_class("chip-ok");
                }
                Err(e) => {
                    vl.set_label(&format!("Invalid: {e}"));
                    vl.remove_css_class("chip-ok");
                    vl.add_css_class("chip-error");
                }
            }
        });

        // Save button: validate JSON, then send config.set.
        let c2 = client;
        let sl3 = status_label;
        let sb3 = save_btn;
        let buf_save = buffer;
        sb3.connect_clicked(move |btn| {
            let (start, end) = buf_save.bounds();
            let raw = buf_save.text(&start, &end, false).to_string();

            let parsed = match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(v) => v,
                Err(_) => {
                    sl3.set_label("Cannot save: invalid JSON");
                    return;
                }
            };

            btn.set_sensitive(false);
            sl3.set_label("Saving...");

            if let Some(gw) = c2.lock().unwrap().clone() {
                let sl = sl3.clone();
                let btn2 = btn.clone();
                glib::spawn_future_local(async move {
                    let params = serde_json::json!({
                        "path": "",
                        "value": parsed,
                    });
                    match gw.request("config.set", params).await {
                        Ok(_) => {
                            sl.set_label("Saved successfully");
                            btn2.set_sensitive(false);
                            debug!("config.set ok");
                        }
                        Err(e) => {
                            sl.set_label(&format!("Save failed: {e}"));
                            btn2.set_sensitive(true);
                            warn!("config.set: {e}");
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
