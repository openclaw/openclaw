#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::ErrorKind,
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, OnceLock,
    },
    thread,
    time::Duration,
};

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WindowEvent,
};
use url::Url;

const DEFAULT_GATEWAY_HOST: &str = "127.0.0.1";
const DEFAULT_GATEWAY_PORT: u16 = 18_789;
const GATEWAY_STATUS_EVENT: &str = "gateway-status";
const TRAY_ID: &str = "gateway-tray";
const MENU_OPEN_DASHBOARD: &str = "open-dashboard";
const MENU_GATEWAY_STATUS: &str = "gateway-status";
const MENU_RESTART_GATEWAY: &str = "restart-gateway";
const MENU_QUIT: &str = "quit";

#[derive(Clone)]
struct GatewayConfig {
    config_path: PathBuf,
    host: String,
    port: u16,
    tls_enabled: bool,
    token: Option<String>,
    warning: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewaySnapshot {
    config_path: String,
    connected: bool,
    dashboard_url: String,
    error: Option<String>,
    health_url: String,
    host: String,
    port: u16,
    scheme: String,
    status_label: String,
    token_detected: bool,
    ws_url: String,
}

#[tauri::command]
fn get_gateway_snapshot() -> GatewaySnapshot {
    collect_snapshot()
}

#[tauri::command]
fn restart_gateway(app: AppHandle) -> GatewaySnapshot {
    let snapshot = restart_gateway_now();
    let _ = app.emit(GATEWAY_STATUS_EVENT, snapshot.clone());
    snapshot
}

fn main() {
    let quit_requested = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        .setup({
            let quit_requested = Arc::clone(&quit_requested);
            move |app| {
                let open_item = MenuItem::with_id(
                    app,
                    MENU_OPEN_DASHBOARD,
                    "Open Dashboard",
                    true,
                    None::<&str>,
                )?;
                let status_item = MenuItem::with_id(
                    app,
                    MENU_GATEWAY_STATUS,
                    "Gateway Status: Checking...",
                    false,
                    None::<&str>,
                )?;
                let restart_item = MenuItem::with_id(
                    app,
                    MENU_RESTART_GATEWAY,
                    "Restart Gateway",
                    true,
                    None::<&str>,
                )?;
                let quit_item = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
                let separator = PredefinedMenuItem::separator(app)?;
                let menu = Menu::with_items(
                    app,
                    &[
                        &open_item,
                        &status_item,
                        &separator,
                        &restart_item,
                        &quit_item,
                    ],
                )?;

                TrayIconBuilder::with_id(TRAY_ID)
                    .icon(build_status_icon(false))
                    .menu(&menu)
                    .tooltip("OpenClaw Desktop")
                    .show_menu_on_left_click(true)
                    .on_menu_event({
                        let quit_requested = Arc::clone(&quit_requested);
                        let status_item = status_item.clone();
                        move |app, event| match event.id.as_ref() {
                            MENU_OPEN_DASHBOARD => show_main_window(app),
                            MENU_RESTART_GATEWAY => {
                                let app = app.clone();
                                let status_item = status_item.clone();
                                thread::spawn(move || {
                                    let snapshot = restart_gateway_now();
                                    let _ = update_tray(&app, &status_item, &snapshot);
                                    let _ = app.emit(GATEWAY_STATUS_EVENT, snapshot);
                                });
                            }
                            MENU_QUIT => {
                                quit_requested.store(true, Ordering::SeqCst);
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            show_main_window(&tray.app_handle());
                        }
                    })
                    .build(app)?;

                let initial_snapshot = collect_snapshot();
                update_tray(&app.handle(), &status_item, &initial_snapshot)?;
                start_gateway_monitor(app.handle().clone(), status_item);

                if let Some(window) = app.get_webview_window("main") {
                    let hide_window = window.clone();
                    let quit_requested = Arc::clone(&quit_requested);
                    window.on_window_event(move |event| {
                        if let WindowEvent::CloseRequested { api, .. } = event {
                            if quit_requested.load(Ordering::SeqCst) {
                                return;
                            }
                            api.prevent_close();
                            let _ = hide_window.hide();
                        }
                    });
                }

                Ok(())
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_gateway_snapshot,
            restart_gateway
        ])
        .run(tauri::generate_context!())
        .expect("error while running OpenClaw Desktop");
}

fn start_gateway_monitor<R: Runtime>(app: AppHandle<R>, status_item: MenuItem<R>) {
    thread::spawn(move || loop {
        let snapshot = collect_snapshot();
        let _ = update_tray(&app, &status_item, &snapshot);
        let _ = app.emit(GATEWAY_STATUS_EVENT, snapshot);
        thread::sleep(Duration::from_secs(5));
    });
}

fn collect_snapshot() -> GatewaySnapshot {
    let config = GatewayConfig::load();
    let ws_url = build_ws_url(&config);
    let health_url = build_health_url(&config);
    let (dashboard_url, dashboard_error) = match build_dashboard_url(&config) {
        Ok(url) => (url, None),
        Err(err) => (String::from("about:blank"), Some(err)),
    };

    let probe_error = probe_gateway_health(&health_url).err();
    let connected = dashboard_error.is_none() && probe_error.is_none();
    let error = combine_messages(
        config.warning.clone(),
        combine_messages(dashboard_error, probe_error),
    );
    let status_label = if connected {
        format!("Gateway Connected · {}:{}", config.host, config.port)
    } else {
        format!("Gateway Disconnected · {}:{}", config.host, config.port)
    };

    GatewaySnapshot {
        config_path: config.config_path.display().to_string(),
        connected,
        dashboard_url,
        error,
        health_url,
        host: config.host.clone(),
        port: config.port,
        scheme: config.ws_scheme().to_string(),
        status_label,
        token_detected: config.token.is_some(),
        ws_url,
    }
}

fn restart_gateway_now() -> GatewaySnapshot {
    let restart_error = run_gateway_restart().err();
    let mut snapshot = collect_snapshot();
    if let Some(restart_error) = restart_error {
        snapshot.error = combine_messages(Some(restart_error), snapshot.error);
        snapshot.status_label = format!(
            "Gateway Restart Failed · {}:{}",
            snapshot.host, snapshot.port
        );
    }
    snapshot
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn update_tray<R: Runtime>(
    app: &AppHandle<R>,
    status_item: &MenuItem<R>,
    snapshot: &GatewaySnapshot,
) -> tauri::Result<()> {
    let status_text = if snapshot.connected {
        "Gateway Status: Connected"
    } else {
        "Gateway Status: Disconnected"
    };
    status_item.set_text(status_text)?;

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tooltip = if snapshot.connected {
            format!(
                "OpenClaw Desktop\nGateway connected at {}:{}",
                snapshot.host, snapshot.port
            )
        } else {
            format!(
                "OpenClaw Desktop\nGateway disconnected at {}:{}",
                snapshot.host, snapshot.port
            )
        };
        tray.set_icon(Some(build_status_icon(snapshot.connected)))?;
        tray.set_tooltip(Some(tooltip))?;
    }

    Ok(())
}

impl GatewayConfig {
    fn load() -> Self {
        let config_path = resolve_config_path();
        let mut warning = None;

        let config_value = match fs::read_to_string(&config_path) {
            Ok(raw) => match serde_json::from_str::<Value>(&raw) {
                Ok(parsed) => parsed,
                Err(error) => {
                    append_message(
                        &mut warning,
                        format!(
                            "Failed to parse {}: {}. Falling back to loopback defaults.",
                            config_path.display(),
                            error
                        ),
                    );
                    Value::Null
                }
            },
            Err(error) if error.kind() == ErrorKind::NotFound => {
                append_message(
                    &mut warning,
                    format!(
                        "Config file not found at {}. Falling back to loopback defaults.",
                        config_path.display()
                    ),
                );
                Value::Null
            }
            Err(error) => {
                append_message(
                    &mut warning,
                    format!(
                        "Failed to read {}: {}. Falling back to loopback defaults.",
                        config_path.display(),
                        error
                    ),
                );
                Value::Null
            }
        };

        let port = read_env_port(&mut warning).or_else(|| {
            config_value
                .pointer("/gateway/port")
                .and_then(Value::as_u64)
                .and_then(|value| u16::try_from(value).ok())
        });

        let tls_enabled = read_env_bool("OPENCLAW_GATEWAY_TLS", &mut warning)
            .or_else(|| {
                config_value
                    .pointer("/gateway/tls/enabled")
                    .and_then(Value::as_bool)
            })
            .unwrap_or(false);

        let bind_mode = config_value
            .pointer("/gateway/bind")
            .and_then(Value::as_str);
        let custom_bind_host = config_value
            .pointer("/gateway/customBindHost")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);

        let host = if matches!(bind_mode, Some("custom")) {
            custom_bind_host.unwrap_or_else(|| {
                append_message(
                    &mut warning,
                    "gateway.bind is set to custom but gateway.customBindHost is missing. Using 127.0.0.1."
                        .to_string(),
                );
                DEFAULT_GATEWAY_HOST.to_string()
            })
        } else {
            DEFAULT_GATEWAY_HOST.to_string()
        };

        let token = std::env::var("OPENCLAW_GATEWAY_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                config_value
                    .pointer("/gateway/auth/token")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
            });

        Self {
            config_path,
            host,
            port: port.unwrap_or(DEFAULT_GATEWAY_PORT),
            tls_enabled,
            token,
            warning,
        }
    }

    fn http_scheme(&self) -> &'static str {
        if self.tls_enabled {
            "https"
        } else {
            "http"
        }
    }

    fn ws_scheme(&self) -> &'static str {
        if self.tls_enabled {
            "wss"
        } else {
            "ws"
        }
    }
}

fn resolve_config_path() -> PathBuf {
    if let Ok(path) = std::env::var("OPENCLAW_CONFIG_PATH") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Some(home) = dirs::home_dir() {
        return home.join(".openclaw").join("openclaw.json");
    }

    PathBuf::from("~/.openclaw/openclaw.json")
}

fn read_env_port(warning: &mut Option<String>) -> Option<u16> {
    let raw = std::env::var("OPENCLAW_GATEWAY_PORT").ok()?;
    match raw.trim().parse::<u16>() {
        Ok(port) => Some(port),
        Err(error) => {
            append_message(
                warning,
                format!(
                    "OPENCLAW_GATEWAY_PORT={} is invalid ({}). Using config or default port.",
                    raw.trim(),
                    error
                ),
            );
            None
        }
    }
}

fn read_env_bool(name: &str, warning: &mut Option<String>) -> Option<bool> {
    let raw = std::env::var(name).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => {
            append_message(
                warning,
                format!(
                    "{}={} is invalid. Expected true/false, 1/0, yes/no, or on/off.",
                    name,
                    raw.trim()
                ),
            );
            None
        }
    }
}

fn format_host_for_url(host: &str) -> String {
    // Bracket bare IPv6 literals so they parse in URLs (e.g. ::1 -> [::1]).
    let already_bracketed = host.starts_with('[') && host.ends_with(']');
    if !already_bracketed && host.contains(':') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

fn build_ws_url(config: &GatewayConfig) -> String {
    format!(
        "{}://{}:{}",
        config.ws_scheme(),
        format_host_for_url(&config.host),
        config.port
    )
}

fn build_health_url(config: &GatewayConfig) -> String {
    format!(
        "{}://{}:{}/health",
        config.http_scheme(),
        format_host_for_url(&config.host),
        config.port
    )
}

fn build_dashboard_url(config: &GatewayConfig) -> Result<String, String> {
    let base = format!(
        "{}://{}:{}/",
        config.http_scheme(),
        format_host_for_url(&config.host),
        config.port
    );
    let mut url =
        Url::parse(&base).map_err(|error| format!("Invalid gateway URL {base:?}: {error}"))?;
    if let Some(token) = &config.token {
        url.set_fragment(Some(&format!("token={token}")));
    }
    Ok(url.to_string())
}

fn health_client() -> Result<&'static Client, String> {
    static CLIENT: OnceLock<Result<Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            Client::builder()
                .timeout(Duration::from_secs(2))
                .build()
                .map_err(|error| format!("Failed to create health client: {error}"))
        })
        .as_ref()
        .map_err(|error| error.clone())
}

fn probe_gateway_health(health_url: &str) -> Result<(), String> {
    let client = health_client()?;

    let response = client
        .get(health_url)
        .send()
        .map_err(|error| format!("Health probe to {health_url} failed: {error}"))?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Gateway health probe returned HTTP {} for {health_url}.",
            response.status()
        ))
    }
}

#[cfg(target_os = "windows")]
fn run_gateway_restart() -> Result<(), String> {
    let status = Command::new("cmd")
        .args(["/C", "openclaw", "gateway", "restart"])
        .status()
        .map_err(|error| format!("Failed to run `openclaw gateway restart`: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "`openclaw gateway restart` exited with status {status}."
        ))
    }
}

#[cfg(not(target_os = "windows"))]
fn run_gateway_restart() -> Result<(), String> {
    let status = Command::new("sh")
        .args(["-lc", "openclaw gateway restart"])
        .status()
        .map_err(|error| format!("Failed to run `openclaw gateway restart`: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "`openclaw gateway restart` exited with status {status}."
        ))
    }
}

fn append_message(target: &mut Option<String>, message: String) {
    match target {
        Some(existing) => {
            existing.push(' ');
            existing.push_str(&message);
        }
        None => *target = Some(message),
    }
}

fn combine_messages(first: Option<String>, second: Option<String>) -> Option<String> {
    match (first, second) {
        (Some(first), Some(second)) => Some(format!("{first} {second}")),
        (Some(first), None) => Some(first),
        (None, Some(second)) => Some(second),
        (None, None) => None,
    }
}

fn build_status_icon(connected: bool) -> Image<'static> {
    const SIZE: u32 = 16;
    const CENTER: f32 = 7.5;
    const RADIUS: f32 = 5.4;
    const OUTLINE_RADIUS: f32 = 6.3;

    let (red, green, blue) = if connected {
        (34u8, 197u8, 94u8)
    } else {
        (244u8, 63u8, 94u8)
    };

    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f32 - CENTER;
            let dy = y as f32 - CENTER;
            let distance = (dx * dx + dy * dy).sqrt();
            let index = ((y * SIZE + x) * 4) as usize;

            if distance <= RADIUS {
                rgba[index] = red;
                rgba[index + 1] = green;
                rgba[index + 2] = blue;
                rgba[index + 3] = 255;
            } else if distance <= OUTLINE_RADIUS {
                rgba[index] = 255;
                rgba[index + 1] = 255;
                rgba[index + 2] = 255;
                rgba[index + 3] = 190;
            }
        }
    }

    Image::new_owned(rgba, SIZE, SIZE)
}
