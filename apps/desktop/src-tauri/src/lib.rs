use serde::Serialize;
use serde_json::Value;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::path::BaseDirectory;
use tauri::plugin::PermissionState;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

const DEFAULT_GATEWAY_PORT: u16 = 18_789;
const GATEWAY_SIDECAR: &str = "openclaw-node";
const GATEWAY_LAUNCHER_RESOURCE: &str = "openclaw-runtime/desktop-gateway-launcher.mjs";
const GATEWAY_MANIFEST_RESOURCE: &str = "openclaw-runtime/runtime-manifest.json";
const GATEWAY_LOBSTER_RESOURCE: &str = "openclaw-runtime/plugins/openclaw-lobster.tgz";
const DESKTOP_RELEASES_URL: &str = "https://github.com/openclaw/openclaw/releases";

struct DesktopGatewayState {
    gateway: Mutex<Option<GatewayProcess>>,
    auth_token: Mutex<Option<String>>,
}

impl Default for DesktopGatewayState {
    fn default() -> Self {
        Self {
            gateway: Mutex::new(None),
            auth_token: Mutex::new(None),
        }
    }
}

struct GatewayProcess {
    child: CommandChild,
    port: u16,
    started_at_ms: u128,
}

#[derive(Serialize)]
struct DesktopGatewayStatus {
    running: bool,
    url: String,
    started_at_ms: Option<u128>,
    auth_token: Option<String>,
}

#[derive(Serialize)]
struct DesktopRuntimeStatus {
    launcher_path: Option<String>,
    manifest_path: Option<String>,
    bundled_lobster: bool,
    packaged_runtime: bool,
    runtime_source: String,
    openclaw_version: Option<String>,
    node_version: Option<String>,
    desktop_app_update_mode: String,
    desktop_app_update_url: String,
}

#[derive(Serialize)]
struct DesktopStatus {
    gateway: DesktopGatewayStatus,
    runtime: DesktopRuntimeStatus,
    capabilities: DesktopCapabilities,
    permissions: DesktopPermissionsStatus,
}

#[derive(Serialize)]
struct DesktopCapabilities {
    gateway_update_supported: bool,
    desktop_app_update_supported: bool,
    packaged_runtime_update_supported: bool,
    external_plugin_install_supported: bool,
    native_notifications_supported: bool,
    web_push_replaced_by_native: bool,
}

#[derive(Serialize, Clone)]
struct DesktopPermissionEntry {
    id: String,
    label: String,
    status: String,
    settings_url: Option<String>,
}

#[derive(Serialize)]
struct DesktopPermissionsStatus {
    platform: String,
    entries: Vec<DesktopPermissionEntry>,
}

#[derive(Serialize, Clone)]
struct GatewayLogEvent {
    stream: String,
    line: String,
}

#[derive(Serialize, Clone)]
struct GatewayExitEvent {
    code: Option<i32>,
    signal: Option<i32>,
}

#[derive(Serialize)]
struct DesktopCommandResult {
    code: Option<i32>,
    signal: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Serialize)]
struct DesktopNotificationStatus {
    supported: bool,
    permission: String,
}

#[derive(Serialize)]
struct DesktopAppUpdateStatus {
    configured: bool,
    available: bool,
    current_version: String,
    version: Option<String>,
    body: Option<String>,
    date: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
struct DesktopCliStatus {
    installed: bool,
    version: Option<String>,
    package_managers: Value,
    preferred_manager: Option<String>,
    install_spec: Option<String>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

fn gateway_url(port: u16) -> String {
    format!("ws://127.0.0.1:{port}")
}

fn is_loopback_port_available(port: u16) -> bool {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_ok()
}

fn resolve_available_gateway_port(preferred: u16) -> Result<u16, String> {
    if is_loopback_port_available(preferred) {
        return Ok(preferred);
    }
    for port in preferred.saturating_add(1)..preferred.saturating_add(100) {
        if is_loopback_port_available(port) {
            return Ok(port);
        }
    }
    Err(format!(
        "no available loopback gateway port found near {preferred}"
    ))
}

fn generate_gateway_auth_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|error| format!("failed to generate gateway auth token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn get_or_create_gateway_auth_token(state: &DesktopGatewayState) -> Result<String, String> {
    let mut token = state
        .auth_token
        .lock()
        .map_err(|_| "desktop gateway auth token lock poisoned".to_string())?;
    if let Some(existing) = token.as_ref() {
        return Ok(existing.clone());
    }
    let next = generate_gateway_auth_token()?;
    *token = Some(next.clone());
    Ok(next)
}

fn resolve_resource_path(app: &AppHandle, resource: &str) -> Option<String> {
    app.path()
        .resolve(resource, BaseDirectory::Resource)
        .ok()
        .map(|path| path.to_string_lossy().to_string())
}

fn resource_exists(app: &AppHandle, resource: &str) -> bool {
    app.path()
        .resolve(resource, BaseDirectory::Resource)
        .map(|path| path.exists())
        .unwrap_or(false)
}

fn read_manifest_value(app: &AppHandle) -> Option<Value> {
    let manifest = app
        .path()
        .resolve(GATEWAY_MANIFEST_RESOURCE, BaseDirectory::Resource)
        .ok()?;
    let text = std::fs::read_to_string(manifest).ok()?;
    serde_json::from_str(&text).ok()
}

fn manifest_string(manifest: Option<&Value>, path: &[&str]) -> Option<String> {
    let mut current = manifest?;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(|value| value.to_string())
}

fn desktop_updater_pubkey() -> Option<String> {
    std::env::var("OPENCLAW_DESKTOP_UPDATER_PUBKEY")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn desktop_updater_endpoints() -> Vec<String> {
    std::env::var("OPENCLAW_DESKTOP_UPDATER_ENDPOINTS")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(|endpoint| endpoint.trim().to_string())
                .filter(|endpoint| !endpoint.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn desktop_in_app_updater_configured() -> bool {
    desktop_updater_pubkey().is_some() && !desktop_updater_endpoints().is_empty()
}

fn desktop_permission_entries() -> Vec<DesktopPermissionEntry> {
    let macos = cfg!(target_os = "macos");
    let settings = |anchor: &str| -> Option<String> {
        if macos {
            Some(format!(
                "x-apple.systempreferences:com.apple.preference.security?{}",
                anchor
            ))
        } else {
            None
        }
    };
    vec![
        DesktopPermissionEntry {
            id: "notifications".to_string(),
            label: "Notifications".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Notifications"),
        },
        DesktopPermissionEntry {
            id: "accessibility".to_string(),
            label: "Accessibility".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Privacy_Accessibility"),
        },
        DesktopPermissionEntry {
            id: "screen-recording".to_string(),
            label: "Screen Recording".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Privacy_ScreenCapture"),
        },
        DesktopPermissionEntry {
            id: "microphone".to_string(),
            label: "Microphone".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Privacy_Microphone"),
        },
        DesktopPermissionEntry {
            id: "speech-recognition".to_string(),
            label: "Speech Recognition".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Privacy_SpeechRecognition"),
        },
        DesktopPermissionEntry {
            id: "camera".to_string(),
            label: "Camera".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Privacy_Camera"),
        },
        DesktopPermissionEntry {
            id: "location".to_string(),
            label: "Location".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Privacy_LocationServices"),
        },
        DesktopPermissionEntry {
            id: "automation".to_string(),
            label: "Automation".to_string(),
            status: "unknown".to_string(),
            settings_url: settings("Privacy_Automation"),
        },
    ]
}

#[cfg(target_os = "macos")]
mod macos_permissions {
    use std::os::raw::c_uchar;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> c_uchar;
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
    }

    pub fn accessibility_status() -> &'static str {
        if unsafe { AXIsProcessTrusted() != 0 } {
            "granted"
        } else {
            "denied"
        }
    }

    pub fn screen_recording_status() -> &'static str {
        if unsafe { CGPreflightScreenCaptureAccess() } {
            "granted"
        } else {
            "denied"
        }
    }
}

fn permission_state_label(state: PermissionState) -> &'static str {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "default",
    }
}

fn desktop_notification_status(app: &AppHandle) -> DesktopNotificationStatus {
    match app.notification().permission_state() {
        Ok(state) => DesktopNotificationStatus {
            supported: true,
            permission: permission_state_label(state).to_string(),
        },
        Err(_) => DesktopNotificationStatus {
            supported: false,
            permission: "unsupported".to_string(),
        },
    }
}

fn build_permissions_status(app: &AppHandle) -> DesktopPermissionsStatus {
    let notification = desktop_notification_status(app);
    DesktopPermissionsStatus {
        platform: std::env::consts::OS.to_string(),
        entries: desktop_permission_entries()
            .into_iter()
            .map(|mut entry| {
                if entry.id == "notifications" {
                    entry.status = notification.permission.clone();
                }
                #[cfg(target_os = "macos")]
                {
                    if entry.id == "accessibility" {
                        entry.status = macos_permissions::accessibility_status().to_string();
                    }
                    if entry.id == "screen-recording" {
                        entry.status = macos_permissions::screen_recording_status().to_string();
                    }
                }
                entry
            })
            .collect(),
    }
}

fn build_status(app: &AppHandle, state: &DesktopGatewayState) -> Result<DesktopStatus, String> {
    let auth_token = get_or_create_gateway_auth_token(state)?;
    let gateway = state
        .gateway
        .lock()
        .map_err(|_| "desktop gateway state lock poisoned".to_string())?;
    let (running, port, started_at_ms) = match gateway.as_ref() {
        Some(process) => (true, process.port, Some(process.started_at_ms)),
        None => (false, DEFAULT_GATEWAY_PORT, None),
    };

    let manifest = read_manifest_value(app);
    let runtime_source = manifest_string(manifest.as_ref(), &["openclaw", "source"])
        .unwrap_or_else(|| "development-checkout".to_string());
    let packaged_runtime = runtime_source == "packaged-runtime";
    let in_app_updater_configured = desktop_in_app_updater_configured();

    Ok(DesktopStatus {
        gateway: DesktopGatewayStatus {
            running,
            url: gateway_url(port),
            started_at_ms,
            auth_token: Some(auth_token),
        },
        runtime: DesktopRuntimeStatus {
            launcher_path: resolve_resource_path(app, GATEWAY_LAUNCHER_RESOURCE),
            manifest_path: resolve_resource_path(app, GATEWAY_MANIFEST_RESOURCE),
            bundled_lobster: resource_exists(app, GATEWAY_LOBSTER_RESOURCE),
            packaged_runtime,
            runtime_source,
            openclaw_version: manifest_string(manifest.as_ref(), &["openclaw", "version"]),
            node_version: manifest_string(manifest.as_ref(), &["node", "version"]),
            desktop_app_update_mode: if in_app_updater_configured {
                "signed-in-app-updater".to_string()
            } else {
                "manual-release-page".to_string()
            },
            desktop_app_update_url: DESKTOP_RELEASES_URL.to_string(),
        },
        capabilities: DesktopCapabilities {
            gateway_update_supported: !packaged_runtime,
            desktop_app_update_supported: in_app_updater_configured,
            packaged_runtime_update_supported: false,
            external_plugin_install_supported: true,
            native_notifications_supported: true,
            web_push_replaced_by_native: true,
        },
        permissions: build_permissions_status(app),
    })
}

fn emit_gateway_log(app: &AppHandle, stream: &str, line: String) {
    let _ = app.emit(
        "desktop-gateway-log",
        GatewayLogEvent {
            stream: stream.to_string(),
            line,
        },
    );
}

fn clear_gateway_if_current(app: &AppHandle, started_at_ms: u128) {
    let state = app.state::<DesktopGatewayState>();
    if let Ok(mut gateway) = state.gateway.lock() {
        if gateway
            .as_ref()
            .is_some_and(|process| process.started_at_ms == started_at_ms)
        {
            *gateway = None;
        }
    };
}

fn spawn_gateway(
    app: AppHandle,
    port: u16,
    auth_token: String,
) -> Result<DesktopGatewayStatus, String> {
    let launcher = app
        .path()
        .resolve(GATEWAY_LAUNCHER_RESOURCE, BaseDirectory::Resource)
        .map_err(|error| format!("failed to resolve gateway launcher: {error}"))?;

    if !launcher.is_file() {
        return Err(format!(
            "gateway launcher is missing: {}",
            launcher.to_string_lossy()
        ));
    }

    let sidecar = app
        .shell()
        .sidecar(GATEWAY_SIDECAR)
        .map_err(|error| format!("failed to create gateway sidecar command: {error}"))?
        .args([
            launcher.to_string_lossy().to_string(),
            "gateway".to_string(),
            "--port".to_string(),
            port.to_string(),
        ])
        .env("OPENCLAW_DESKTOP", "1")
        .env("OPENCLAW_DESKTOP_GATEWAY_PORT", port.to_string())
        // Enlarge libuv's fs/dns thread pool (default 4). The gateway fans out
        // many concurrent async fs reads (transcript reads for chat.history,
        // session listing, etc.); with only 4 threads they serialize and a
        // single request's read can wait seconds behind the others.
        .env("UV_THREADPOOL_SIZE", "16")
        .env("OPENCLAW_GATEWAY_TOKEN", auth_token.clone());

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|error| format!("failed to start gateway sidecar: {error}"))?;

    let started_at_ms = now_ms();
    let event_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    emit_gateway_log(&event_app, "stdout", String::from_utf8_lossy(&bytes).into());
                }
                CommandEvent::Stderr(bytes) => {
                    emit_gateway_log(&event_app, "stderr", String::from_utf8_lossy(&bytes).into());
                }
                CommandEvent::Error(message) => {
                    emit_gateway_log(&event_app, "error", message);
                }
                CommandEvent::Terminated(payload) => {
                    clear_gateway_if_current(&event_app, started_at_ms);
                    let _ = event_app.emit(
                        "desktop-gateway-exit",
                        GatewayExitEvent {
                            code: payload.code,
                            signal: payload.signal,
                        },
                    );
                }
                _ => {}
            }
        }
    });

    let state = app.state::<DesktopGatewayState>();
    let mut gateway = state
        .gateway
        .lock()
        .map_err(|_| "desktop gateway state lock poisoned".to_string())?;
    if let Some(existing) = gateway.take() {
        let _ = existing.child.kill();
    }
    *gateway = Some(GatewayProcess {
        child,
        port,
        started_at_ms,
    });

    Ok(DesktopGatewayStatus {
        running: true,
        url: gateway_url(port),
        started_at_ms: Some(started_at_ms),
        auth_token: Some(auth_token),
    })
}

fn spawn_gateway_on_available_port(
    app: AppHandle,
    preferred_port: u16,
    auth_token: String,
) -> Result<DesktopGatewayStatus, String> {
    let port = resolve_available_gateway_port(preferred_port)?;
    spawn_gateway(app, port, auth_token)
}

async fn run_openclaw_sidecar_command(
    app: AppHandle,
    args: Vec<String>,
) -> Result<DesktopCommandResult, String> {
    let launcher = app
        .path()
        .resolve(GATEWAY_LAUNCHER_RESOURCE, BaseDirectory::Resource)
        .map_err(|error| format!("failed to resolve gateway launcher: {error}"))?;
    if !launcher.is_file() {
        return Err(format!(
            "gateway launcher is missing: {}",
            launcher.to_string_lossy()
        ));
    }

    let mut sidecar_args = vec![launcher.to_string_lossy().to_string()];
    sidecar_args.extend(args);

    let (mut rx, _child) = app
        .shell()
        .sidecar(GATEWAY_SIDECAR)
        .map_err(|error| format!("failed to create sidecar command: {error}"))?
        .args(sidecar_args)
        .env("OPENCLAW_DESKTOP", "1")
        .spawn()
        .map_err(|error| format!("failed to start sidecar command: {error}"))?;

    let mut stdout = String::new();
    let mut stderr = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                stdout.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Stderr(bytes) => {
                stderr.push_str(&String::from_utf8_lossy(&bytes));
            }
            CommandEvent::Error(message) => {
                stderr.push_str(&message);
                stderr.push('\n');
            }
            CommandEvent::Terminated(payload) => {
                return Ok(DesktopCommandResult {
                    code: payload.code,
                    signal: payload.signal,
                    stdout,
                    stderr,
                });
            }
            _ => {}
        }
    }

    Err("sidecar command ended without termination event".to_string())
}

#[tauri::command]
fn desktop_status(
    app: AppHandle,
    state: State<'_, DesktopGatewayState>,
) -> Result<DesktopStatus, String> {
    build_status(&app, &state)
}

/// Debug sink: append a control-ui performance event (one JSON line) to
/// `~/.openclaw/logs/control-ui-perf.jsonl` so timings can be tailed from a
/// shell. The webview has no log file of its own, so the front-end forwards
/// RPC/render/main-thread-block events here when running in the desktop app.
#[tauri::command]
fn desktop_append_perf_log(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let home = app
        .path()
        .home_dir()
        .map_err(|err| format!("home dir unavailable: {err}"))?;
    let dir = home.join(".openclaw").join("logs");
    std::fs::create_dir_all(&dir).map_err(|err| err.to_string())?;
    let path = dir.join("control-ui-perf.jsonl");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| err.to_string())?;
    writeln!(file, "{line}").map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn desktop_start_gateway(
    app: AppHandle,
    state: State<'_, DesktopGatewayState>,
    port: Option<u16>,
) -> Result<DesktopGatewayStatus, String> {
    let requested_port = port.unwrap_or(DEFAULT_GATEWAY_PORT);
    {
        let gateway = state
            .gateway
            .lock()
            .map_err(|_| "desktop gateway state lock poisoned".to_string())?;
        if let Some(process) = gateway.as_ref() {
            return Ok(DesktopGatewayStatus {
                running: true,
                url: gateway_url(process.port),
                started_at_ms: Some(process.started_at_ms),
                auth_token: Some(get_or_create_gateway_auth_token(state.inner())?),
            });
        }
    }
    let auth_token = get_or_create_gateway_auth_token(state.inner())?;
    spawn_gateway_on_available_port(app, requested_port, auth_token)
}

#[tauri::command]
fn desktop_restart_gateway(
    app: AppHandle,
    state: State<'_, DesktopGatewayState>,
    port: Option<u16>,
) -> Result<DesktopGatewayStatus, String> {
    let auth_token = get_or_create_gateway_auth_token(state.inner())?;
    let existing_port = {
        let mut gateway = state
            .gateway
            .lock()
            .map_err(|_| "desktop gateway state lock poisoned".to_string())?;
        gateway.take().map(|process| {
            let port = process.port;
            let _ = process.child.kill();
            port
        })
    };
    let requested_port = port.or(existing_port).unwrap_or(DEFAULT_GATEWAY_PORT);
    spawn_gateway_on_available_port(app, requested_port, auth_token)
}

#[tauri::command]
fn desktop_stop_gateway(state: State<'_, DesktopGatewayState>) -> Result<(), String> {
    let mut gateway = state
        .gateway
        .lock()
        .map_err(|_| "desktop gateway state lock poisoned".to_string())?;
    if let Some(process) = gateway.take() {
        process
            .child
            .kill()
            .map_err(|error| format!("failed to stop gateway sidecar: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn desktop_install_plugin(
    app: AppHandle,
    source: String,
) -> Result<DesktopCommandResult, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return Err("plugin source is required".to_string());
    }
    let result = run_openclaw_sidecar_command(
        app,
        vec![
            "plugins".to_string(),
            "install".to_string(),
            trimmed.to_string(),
        ],
    )
    .await?;
    if result.code == Some(0) {
        return Ok(result);
    }
    Err(format!(
        "plugin install failed: {}",
        if result.stderr.trim().is_empty() {
            format!("exit code {:?}", result.code)
        } else {
            result.stderr.trim().to_string()
        }
    ))
}

#[tauri::command]
async fn desktop_cli_status(app: AppHandle) -> Result<DesktopCliStatus, String> {
    let result =
        run_openclaw_sidecar_command(app, vec!["cli".to_string(), "status".to_string()]).await?;
    if result.code != Some(0) {
        return Err(format!(
            "CLI status failed: {}",
            if result.stderr.trim().is_empty() {
                format!("exit code {:?}", result.code)
            } else {
                result.stderr.trim().to_string()
            }
        ));
    }
    let parsed: Value = serde_json::from_str(result.stdout.trim())
        .map_err(|error| format!("CLI status returned invalid JSON: {error}"))?;
    Ok(DesktopCliStatus {
        installed: parsed
            .get("installed")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        version: parsed
            .get("version")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        package_managers: parsed
            .get("packageManagers")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default())),
        preferred_manager: parsed
            .get("preferredManager")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        install_spec: parsed
            .get("installSpec")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
    })
}

#[tauri::command]
async fn desktop_install_cli(
    app: AppHandle,
    manager: Option<String>,
) -> Result<DesktopCommandResult, String> {
    let selected_manager = manager.unwrap_or_else(|| "auto".to_string());
    let trimmed = selected_manager.trim();
    if !matches!(trimmed, "auto" | "npm" | "pnpm" | "bun") {
        return Err(format!("unsupported CLI install manager: {trimmed}"));
    }
    let result = run_openclaw_sidecar_command(
        app,
        vec![
            "cli".to_string(),
            "install".to_string(),
            "--manager".to_string(),
            trimmed.to_string(),
        ],
    )
    .await?;
    if result.code == Some(0) {
        return Ok(result);
    }
    Err(format!(
        "CLI install failed: {}",
        if result.stderr.trim().is_empty() {
            format!("exit code {:?}", result.code)
        } else {
            result.stderr.trim().to_string()
        }
    ))
}

#[tauri::command]
fn desktop_notification_status_command(
    app: AppHandle,
) -> Result<DesktopNotificationStatus, String> {
    Ok(desktop_notification_status(&app))
}

#[tauri::command]
fn desktop_request_notification_permission(
    app: AppHandle,
) -> Result<DesktopNotificationStatus, String> {
    app.notification()
        .request_permission()
        .map_err(|error| format!("failed to request notification permission: {error}"))?;
    Ok(desktop_notification_status(&app))
}

#[tauri::command]
fn desktop_send_notification_test(app: AppHandle) -> Result<DesktopNotificationStatus, String> {
    let status = desktop_notification_status(&app);
    if status.permission != "granted" {
        return Err(format!("notification permission is {}", status.permission));
    }
    app.notification()
        .builder()
        .title("OpenClaw")
        .body("Desktop notifications are available.")
        .show()
        .map_err(|error| format!("failed to send notification: {error}"))?;
    Ok(status)
}

#[tauri::command]
fn desktop_open_permission_settings(permission_id: String) -> Result<(), String> {
    let entry = desktop_permission_entries()
        .into_iter()
        .find(|entry| entry.id == permission_id)
        .ok_or_else(|| format!("unknown desktop permission: {permission_id}"))?;
    let Some(url) = entry.settings_url else {
        return Err("permission settings shortcuts are not available on this platform".to_string());
    };
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("failed to open permission settings: {error}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err("permission settings shortcuts are not available on this platform".to_string())
    }
}

#[tauri::command]
fn desktop_open_app_update_page(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(DESKTOP_RELEASES_URL, None::<&str>)
        .map_err(|error| format!("failed to open desktop release page: {error}"))
}

#[tauri::command]
async fn desktop_check_app_update(app: AppHandle) -> Result<DesktopAppUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    if desktop_updater_pubkey().is_none() || desktop_updater_endpoints().is_empty() {
        return Ok(DesktopAppUpdateStatus {
            configured: false,
            available: false,
            current_version,
            version: None,
            body: None,
            date: None,
            error: None,
        });
    }
    let endpoints = desktop_updater_endpoints()
        .into_iter()
        .map(|endpoint| {
            endpoint
                .parse::<url::Url>()
                .map_err(|error| format!("invalid desktop updater endpoint {endpoint}: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let updater = app
        .updater_builder()
        .endpoints(endpoints)
        .map_err(|error| format!("failed to configure desktop updater: {error}"))?
        .build()
        .map_err(|error| format!("failed to build desktop updater: {error}"))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(DesktopAppUpdateStatus {
            configured: true,
            available: true,
            current_version,
            version: Some(update.version),
            body: update.body,
            date: update.date.map(|date| date.to_string()),
            error: None,
        }),
        Ok(None) => Ok(DesktopAppUpdateStatus {
            configured: true,
            available: false,
            current_version,
            version: None,
            body: None,
            date: None,
            error: None,
        }),
        Err(error) => Ok(DesktopAppUpdateStatus {
            configured: true,
            available: false,
            current_version,
            version: None,
            body: None,
            date: None,
            error: Some(error.to_string()),
        }),
    }
}

#[tauri::command]
async fn desktop_install_app_update(app: AppHandle) -> Result<DesktopAppUpdateStatus, String> {
    let endpoints = desktop_updater_endpoints();
    if desktop_updater_pubkey().is_none() || endpoints.is_empty() {
        return Err("desktop in-app updater is not configured".to_string());
    }
    let parsed_endpoints = endpoints
        .into_iter()
        .map(|endpoint| {
            endpoint
                .parse::<url::Url>()
                .map_err(|error| format!("invalid desktop updater endpoint {endpoint}: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let updater = app
        .updater_builder()
        .endpoints(parsed_endpoints)
        .map_err(|error| format!("failed to configure desktop updater: {error}"))?
        .build()
        .map_err(|error| format!("failed to build desktop updater: {error}"))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|error| format!("desktop update check failed: {error}"))?
    else {
        return Ok(DesktopAppUpdateStatus {
            configured: true,
            available: false,
            current_version: app.package_info().version.to_string(),
            version: None,
            body: None,
            date: None,
            error: None,
        });
    };
    let version = update.version.clone();
    let body = update.body.clone();
    let date = update.date.map(|date| date.to_string());
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("desktop update install failed: {error}"))?;
    Ok(DesktopAppUpdateStatus {
        configured: true,
        available: true,
        current_version: app.package_info().version.to_string(),
        version: Some(version),
        body,
        date,
        error: None,
    })
}

#[tauri::command]
fn desktop_native_message(message: Value) {
    println!("[desktop-native-message] {message}");
}

pub fn run() {
    let mut updater_plugin = tauri_plugin_updater::Builder::new();
    if let Some(pubkey) = desktop_updater_pubkey() {
        updater_plugin = updater_plugin.pubkey(pubkey);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(updater_plugin.build())
        .manage(DesktopGatewayState::default())
        .invoke_handler(tauri::generate_handler![
            desktop_status,
            desktop_append_perf_log,
            desktop_start_gateway,
            desktop_restart_gateway,
            desktop_stop_gateway,
            desktop_install_plugin,
            desktop_cli_status,
            desktop_install_cli,
            desktop_notification_status_command,
            desktop_request_notification_permission,
            desktop_send_notification_test,
            desktop_open_permission_settings,
            desktop_open_app_update_page,
            desktop_check_app_update,
            desktop_install_app_update,
            desktop_native_message
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<DesktopGatewayState>();
                let result =
                    get_or_create_gateway_auth_token(state.inner()).and_then(|auth_token| {
                        spawn_gateway_on_available_port(
                            handle.clone(),
                            DEFAULT_GATEWAY_PORT,
                            auth_token,
                        )
                    });
                if let Err(error) = result {
                    emit_gateway_log(&handle, "error", error);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let process = {
                    let state = window.state::<DesktopGatewayState>();
                    state
                        .gateway
                        .lock()
                        .ok()
                        .and_then(|mut gateway| gateway.take())
                };
                if let Some(process) = process {
                    let _ = process.child.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running OpenClaw desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_next_gateway_port_when_preferred_is_busy() {
        let (busy_port, listener) = (20_000_u16..20_100)
            .find_map(|port| {
                TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
                    .ok()
                    .map(|listener| (port, listener))
            })
            .expect("bind test listener");

        let selected = resolve_available_gateway_port(busy_port).expect("available fallback port");

        drop(listener);
        assert_ne!(selected, busy_port);
        assert!(selected > busy_port);
    }
}
