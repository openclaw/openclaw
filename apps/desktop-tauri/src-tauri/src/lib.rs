use flate2::read::GzDecoder;
use serde::Serialize;
use std::fs::{self, File};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tar::Archive;
use tauri::menu::MenuBuilder;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

type GatewayChild = Arc<Mutex<Option<CommandChild>>>;
type QuitFlag = Arc<Mutex<bool>>;

const LOCAL_GATEWAY_HOST: &str = "127.0.0.1";
const LOCAL_GATEWAY_PORT: u16 = 18789;
const LOADING_PAGE: &str = "loading.html";
const DESKTOP_CONTROL_UI_ALLOWED_ORIGINS: [&str; 3] = [
    "http://tauri.localhost",
    "http://127.0.0.1:18789",
    "http://localhost:18789",
];

struct DesktopState {
    gateway: GatewayChild,
    quitting: QuitFlag,
}

#[derive(Serialize)]
struct GatewayBootstrap {
    gateway_url: String,
    auth_mode: Option<String>,
    token: Option<String>,
    password: Option<String>,
}

// ──────────────────────────────────────────
// IPC Commands
// ──────────────────────────────────────────

#[tauri::command]
fn check_onboarding_needed() -> bool {
    match read_config_value_from_file() {
        Some(config) => !is_desktop_onboarding_complete(&config),
        None => true,
    }
}

#[tauri::command]
fn write_config(json: String) -> Result<(), String> {
    write_merged_config_value(
        serde_json::from_str(&json).map_err(|e| format!("Invalid JSON: {e}"))?,
    )
    .map(|_| ())
}

fn write_merged_config_value(new_val: serde_json::Value) -> Result<serde_json::Value, String> {
    let path = config_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let merged = if path.exists() {
        let existing: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap_or_default())
                .unwrap_or(serde_json::json!({}));
        let mut m = existing;
        json_merge(&mut m, new_val);
        normalize_desktop_config(&mut m);
        m
    } else {
        let mut m = new_val;
        normalize_desktop_config(&mut m);
        m
    };
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(merged)
}

fn ensure_desktop_bootstrap_config() -> Result<bool, String> {
    if let Some(config) = read_config_value_from_file() {
        if is_desktop_onboarding_complete(&config) {
            return Ok(false);
        }
    }
    write_merged_config_value(serde_json::json!({
        "gateway": {
            "mode": "local",
            "bind": "loopback",
            "port": LOCAL_GATEWAY_PORT,
            "auth": {
                "mode": "none"
            },
            "tailscale": {
                "mode": "off",
                "resetOnExit": false
            }
        },
        "wizard": {
            "lastRunCommand": "desktop-auto-bootstrap",
            "lastRunMode": "local"
        }
    }))?;
    Ok(true)
}

/// Called from the desktop loading page to make sure the bundled gateway is
/// starting. The page owns readiness polling and navigation so WebView stays
/// responsive during slow gateway startup.
#[tauri::command]
fn open_control_ui(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    let gateway = state.gateway.clone();
    thread::spawn(move || {
        match ensure_gateway_running(&app, gateway) {
            Ok(()) => {
                let _ = window.eval(&format!(
                    "window.__OPENCLAW_GATEWAY_READY = true; window.location.replace('http://{LOCAL_GATEWAY_HOST}:{LOCAL_GATEWAY_PORT}');"
                ));
            }
            Err(err) => {
                log::warn!("Gateway startup failed after onboarding: {err}");
                let safe_err = err.replace('\\', "\\\\").replace('\'', "\\'");
                let _ = window
                    .eval(&format!("window.__OPENCLAW_GATEWAY_START_ERROR = '{safe_err}';"));
            }
        }
    });
    Ok(())
}

#[tauri::command]
fn bootstrap_gateway_access(
    app: tauri::AppHandle,
    state: tauri::State<'_, DesktopState>,
) -> Result<GatewayBootstrap, String> {
    let auth_mode = read_gateway_auth_mode_from_file();
    let token = read_gateway_token_from_config();
    let password = read_gateway_password_from_config();
    if token.is_some() || password.is_some() || matches!(auth_mode.as_deref(), Some("none")) {
        ensure_gateway_running(&app, state.gateway.clone())?;
    }
    Ok(GatewayBootstrap {
        gateway_url: format!("ws://{LOCAL_GATEWAY_HOST}:{LOCAL_GATEWAY_PORT}"),
        auth_mode: auth_mode.clone(),
        token,
        password,
    })
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

fn config_path() -> PathBuf {
    resolve_home_dir().join(".openclaw").join("openclaw.json")
}

fn resolve_home_dir() -> PathBuf {
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        if !user_profile.trim().is_empty() {
            return PathBuf::from(user_profile);
        }
    }
    if let (Ok(home_drive), Ok(home_path)) = (std::env::var("HOMEDRIVE"), std::env::var("HOMEPATH"))
    {
        let combined = format!("{home_drive}{home_path}");
        if !combined.trim().is_empty() {
            return PathBuf::from(combined);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Ok(app_data) = std::env::var("APPDATA") {
        let path = PathBuf::from(app_data);
        if let Some(parent) = path.parent() {
            return parent.to_path_buf();
        }
    }
    PathBuf::from("C:\\Users\\Default")
}

fn json_merge(dst: &mut serde_json::Value, src: serde_json::Value) {
    match (dst, src) {
        (serde_json::Value::Object(d), serde_json::Value::Object(s)) => {
            for (k, v) in s {
                json_merge(d.entry(k).or_insert(serde_json::Value::Null), v);
            }
        }
        (dst, src) => *dst = src,
    }
}

fn read_config_value_from_file() -> Option<serde_json::Value> {
    let path = config_path();
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_trimmed_string_pointer<'a>(
    config: &'a serde_json::Value,
    pointer: &str,
) -> Option<&'a str> {
    config
        .pointer(pointer)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn resolve_primary_model_ref(config: &serde_json::Value) -> Option<String> {
    if let Some(primary) = read_trimmed_string_pointer(config, "/agents/defaults/model/primary") {
        return Some(primary.to_string());
    }
    read_trimmed_string_pointer(config, "/agents/defaults/model").map(str::to_string)
}

fn is_desktop_onboarding_complete(config: &serde_json::Value) -> bool {
    let model_setup_skipped = config
        .pointer("/wizard/lastRunCommand")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .is_some_and(|value| {
            matches!(
                value,
                "desktop-onboard-skip-model" | "desktop-auto-bootstrap"
            )
        });
    read_trimmed_string_pointer(config, "/gateway/mode").is_some()
        && read_trimmed_string_pointer(config, "/gateway/auth/mode").is_some()
        && (resolve_primary_model_ref(config).is_some() || model_setup_skipped)
}

fn read_nonempty_secret_from_config(
    config: &serde_json::Value,
    pointers: &[&str],
) -> Option<String> {
    for pointer in pointers {
        let Some(raw) = config
            .pointer(pointer)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if raw.starts_with("${") && raw.ends_with('}') {
            let env_name = raw
                .trim_start_matches("${")
                .trim_end_matches('}')
                .trim()
                .to_string();
            if env_name.is_empty() {
                return None;
            }
            if let Ok(value) = std::env::var(&env_name) {
                let trimmed = value.trim();
                if !trimmed.is_empty() {
                    return Some(trimmed.to_string());
                }
            }
            continue;
        }
        return Some(raw.to_string());
    }
    None
}

fn read_gateway_auth_mode(config: &serde_json::Value) -> Option<String> {
    config
        .pointer("/gateway/auth/mode")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn read_gateway_auth_mode_from_file() -> Option<String> {
    let path = config_path();
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    read_gateway_auth_mode(&parsed)
}

fn read_gateway_token_from_config() -> Option<String> {
    let path = config_path();
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    match read_gateway_auth_mode(&parsed).as_deref() {
        Some("token") | None => {}
        Some(_) => return None,
    }
    read_nonempty_secret_from_config(&parsed, &["/gateway/auth/token", "/auth/token"])
}

fn read_gateway_password_from_config() -> Option<String> {
    let path = config_path();
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if !matches!(read_gateway_auth_mode(&parsed).as_deref(), Some("password")) {
        return None;
    }
    read_nonempty_secret_from_config(&parsed, &["/gateway/auth/password"])
}

fn read_nonempty_plain_token(config: &serde_json::Value, pointer: &str) -> Option<String> {
    let token = config
        .pointer(pointer)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    if token.starts_with("${") && token.ends_with('}') {
        return None;
    }
    Some(token.to_string())
}

fn migrate_legacy_auth_token(config: &mut serde_json::Value) {
    if read_nonempty_plain_token(config, "/gateway/auth/token").is_some() {
        return;
    }
    let mode = config
        .pointer("/gateway/auth/mode")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("token");
    if mode != "token" && !mode.is_empty() {
        return;
    }
    let Some(legacy_token) = read_nonempty_plain_token(config, "/auth/token") else {
        return;
    };
    json_merge(
        config,
        serde_json::json!({
            "gateway": {
                "auth": {
                    "mode": "token",
                    "token": legacy_token
                }
            }
        }),
    );
}

fn seed_desktop_gateway_defaults(config: &mut serde_json::Value) -> bool {
    let mut patch = serde_json::Map::new();
    let mut gateway_patch = serde_json::Map::new();

    if read_trimmed_string_pointer(config, "/gateway/mode").is_none() {
        gateway_patch.insert(
            "mode".to_string(),
            serde_json::Value::String("local".to_string()),
        );
    }

    let gateway_mode = read_trimmed_string_pointer(config, "/gateway/mode").unwrap_or("local");
    if gateway_mode == "local" {
        if read_trimmed_string_pointer(config, "/gateway/bind").is_none() {
            gateway_patch.insert(
                "bind".to_string(),
                serde_json::Value::String("loopback".to_string()),
            );
        }
        if config
            .pointer("/gateway/port")
            .and_then(|value| value.as_u64())
            .is_none()
        {
            gateway_patch.insert(
                "port".to_string(),
                serde_json::Value::Number(serde_json::Number::from(LOCAL_GATEWAY_PORT)),
            );
        }
    }

    if gateway_patch.is_empty() {
        return false;
    }

    patch.insert(
        "gateway".to_string(),
        serde_json::Value::Object(gateway_patch),
    );
    json_merge(config, serde_json::Value::Object(patch));
    true
}

fn should_seed_desktop_control_ui_allowed_origins(config: &serde_json::Value) -> bool {
    let gateway_mode = config
        .pointer("/gateway/mode")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("local");
    if gateway_mode != "local" {
        return false;
    }
    let bind = config
        .pointer("/gateway/bind")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("loopback");
    bind == "loopback"
}

fn seed_desktop_control_ui_allowed_origins(config: &mut serde_json::Value) -> bool {
    if !should_seed_desktop_control_ui_allowed_origins(config) {
        return false;
    }

    let mut next = config
        .pointer("/gateway/controlUi/allowedOrigins")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut changed = false;

    for origin in DESKTOP_CONTROL_UI_ALLOWED_ORIGINS {
        let already_present = next
            .iter()
            .any(|value| value.as_str().map(str::trim) == Some(origin));
        if !already_present {
            next.push(serde_json::Value::String(origin.to_string()));
            changed = true;
        }
    }

    if changed {
        json_merge(
            config,
            serde_json::json!({
                "gateway": {
                    "controlUi": {
                        "allowedOrigins": next
                    }
                }
            }),
        );
    }

    changed
}

fn normalize_desktop_config(config: &mut serde_json::Value) -> bool {
    let before = config.clone();
    seed_desktop_gateway_defaults(config);
    migrate_legacy_auth_token(config);
    seed_desktop_control_ui_allowed_origins(config);
    *config != before
}

fn maybe_migrate_config_file() -> Result<bool, String> {
    let path = config_path();
    if !path.exists() {
        return Ok(false);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Invalid config JSON: {e}"))?;
    if !normalize_desktop_config(&mut parsed) {
        return Ok(false);
    }
    std::fs::write(
        &path,
        serde_json::to_string_pretty(&parsed).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

fn should_start_desktop_gateway() -> bool {
    matches!(read_gateway_auth_mode_from_file().as_deref(), Some("none"))
        || read_gateway_token_from_config().is_some()
        || read_gateway_password_from_config().is_some()
}

fn wait_for_local_gateway_ready(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let addr: SocketAddr = format!("{LOCAL_GATEWAY_HOST}:{LOCAL_GATEWAY_PORT}")
        .parse()
        .expect("hardcoded gateway socket address");
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_ok() {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

fn runtime_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = app.path().app_local_data_dir() {
        return Ok(path.join("runtime").join(env!("CARGO_PKG_VERSION")));
    }
    Ok(resolve_home_dir()
        .join(".openclaw-desktop")
        .join("runtime")
        .join(env!("CARGO_PKG_VERSION")))
}

fn ensure_bundled_runtime_ready(
    app: &tauri::AppHandle,
    archive_path: &PathBuf,
) -> Result<PathBuf, String> {
    let runtime_dir = runtime_cache_dir(app)?;
    let ready_marker = runtime_dir.join(".runtime-ready");
    let index_js = runtime_dir.join("dist").join("index.js");
    if ready_marker.exists() && index_js.exists() {
        return Ok(runtime_dir);
    }

    if runtime_dir.exists() {
        fs::remove_dir_all(&runtime_dir).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(&runtime_dir).map_err(|e| e.to_string())?;

    let archive_file = File::open(archive_path).map_err(|e| e.to_string())?;
    let decoder = GzDecoder::new(archive_file);
    let mut archive = Archive::new(decoder);
    archive.unpack(&runtime_dir).map_err(|e| e.to_string())?;
    fs::write(&ready_marker, env!("CARGO_PKG_VERSION")).map_err(|e| e.to_string())?;

    Ok(runtime_dir)
}

fn resolve_gateway_runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let bundled_archive = resource_dir.join("openclaw-runtime.tar.gz");
    if bundled_archive.exists() {
        return ensure_bundled_runtime_ready(app, &bundled_archive);
    }

    let dev_index_js = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../dist")
        .join("index.js");
    if dev_index_js.exists() {
        return dev_index_js
            .parent()
            .and_then(|p| p.parent())
            .map(PathBuf::from)
            .ok_or_else(|| "Unable to resolve gateway runtime directory".to_string());
    }

    Err("Gateway runtime archive not found in app resources".to_string())
}

fn desktop_gateway_startup_patience() -> Duration {
    if cfg!(windows) {
        Duration::from_secs(150)
    } else {
        Duration::from_secs(75)
    }
}

fn ensure_gateway_running(app: &tauri::AppHandle, child_arc: GatewayChild) -> Result<(), String> {
    // Reuse an already-running local gateway instead of spawning a duplicate
    // desktop-managed instance that will just fail on the same port.
    if wait_for_local_gateway_ready(Duration::from_millis(400)) {
        log::info!("Reusing existing local gateway on {LOCAL_GATEWAY_HOST}:{LOCAL_GATEWAY_PORT}.");
        return Ok(());
    }
    if child_arc.lock().map_err(|e| e.to_string())?.is_some() {
        if wait_for_local_gateway_ready(Duration::from_millis(400)) {
            return Ok(());
        }
        log::info!("Gateway startup already in progress.");
        return Ok(());
    }
    let runtime_dir = resolve_gateway_runtime_dir(app)?;
    let index_js = runtime_dir.join("dist").join("index.js");
    if !index_js.exists() {
        return Err("Gateway index.js not found in runtime directory".to_string());
    }
    let sidecar = app
        .shell()
        .sidecar("node")
        .map_err(|e| format!("Gateway sidecar unavailable: {e}"))?;
    let port = LOCAL_GATEWAY_PORT.to_string();
    let mut guard = child_arc.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        log::info!("Gateway startup already in progress.");
        return Ok(());
    }
    let (rx, proc) = sidecar
        .current_dir(&runtime_dir)
        .args(["dist/index.js", "gateway", "run", "--port", port.as_str()])
        .spawn()
        .map_err(|e| format!("Gateway start failed: {e}"))?;
    let pid = proc.pid();
    log::info!("Gateway pid={pid}, cwd={}", runtime_dir.to_string_lossy());
    *guard = Some(proc);
    drop(guard);
    let child_for_events = child_arc.clone();
    tauri::async_runtime::spawn(async move {
        let mut rx = rx;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let text = String::from_utf8_lossy(&line).trim().to_string();
                    if !text.is_empty() {
                        log::info!("Gateway[{pid}] stdout: {text}");
                    }
                }
                CommandEvent::Stderr(line) => {
                    let text = String::from_utf8_lossy(&line).trim().to_string();
                    if !text.is_empty() {
                        log::warn!("Gateway[{pid}] stderr: {text}");
                    }
                }
                CommandEvent::Error(err) => {
                    log::error!("Gateway[{pid}] event error: {err}");
                }
                CommandEvent::Terminated(payload) => {
                    log::warn!(
                        "Gateway[{pid}] terminated: code={:?} signal={:?}",
                        payload.code,
                        payload.signal
                    );
                    if let Ok(mut guard) = child_for_events.lock() {
                        let should_clear = guard
                            .as_ref()
                            .map(|child| child.pid() == pid)
                            .unwrap_or(false);
                        if should_clear {
                            *guard = None;
                        }
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    let startup_patience = desktop_gateway_startup_patience();
    if !wait_for_local_gateway_ready(startup_patience) {
        let still_starting = child_arc
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .map(|child| child.pid() == pid)
            .unwrap_or(false);
        if still_starting {
            log::warn!(
                "Gateway startup is still in progress after {:?}; leaving pid={} running and letting the desktop UI keep retrying.",
                startup_patience,
                pid
            );
            return Ok(());
        }
        return Err(format!(
            "Gateway start timed out waiting for {LOCAL_GATEWAY_HOST}:{LOCAL_GATEWAY_PORT}"
        ));
    }
    Ok(())
}

fn stop_gateway_process(child_arc: GatewayChild) {
    if let Ok(mut guard) = child_arc.lock() {
        if let Some(proc) = guard.take() {
            log::info!("Stopping gateway...");
            let _ = proc.kill();
        }
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "windows")]
        {
            let _ = window.set_always_on_top(true);
            let window_for_reset = window.clone();
            tauri::async_runtime::spawn(async move {
                std::thread::sleep(Duration::from_millis(500));
                let _ = window_for_reset.set_always_on_top(false);
                let _ = window_for_reset.set_focus();
            });
        }
    }
}

fn request_app_exit(app: &tauri::AppHandle) {
    {
        let state = app.state::<DesktopState>();
        if let Ok(mut quitting) = state.quitting.lock() {
            *quitting = true;
        }
        stop_gateway_process(state.gateway.clone());
    }
    app.exit(0);
}

fn is_background_startup() -> bool {
    std::env::args_os().any(|arg| arg == std::ffi::OsStr::new("--background-startup"))
}

// ──────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::{
        is_desktop_onboarding_complete, normalize_desktop_config,
        seed_desktop_control_ui_allowed_origins, DESKTOP_CONTROL_UI_ALLOWED_ORIGINS,
        LOCAL_GATEWAY_PORT,
    };

    #[test]
    fn desktop_onboarding_requires_gateway_mode_auth_mode_and_primary_model() {
        let ready = serde_json::json!({
            "gateway": {
                "mode": "local",
                "auth": {
                    "mode": "none"
                }
            },
            "agents": {
                "defaults": {
                    "model": {
                        "primary": "openai/gpt-5.4"
                    }
                }
            }
        });
        let missing_auth = serde_json::json!({
            "gateway": {
                "mode": "local"
            },
            "agents": {
                "defaults": {
                    "model": {
                        "primary": "openai/gpt-5.4"
                    }
                }
            }
        });
        let skipped_model_setup = serde_json::json!({
            "gateway": {
                "mode": "local",
                "auth": {
                    "mode": "none"
                }
            },
            "wizard": {
                "lastRunCommand": "desktop-onboard-skip-model",
                "lastRunMode": "local"
            }
        });
        let auto_bootstrapped = serde_json::json!({
            "gateway": {
                "mode": "local",
                "auth": {
                    "mode": "none"
                }
            },
            "wizard": {
                "lastRunCommand": "desktop-auto-bootstrap",
                "lastRunMode": "local"
            }
        });

        assert!(is_desktop_onboarding_complete(&ready));
        assert!(is_desktop_onboarding_complete(&skipped_model_setup));
        assert!(is_desktop_onboarding_complete(&auto_bootstrapped));
        assert!(!is_desktop_onboarding_complete(&missing_auth));
    }

    #[test]
    fn normalize_desktop_config_seeds_tauri_control_ui_origins_for_local_loopback() {
        let mut config = serde_json::json!({
            "gateway": {
                "mode": "local",
                "bind": "loopback",
                "auth": {
                    "mode": "token",
                    "token": "secret"
                }
            }
        });

        let changed = normalize_desktop_config(&mut config);
        let origins = config["gateway"]["controlUi"]["allowedOrigins"]
            .as_array()
            .expect("allowedOrigins should be an array");

        assert!(changed);
        for origin in DESKTOP_CONTROL_UI_ALLOWED_ORIGINS {
            assert!(origins.iter().any(|value| value.as_str() == Some(origin)));
        }
    }

    #[test]
    fn seed_desktop_control_ui_allowed_origins_preserves_existing_entries_without_duplicates() {
        let mut config = serde_json::json!({
            "gateway": {
                "mode": "local",
                "bind": "loopback",
                "controlUi": {
                    "allowedOrigins": [
                        "http://tauri.localhost",
                        "https://control.example.com"
                    ]
                }
            }
        });

        let changed = seed_desktop_control_ui_allowed_origins(&mut config);
        let origins = config["gateway"]["controlUi"]["allowedOrigins"]
            .as_array()
            .expect("allowedOrigins should be an array");

        assert!(changed);
        assert_eq!(
            origins
                .iter()
                .filter(|value| value.as_str() == Some("http://tauri.localhost"))
                .count(),
            1
        );
        assert!(origins
            .iter()
            .any(|value| value.as_str() == Some("https://control.example.com")));
    }

    #[test]
    fn normalize_desktop_config_skips_remote_gateway_configs() {
        let mut config = serde_json::json!({
            "gateway": {
                "mode": "remote"
            }
        });

        let changed = normalize_desktop_config(&mut config);

        assert!(!changed);
        assert!(config["gateway"]["controlUi"]["allowedOrigins"].is_null());
    }

    #[test]
    fn normalize_desktop_config_backfills_local_gateway_defaults() {
        let mut config = serde_json::json!({
            "gateway": {
                "auth": {
                    "mode": "none"
                }
            }
        });

        let changed = normalize_desktop_config(&mut config);

        assert!(changed);
        assert_eq!(config["gateway"]["mode"], "local");
        assert_eq!(config["gateway"]["bind"], "loopback");
        assert_eq!(config["gateway"]["port"], LOCAL_GATEWAY_PORT);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let child: GatewayChild = Arc::new(Mutex::new(None));
    let quitting: QuitFlag = Arc::new(Mutex::new(false));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .manage(DesktopState {
            gateway: child,
            quitting,
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray_show" => show_main_window(app),
            "tray_quit" => request_app_exit(app),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            check_onboarding_needed,
            write_config,
            open_control_ui,
            bootstrap_gateway_access,
        ])
        .setup(|app| {
            let background_startup = is_background_startup();
            match maybe_migrate_config_file() {
                Ok(true) => {
                    log::info!("Normalized desktop config for local Tauri startup.");
                }
                Ok(false) => {}
                Err(err) => {
                    log::warn!("Desktop config normalization skipped: {err}");
                }
            }
            match ensure_desktop_bootstrap_config() {
                Ok(true) => {
                    log::info!("Created desktop bootstrap config for local Control UI startup.");
                }
                Ok(false) => {}
                Err(err) => {
                    log::warn!("Desktop bootstrap config failed: {err}");
                }
            }
            log::info!("Desktop config path: {}", config_path().to_string_lossy());
            let needs_onboard = check_onboarding_needed();
            if needs_onboard {
                log::info!("Desktop bootstrap is required; the main window will open loading.html.");
            }

            // Launch gateway sidecar
            if should_start_desktop_gateway() {
                let app_handle = app.handle().clone();
                let gateway = app.state::<DesktopState>().gateway.clone();
                thread::spawn(move || {
                    match ensure_gateway_running(&app_handle, gateway) {
                        Ok(()) => {
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.eval(&format!(
                                    "window.__OPENCLAW_GATEWAY_READY = true; if (window.location.href.includes('{LOADING_PAGE}')) {{ window.location.replace('http://{LOCAL_GATEWAY_HOST}:{LOCAL_GATEWAY_PORT}'); }}"
                                ));
                            }
                        }
                        Err(err) => {
                            log::warn!("Gateway startup skipped: {err}");
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let safe_err = err.replace('\\', "\\\\").replace('\'', "\\'");
                                let _ = window.eval(&format!(
                                    "window.__OPENCLAW_GATEWAY_START_ERROR = '{safe_err}';"
                                ));
                            }
                        }
                    }
                });
            } else {
                log::info!("Gateway startup deferred until desktop bootstrap creates auth.");
            }

            let tray_icon = app
                .default_window_icon()
                .cloned()
                .ok_or_else(|| "Default tray icon missing".to_string())?;
            let tray_menu = MenuBuilder::new(app)
                .text("tray_show", "Open OpenClaw")
                .separator()
                .text("tray_quit", "Exit OpenClaw")
                .build()
                .map_err(|e| e.to_string())?;
            TrayIconBuilder::with_id("main")
                .icon(tray_icon)
                .menu(&tray_menu)
                .tooltip("OpenClaw")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => show_main_window(&tray.app_handle().clone()),
                    _ => {}
                })
                .build(app)
                .map_err(|e| e.to_string())?;

            if background_startup {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            } else {
                show_main_window(app.handle());
            }

            Ok(())
        })
        .on_page_load(move |window, _payload| {
            if check_onboarding_needed() {
                let _ = window.eval(&format!(
                    "if (!window.location.href.includes('{LOADING_PAGE}')) {{ window.location.replace('{LOADING_PAGE}'); }}"
                ));
                return;
            }
            let _ = window.eval(&format!(
                "(() => {{
                  const target = 'http://{LOCAL_GATEWAY_HOST}:{LOCAL_GATEWAY_PORT}';
                  if (window.location.href.startsWith(target)) return;
                  const retry = () => {{
                    fetch(target + '/health', {{ cache: 'no-store' }})
                      .then(() => window.location.replace(target))
                      .catch(() => setTimeout(retry, 500));
                  }};
                  retry();
                }})();"
            ));
            let Some(token) = read_gateway_token_from_config() else {
                return;
            };
            let safe_token = token.replace('\\', "\\\\").replace('\'', "\\'");
            let js = format!(
                "(() => {{
                  const token = '{safe_token}';
                  const keyA = 'openclaw.control.token.v1:ws://127.0.0.1:18789';
                  const keyB = 'openclaw.control.token.v1:ws://localhost:18789';
                  const apply = () => {{
                    try {{
                      sessionStorage.setItem(keyA, token);
                      sessionStorage.setItem(keyB, token);
                    }} catch (_e) {{}}
                    const app = document.querySelector('openclaw-app');
                    if (!app || typeof app.applySettings !== 'function') return false;
                    try {{
                      const next = {{ ...app.settings, gatewayUrl: 'ws://127.0.0.1:18789', token }};
                      app.applySettings(next);
                      if (typeof app.connect === 'function') {{
                        app.connect();
                      }}
                      return true;
                    }} catch (_e) {{
                      return false;
                    }}
                  }};
                  if (apply()) return;
                  let tries = 0;
                  const t = setInterval(() => {{
                    tries += 1;
                    if (apply() || tries > 24) clearInterval(t);
                  }}, 150);
                }})();"
            );
            let _ = window.eval(&js);
        })
        .on_window_event(move |win, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                let app = win.app_handle();
                let state = app.state::<DesktopState>();
                let quitting = state.quitting.lock().map(|flag| *flag).unwrap_or(false);
                if !quitting {
                    api.prevent_close();
                    let _ = win.hide();
                }
            }
            tauri::WindowEvent::Destroyed => {
                let app = win.app_handle();
                let state = app.state::<DesktopState>();
                let quitting = state.quitting.lock().map(|flag| *flag).unwrap_or(false);
                if quitting {
                    stop_gateway_process(state.gateway.clone());
                }
            }
            _ => {}
        })
        .run(tauri::generate_context!())
        .expect("error running openclaw");
}
