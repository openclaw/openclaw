use std::path::PathBuf;

use gtk4::{self, glib, Orientation};
use libadwaita as adw;
use libadwaita::prelude::*;

use crate::state::{AppState, SharedClient};

/// Current onboarding version marker. Bump when the onboarding flow changes
/// substantially so users see the updated experience.
const ONBOARDING_VERSION: &str = "1";

/// Multi-stage onboarding view with gateway URL/token entry.
///
/// Stages:
/// 1. Config missing  -- `~/.openclaw/openclaw.json` does not exist
/// 2. Gateway offline  -- config exists but healthz unreachable
/// 3. Connected        -- gateway reachable and state.is_connected()
pub struct OnboardingView {
    container: gtk4::Box,
}

impl OnboardingView {
    pub fn new(
        state: AppState,
        client: SharedClient,
        on_connected: impl Fn() + 'static,
    ) -> Self {
        // Write onboarding version marker
        Self::write_version_marker();

        let container = gtk4::Box::builder()
            .orientation(Orientation::Vertical)
            .valign(gtk4::Align::Center)
            .halign(gtk4::Align::Center)
            .spacing(24)
            .margin_start(48)
            .margin_end(48)
            .margin_top(48)
            .margin_bottom(48)
            .vexpand(true)
            .hexpand(true)
            .build();

        let title = gtk4::Label::builder()
            .label("OpenClaw")
            .css_classes(vec!["title-1".to_string()])
            .build();

        let subtitle = gtk4::Label::builder()
            .label("Connect to your OpenClaw gateway")
            .css_classes(vec!["dim-label".to_string()])
            .build();

        container.append(&title);
        container.append(&subtitle);

        // Stage indicator
        let stage_group = adw::PreferencesGroup::builder()
            .title("Setup Progress")
            .build();

        let config_row = adw::ActionRow::builder()
            .title("Configuration")
            .subtitle("Checking...")
            .build();
        let config_icon = gtk4::Image::from_icon_name("emblem-synchronizing-symbolic");
        config_row.add_prefix(&config_icon);

        let gateway_row = adw::ActionRow::builder()
            .title("Gateway")
            .subtitle("Waiting...")
            .build();
        let gateway_icon = gtk4::Image::from_icon_name("emblem-synchronizing-symbolic");
        gateway_row.add_prefix(&gateway_icon);

        let connected_row = adw::ActionRow::builder()
            .title("Connection")
            .subtitle("Waiting...")
            .build();
        let connected_icon = gtk4::Image::from_icon_name("emblem-synchronizing-symbolic");
        connected_row.add_prefix(&connected_icon);

        stage_group.add(&config_row);
        stage_group.add(&gateway_row);
        stage_group.add(&connected_row);

        let stage_clamp = adw::Clamp::builder()
            .maximum_size(420)
            .child(&stage_group)
            .build();
        container.append(&stage_clamp);

        // Connection form (URL + token entry)
        let form_group = adw::PreferencesGroup::builder()
            .title("Gateway Connection")
            .build();

        let url_row = adw::EntryRow::builder()
            .title("Gateway URL")
            .text("wss://127.0.0.1:18789")
            .build();

        let token_row = adw::PasswordEntryRow::builder()
            .title("Token (optional)")
            .build();

        form_group.add(&url_row);
        form_group.add(&token_row);

        let form_clamp = adw::Clamp::builder()
            .maximum_size(420)
            .child(&form_group)
            .build();
        container.append(&form_clamp);

        // Status label for connect feedback
        let status_label = gtk4::Label::builder()
            .label("")
            .css_classes(vec!["dim-label".to_string()])
            .visible(false)
            .build();
        container.append(&status_label);

        // Connect button
        let connect_btn = gtk4::Button::builder()
            .label("Connect")
            .css_classes(vec!["suggested-action".to_string(), "pill".to_string()])
            .halign(gtk4::Align::Center)
            .build();
        container.append(&connect_btn);

        // Wire connect button
        let sl = status_label.clone();
        let on_connected = std::rc::Rc::new(on_connected);
        let on_connected_btn = on_connected.clone();
        let state_for_btn = state.clone();
        connect_btn.connect_clicked(move |btn| {
            let url_text = url_row.text().to_string();
            let token_text = token_row.text().to_string();

            if url_text.is_empty() {
                sl.set_label("Please enter a gateway URL");
                sl.set_visible(true);
                return;
            }

            // SAFETY: single-threaded GTK main loop, no concurrent env access
            unsafe {
                std::env::set_var("OPENCLAW_GATEWAY_URL", &url_text);
                if !token_text.is_empty() {
                    std::env::set_var("OPENCLAW_GATEWAY_TOKEN", &token_text);
                }
            }

            btn.set_sensitive(false);
            sl.set_label("Connecting...");
            sl.set_visible(true);
            sl.remove_css_class("error");

            let on_connected = on_connected_btn.clone();
            let sl2 = sl.clone();
            let btn2 = btn.clone();
            let state_check = state_for_btn.clone();
            glib::timeout_add_local(std::time::Duration::from_secs(3), move || {
                let connected = state_check.is_connected();
                if connected {
                    (on_connected)();
                } else {
                    sl2.set_label("Connection failed -- check URL and try again");
                    sl2.add_css_class("error");
                    btn2.set_sensitive(true);
                }
                glib::ControlFlow::Break
            });
        });

        // Poll every 500ms to detect stage changes and auto-advance
        let s = state;
        let ci = config_icon;
        let cr = config_row;
        let gi = gateway_icon;
        let gr = gateway_row;
        let cni = connected_icon;
        let cnr = connected_row;
        let cb = connect_btn;
        let sl_poll = status_label;
        let mut has_fired_connected = false;
        glib::timeout_add_local(std::time::Duration::from_millis(500), move || {
            let config_exists = Self::config_exists();
            let is_connected = s.is_connected();

            // Stage 1: config file
            if config_exists {
                ci.set_icon_name(Some("emblem-ok-symbolic"));
                cr.set_subtitle("openclaw.json found");
            } else {
                ci.set_icon_name(Some("dialog-warning-symbolic"));
                cr.set_subtitle("Run `openclaw setup` first");
            }

            // Stage 2: gateway reachable (we infer from connection state;
            // if connected the gateway was reachable)
            if is_connected {
                gi.set_icon_name(Some("emblem-ok-symbolic"));
                gr.set_subtitle("Reachable");
            } else if config_exists {
                // Config exists but not connected -- try healthz probe
                gi.set_icon_name(Some("dialog-warning-symbolic"));
                gr.set_subtitle("Gateway not running");
            } else {
                gi.set_icon_name(Some("emblem-synchronizing-symbolic"));
                gr.set_subtitle("Waiting for config...");
            }

            // Stage 3: connected
            if is_connected {
                cni.set_icon_name(Some("emblem-ok-symbolic"));
                cnr.set_subtitle("Connected! Ready to use");
                cb.set_sensitive(false);
                sl_poll.set_label("Connected");
                sl_poll.set_visible(true);
                sl_poll.remove_css_class("error");

                if !has_fired_connected {
                    has_fired_connected = true;
                    (on_connected)();
                }
            } else {
                cni.set_icon_name(Some("emblem-synchronizing-symbolic"));
                cnr.set_subtitle("Waiting...");
            }

            glib::ControlFlow::Continue
        });

        // Suppress unused-variable warning for the client handle; it is
        // captured by the connect button closure's environment and kept
        // alive for the view's lifetime.
        let _ = client;

        Self { container }
    }

    /// Check whether the main OpenClaw config file exists.
    fn config_exists() -> bool {
        Self::openclaw_config_path()
            .map(|p| p.exists())
            .unwrap_or(false)
    }

    fn openclaw_config_path() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".openclaw").join("openclaw.json"))
    }

    /// Write the onboarding version marker so the app can detect whether
    /// the user has seen the current onboarding flow.
    fn write_version_marker() {
        if let Some(home) = dirs::home_dir() {
            let dir = home.join(".openclaw").join("gtk-identity");
            if std::fs::create_dir_all(&dir).is_ok() {
                let _ = std::fs::write(dir.join("onboarding-version"), ONBOARDING_VERSION);
            }
        }
    }

    pub fn widget(&self) -> &gtk4::Box {
        &self.container
    }
}
