use std::sync::Arc;

use gtk4::prelude::*;
use gtk4::{gio, glib};
use libadwaita as adw;
use libadwaita::prelude::*;
use tokio::sync::broadcast;
use tracing::info;

use openclaw_gateway_client::{GatewayClient, GatewayConfig, DeviceIdentity, GatewayEvent};

use crate::bridge::EventBridge;
use crate::state::{AppState, SharedClient};
use crate::window::OpenClawWindow;

pub struct OpenClawApplication {
    app: adw::Application,
}

impl OpenClawApplication {
    pub fn new(app_id: &str) -> Self {
        let app = adw::Application::builder()
            .application_id(app_id)
            .flags(gio::ApplicationFlags::FLAGS_NONE)
            .build();

        app.connect_activate(Self::on_activate);

        // Build app menu + actions, set color scheme
        app.connect_startup(|app| {
            // libadwaita owns dark-mode. Clear the legacy GtkSettings flag
            // (it's often pre-set by the system theme) before calling
            // StyleManager — otherwise libadwaita logs a WARN on every start.
            if let Some(settings) = gtk4::Settings::default() {
                settings.set_gtk_application_prefer_dark_theme(false);
            }
            let style_mgr = adw::StyleManager::default();
            style_mgr.set_color_scheme(adw::ColorScheme::PreferDark);

            Self::setup_actions(app);
            Self::setup_menu(app);
        });

        // Load CSS
        app.connect_startup(|_app| {
            let css = gtk4::CssProvider::new();
            css.load_from_data(include_str!("../../../data/style.css"));
            gtk4::style_context_add_provider_for_display(
                &gtk4::gdk::Display::default().expect("display"),
                &css,
                gtk4::STYLE_PROVIDER_PRIORITY_APPLICATION,
            );
        });

        Self { app }
    }

    fn on_activate(app: &adw::Application) {
        let state = AppState::new();
        let shared_client: SharedClient = Arc::new(std::sync::Mutex::new(None));

        // Start tokio runtime and gateway client in a background thread
        let (bridge_tx, bridge_rx) = async_channel::bounded::<GatewayEvent>(256);
        let client_ref = shared_client.clone();

        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("tokio runtime");

            rt.block_on(async move {
                let config = GatewayConfig::resolve();
                let identity = match DeviceIdentity::load_or_create() {
                    Ok(id) => id,
                    Err(e) => {
                        tracing::error!("device identity failed: {e} — regenerating");
                        // Delete corrupt file and retry once
                        let path = dirs::home_dir()
                            .unwrap_or_default()
                            .join(".openclaw/gtk-identity/device.json");
                        let _ = std::fs::remove_file(&path);
                        DeviceIdentity::load_or_create()
                            .expect("device identity regeneration failed")
                    }
                };
                let instance_id = uuid::Uuid::new_v4().to_string();

                info!("gateway URL: {}", config.url);
                let client = GatewayClient::connect(config, identity, instance_id);
                let mut event_rx = client.subscribe();

                // Store client for RPC calls from UI
                *client_ref.lock().unwrap() = Some(Arc::new(client));

                // Forward gateway events to the GLib main loop via async-channel
                loop {
                    match event_rx.recv().await {
                        Ok(event) => {
                            if bridge_tx.send(event).await.is_err() {
                                break;
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            tracing::warn!("dropped {n} gateway events");
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                    }
                }
            });
        });

        // Create bridge that pumps events from async-channel into GLib main loop
        let bridge = EventBridge::new(bridge_rx, state.clone(), shared_client.clone());
        bridge.start();

        let window = OpenClawWindow::build(app, state, shared_client);
        window.present();
    }

    fn setup_actions(app: &adw::Application) {
        // About action
        let about_action = gio::SimpleAction::new("about", None);
        about_action.connect_activate(glib::clone!(
            #[weak]
            app,
            move |_, _| {
                let about = adw::AboutDialog::builder()
                    .application_name("OpenClaw")
                    .application_icon("computer-symbolic")
                    .version(env!("CARGO_PKG_VERSION"))
                    .developer_name("OpenClaw Contributors")
                    .website("https://openclaw.ai")
                    .issue_url("https://github.com/openclaw/openclaw/issues")
                    .license_type(gtk4::License::MitX11)
                    .build();
                if let Some(win) = app.active_window() {
                    about.present(Some(&win));
                }
            }
        ));
        app.add_action(&about_action);

        // Preferences (settings) action
        let prefs_action = gio::SimpleAction::new("preferences", None);
        prefs_action.connect_activate(glib::clone!(
            #[weak]
            app,
            move |_, _| {
                // Navigate to settings view via window
                if let Some(win) = app.active_window() {
                    win.present();
                }
            }
        ));
        app.add_action(&prefs_action);

        // Docs action
        let docs_action = gio::SimpleAction::new("docs", None);
        docs_action.connect_activate(|_, _| {
            let _ = gio::AppInfo::launch_default_for_uri(
                "https://docs.openclaw.ai",
                gio::AppLaunchContext::NONE,
            );
        });
        app.add_action(&docs_action);

        // Keyboard shortcuts
        app.set_accels_for_action("app.about", &["<primary>question"]);
        app.set_accels_for_action("app.preferences", &["<primary>comma"]);
        app.set_accels_for_action("window.close", &["<primary>w"]);
    }

    fn setup_menu(app: &adw::Application) {
        let menu = gio::Menu::new();

        let section1 = gio::Menu::new();
        section1.append(Some("_Preferences"), Some("app.preferences"));
        section1.append(Some("_Documentation"), Some("app.docs"));
        menu.append_section(None, &section1);

        let section2 = gio::Menu::new();
        section2.append(Some("_About OpenClaw"), Some("app.about"));
        menu.append_section(None, &section2);

        app.set_menubar(Some(&menu));
    }

    pub fn run(&self) -> glib::ExitCode {
        self.app.run()
    }
}
