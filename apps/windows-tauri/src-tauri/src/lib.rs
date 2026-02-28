use std::sync::{Arc, Mutex};
use std::path::PathBuf;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

type GatewayChild = Arc<Mutex<Option<CommandChild>>>;
struct GatewayState(GatewayChild);

// ──────────────────────────────────────────
// IPC Commands
// ──────────────────────────────────────────

#[tauri::command]
fn check_onboarding_needed() -> bool {
    let path = config_path();
    if !path.exists() { return true; }
    match std::fs::read_to_string(&path) {
        Ok(s) => !s.contains("\"model\""),
        Err(_) => true,
    }
}

#[tauri::command]
fn write_config(json: String) -> Result<(), String> {
    let path = config_path();
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let new_val: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Invalid JSON: {e}"))?;
    let merged = if path.exists() {
        let existing: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&path).unwrap_or_default()
        ).unwrap_or(serde_json::json!({}));
        let mut m = existing;
        json_merge(&mut m, new_val);
        m
    } else {
        new_val
    };
    std::fs::write(&path, serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// Called from JS after saving config — navigates window to Control UI
/// by injecting a JS redirect (Tauri v2 doesn't have a window.navigate() API)
#[tauri::command]
fn open_control_ui(window: tauri::WebviewWindow) -> Result<(), String> {
    window
        .eval("window.location.href = 'http://127.0.0.1:18789'")
        .map_err(|e| e.to_string())
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

fn config_path() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| "C:\\Users\\Default".to_string());
    PathBuf::from(home).join(".openclaw").join("openclaw.json")
}

fn json_merge(dst: &mut serde_json::Value, src: serde_json::Value) {
    match (dst, src) {
        (serde_json::Value::Object(d), serde_json::Value::Object(s)) => {
            for (k, v) in s { json_merge(d.entry(k).or_insert(serde_json::Value::Null), v); }
        }
        (dst, src) => *dst = src,
    }
}

// ──────────────────────────────────────────
// Entry point
// ──────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create gateway child Arc before Builder so on_window_event can own a clone
    let child: GatewayChild = Arc::new(Mutex::new(None));
    let child_for_event = child.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_log::Builder::default().level(log::LevelFilter::Info).build())
        .manage(GatewayState(child))
        .invoke_handler(tauri::generate_handler![
            check_onboarding_needed,
            write_config,
            open_control_ui,
        ])
        .setup(|app| {
            // Decide initial page: onboarding or Control UI
            let needs_onboard = check_onboarding_needed();
            let onboard_html = app.path()
                .resource_dir()
                .unwrap_or_default()
                .join("onboard.html");

            if needs_onboard && onboard_html.exists() {
                // Navigate to bundled onboard page using JS eval after a short delay
                if let Some(win) = app.get_webview_window("main") {
                    let path_str = onboard_html.to_string_lossy()
                        .replace('\\', "/");
                    let url = format!("https://asset.localhost/{}", path_str.trim_start_matches('/'));
                    log::info!("Showing onboarding page: {}", url);
                    let _ = win.eval(&format!("window.location.href = '{url}'"));
                }
            }
            // If not needed, the default window URL (http://localhost:18789) is already set in tauri.conf.json

            // Launch gateway sidecar
            let index_js = app.path()
                .resource_dir()
                .expect("no resource dir")
                .join("dist")
                .join("index.js");

            if index_js.exists() {
                let handle = app.handle().clone();
                let idx = index_js.to_string_lossy().to_string();
                let child_arc = app.state::<GatewayState>().inner().0.clone();
                tauri::async_runtime::spawn(async move {
                    match handle.shell()
                        .sidecar("gateway").expect("sidecar")
                        .args([idx.as_str(), "gateway", "--port", "18789", "--bind", "lan"])
                        .spawn()
                    {
                        Ok((_rx, proc)) => {
                            log::info!("Gateway pid={}", proc.pid());
                            *child_arc.lock().unwrap() = Some(proc);
                        }
                        Err(e) => log::error!("Gateway start failed: {e}"),
                    }
                });
            } else {
                log::warn!("Gateway index.js not found – using existing instance");
            }
            Ok(())
        })
        .on_window_event(move |_win, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // Use the pre-cloned Arc owned by this closure
                if let Ok(mut g) = child_for_event.lock() {
                    if let Some(proc) = g.take() {
                        log::info!("Stopping gateway...");
                        let _ = proc.kill();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error running openclaw");
}
