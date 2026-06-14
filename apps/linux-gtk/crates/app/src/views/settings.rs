use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::{AppState, SharedClient};

/// Settings view: gateway connection, test, reconnect, appearance.
pub struct SettingsView {
    container: gtk4::Box,
}

impl SettingsView {
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

        // -- Connection card --
        let conn_group = adw::PreferencesGroup::builder()
            .title("Connection")
            .description("Gateway WebSocket connection settings")
            .build();

        // Connection status row
        let status_row = adw::ActionRow::builder()
            .title("Status")
            .build();
        let status_chip = gtk4::Label::builder()
            .label("Checking...")
            .css_classes(vec!["status-chip".to_string()])
            .valign(gtk4::Align::Center)
            .build();
        status_row.add_suffix(&status_chip);
        conn_group.add(&status_row);

        // Gateway URL
        let url_row = adw::EntryRow::builder()
            .title("Gateway URL")
            .text(
                std::env::var("OPENCLAW_GATEWAY_URL")
                    .unwrap_or_else(|_| "wss://127.0.0.1:18789".to_string()),
            )
            .build();
        conn_group.add(&url_row);

        // Gateway Token
        let token_row = adw::PasswordEntryRow::builder()
            .title("Gateway Token")
            .text(
                std::env::var("OPENCLAW_GATEWAY_TOKEN").unwrap_or_default(),
            )
            .build();
        conn_group.add(&token_row);

        content.append(&conn_group);

        // -- Action buttons --
        let btn_box = gtk4::Box::builder()
            .orientation(Orientation::Horizontal)
            .spacing(12)
            .halign(gtk4::Align::Start)
            .build();

        let test_btn = gtk4::Button::builder()
            .label("Test Connection")
            .css_classes(vec!["pill".to_string()])
            .build();

        let reconnect_btn = gtk4::Button::builder()
            .label("Save & Reconnect")
            .css_classes(vec!["suggested-action".to_string(), "pill".to_string()])
            .build();

        btn_box.append(&test_btn);
        btn_box.append(&reconnect_btn);
        content.append(&btn_box);

        // Test result label
        let result_label = gtk4::Label::builder()
            .label("")
            .xalign(0.0)
            .visible(false)
            .wrap(true)
            .build();
        content.append(&result_label);

        // -- Appearance card --
        let appearance_group = adw::PreferencesGroup::builder()
            .title("Appearance")
            .build();

        let theme_row = adw::ActionRow::builder()
            .title("Color Scheme")
            .subtitle("Follow system preference")
            .build();
        let theme_dropdown = gtk4::DropDown::from_strings(&["System", "Dark", "Light"]);
        theme_dropdown.set_valign(gtk4::Align::Center);

        let style_mgr = adw::StyleManager::default();
        theme_dropdown.connect_selected_notify(move |dd| {
            let scheme = match dd.selected() {
                0 => adw::ColorScheme::Default,
                1 => adw::ColorScheme::ForceDark,
                2 => adw::ColorScheme::ForceLight,
                _ => adw::ColorScheme::Default,
            };
            style_mgr.set_color_scheme(scheme);
        });
        theme_row.add_suffix(&theme_dropdown);
        appearance_group.add(&theme_row);
        content.append(&appearance_group);

        // -- About card --
        let about_group = adw::PreferencesGroup::builder()
            .title("About")
            .build();

        let version_row = adw::ActionRow::builder()
            .title("App Version")
            .subtitle(env!("CARGO_PKG_VERSION"))
            .build();
        about_group.add(&version_row);

        let gw_version_row = adw::ActionRow::builder()
            .title("Gateway Version")
            .subtitle("—")
            .build();
        about_group.add(&gw_version_row);
        content.append(&about_group);

        let clamp = adw::Clamp::builder()
            .maximum_size(600)
            .child(&content)
            .build();
        scroll.set_child(Some(&clamp));
        container.append(&scroll);

        // -- Wire up status polling --
        let state2 = state.clone();
        let sc = status_chip.clone();
        let gv = gw_version_row.clone();
        glib::timeout_add_local(std::time::Duration::from_secs(1), move || {
            if state2.is_connected() {
                sc.set_label("Connected");
                sc.remove_css_class("chip-error");
                sc.add_css_class("chip-ok");
                gv.set_subtitle(&format!("v{}", state2.server_version()));
            } else {
                sc.set_label("Disconnected");
                sc.remove_css_class("chip-ok");
                sc.add_css_class("chip-error");
                gv.set_subtitle("—");
            }
            glib::ControlFlow::Continue
        });

        // -- Test Connection --
        let client2 = client.clone();
        let rl = result_label.clone();
        test_btn.connect_clicked(move |btn| {
            btn.set_sensitive(false);
            rl.set_label("Testing...");
            rl.set_visible(true);
            rl.remove_css_class("chip-ok");
            rl.remove_css_class("chip-error");

            let gateway = client2.lock().unwrap().clone();
            let rl2 = rl.clone();
            let btn2 = btn.clone();
            if let Some(gw) = gateway {
                glib::spawn_future_local(async move {
                    match gw.request("health", serde_json::json!({})).await {
                        Ok(payload) => {
                            let ver = payload
                                .get("version")
                                .and_then(|v| v.as_str())
                                .unwrap_or("ok");
                            rl2.set_label(&format!("Success — gateway v{ver}"));
                            rl2.add_css_class("chip-ok");
                        }
                        Err(e) => {
                            rl2.set_label(&format!("Failed: {e}"));
                            rl2.add_css_class("chip-error");
                        }
                    }
                    btn2.set_sensitive(true);
                });
            } else {
                rl.set_label("No gateway client available");
                rl.add_css_class("chip-error");
                btn.set_sensitive(true);
            }
        });

        // -- Save & Reconnect --
        let url_ref = url_row;
        let token_ref = token_row;
        let rl3 = result_label;
        reconnect_btn.connect_clicked(move |btn| {
            let url = url_ref.text().to_string();
            let token = token_ref.text().to_string();

            // SAFETY: single-threaded GTK main loop
            unsafe {
                std::env::set_var("OPENCLAW_GATEWAY_URL", &url);
                if !token.is_empty() {
                    std::env::set_var("OPENCLAW_GATEWAY_TOKEN", &token);
                } else {
                    std::env::remove_var("OPENCLAW_GATEWAY_TOKEN");
                }
            }

            // TODO: recreate the GatewayClient with new config instead of
            // just setting env vars. The running client was built from the
            // original GatewayConfig and won't pick up env changes until
            // the next auto-reconnect cycle. For now, updating env + label
            // is a best-effort hint; a full fix requires client teardown +
            // rebuild, which needs SharedClient to support replacement.
            btn.set_sensitive(false);
            rl3.set_label("Settings saved. Restart the app to apply new connection settings.");
            rl3.set_visible(true);
            rl3.remove_css_class("chip-error");
            rl3.add_css_class("chip-ok");

            let btn2 = btn.clone();
            glib::timeout_add_local_once(std::time::Duration::from_secs(2), move || {
                btn2.set_sensitive(true);
            });
        });

        Self { container }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
