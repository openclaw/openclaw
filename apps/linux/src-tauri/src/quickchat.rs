use crate::{notify, tray, DesktopState};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const QUICKCHAT_LABEL: &str = "quickchat";
// Alt+Space is GNOME's window-menu grab; a second X11 grab for it always fails.
pub const QUICKCHAT_SHORTCUT: &str = "CmdOrCtrl+Shift+Space";
const QUICKCHAT_WIDTH: f64 = 640.0;
const QUICKCHAT_HEIGHT: f64 = 92.0;
const IDENTITY_CACHE_TTL: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
pub struct QuickChatIdentity {
    name: String,
    emoji: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSummary {
    id: String,
    name: Option<String>,
    identity_name: Option<String>,
    identity_emoji: Option<String>,
    is_default: bool,
}

struct CachedIdentity {
    fetched_at: Instant,
    identity: QuickChatIdentity,
}

#[derive(Clone)]
pub struct QuickChatState {
    identity_cache: Arc<Mutex<Option<CachedIdentity>>>,
    hide_requested: Arc<AtomicBool>,
}

impl Default for QuickChatState {
    fn default() -> Self {
        Self {
            identity_cache: Arc::new(Mutex::new(None)),
            hide_requested: Arc::new(AtomicBool::new(true)),
        }
    }
}

impl QuickChatState {
    fn identity(&self, desktop: &DesktopState) -> Result<QuickChatIdentity, String> {
        if let Some(identity) = self
            .identity_cache
            .lock()
            .map_err(|_| "Quick Chat identity cache is unavailable.".to_string())?
            .as_ref()
            .filter(|cached| cached.fetched_at.elapsed() < IDENTITY_CACHE_TTL)
            .map(|cached| cached.identity.clone())
        {
            return Ok(identity);
        }

        let cli = desktop.resolve_cli().map_err(|error| error.to_string())?;
        let (agents, output) = cli
            .json::<Vec<AgentSummary>, _, _>(["agents", "list", "--json"])
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(first_stderr_line(&output.stderr)
                .unwrap_or_else(|| "Could not load the default agent identity.".to_string()));
        }
        let identity = default_identity(agents)?;
        *self
            .identity_cache
            .lock()
            .map_err(|_| "Quick Chat identity cache is unavailable.".to_string())? =
            Some(CachedIdentity {
                fetched_at: Instant::now(),
                identity: identity.clone(),
            });
        Ok(identity)
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn default_identity(agents: Vec<AgentSummary>) -> Result<QuickChatIdentity, String> {
    let agent = agents
        .into_iter()
        .find(|agent| agent.is_default)
        .ok_or_else(|| "OpenClaw did not report a default agent.".to_string())?;
    let name = non_empty(agent.identity_name)
        .or_else(|| non_empty(agent.name))
        .or_else(|| non_empty(Some(agent.id)))
        .unwrap_or_else(|| "Agent".to_string());
    Ok(QuickChatIdentity {
        name,
        emoji: non_empty(agent.identity_emoji),
    })
}

fn first_stderr_line(stderr: &[u8]) -> Option<String> {
    String::from_utf8_lossy(stderr)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

/// Stages the message in an owner-only file: argv is world-readable via procfs, and the
/// agent turn can keep running for minutes, so the text must never appear in `--message`.
fn write_message_file(message: &str) -> Result<PathBuf, String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("Could not stage the message: {error}"))?
        .as_nanos();
    let path = std::env::temp_dir().join(format!(
        "openclaw-quickchat-{}-{nanos}.txt",
        std::process::id()
    ));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&path)
        .map_err(|error| format!("Could not stage the message: {error}"))?;
    if let Err(error) = file.write_all(message.as_bytes()) {
        // A partial write must not strand prompt text in the temp directory.
        let _ = std::fs::remove_file(&path);
        return Err(format!("Could not stage the message: {error}"));
    }
    Ok(path)
}

fn spawn_agent_turn(app: AppHandle, desktop: DesktopState, message: String) -> Result<(), String> {
    let cli = desktop.resolve_cli().map_err(|error| error.to_string())?;
    let message_file = write_message_file(&message)?;
    let message_file_arg = message_file.to_string_lossy().into_owned();
    let mut command = cli
        .command([
            "agent",
            "--message-file",
            message_file_arg.as_str(),
            "--session-key",
            "main",
            "--json",
        ])
        .map_err(|error| {
            let _ = std::fs::remove_file(&message_file);
            error.to_string()
        })?;
    command.stdout(Stdio::null()).stderr(Stdio::piped());
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let _ = std::fs::remove_file(&message_file);
            return Err(format!("Failed to run OpenClaw CLI: {error}"));
        }
    };
    thread::spawn(move || {
        let outcome = child.wait_with_output();
        let _ = std::fs::remove_file(&message_file);
        match outcome {
            Ok(output) if !output.status.success() => {
                let body = first_stderr_line(&output.stderr)
                    .unwrap_or_else(|| format!("OpenClaw agent exited with {}.", output.status));
                notify::notify(&app, "Quick Chat message failed", &body);
            }
            Err(error) => notify::notify(
                &app,
                "Quick Chat message failed",
                &format!("Could not monitor OpenClaw agent: {error}"),
            ),
            _ => {}
        }
    });
    Ok(())
}

pub fn quickchat_position(
    monitor_pos: (f64, f64),
    monitor_size: (f64, f64),
    window_size: (f64, f64),
) -> (f64, f64) {
    let max_x = monitor_pos.0 + (monitor_size.0 - window_size.0).max(0.0);
    let max_y = monitor_pos.1 + (monitor_size.1 - window_size.1).max(0.0);
    let x = monitor_pos.0 + (monitor_size.0 - window_size.0).max(0.0) / 2.0;
    let y = monitor_pos.1 + monitor_size.1 * 0.22;
    (x.clamp(monitor_pos.0, max_x), y.clamp(monitor_pos.1, max_y))
}

fn ensure_quickchat_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(window) = app.get_webview_window(QUICKCHAT_LABEL) {
        return Ok(window);
    }
    WebviewWindowBuilder::new(
        app,
        QUICKCHAT_LABEL,
        WebviewUrl::App("quickchat.html".into()),
    )
    .title("Quick Chat")
    .inner_size(QUICKCHAT_WIDTH, QUICKCHAT_HEIGHT)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .visible(false)
    .build()
    .map_err(|error| format!("Could not create Quick Chat window: {error}"))
}

fn position_quickchat(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())
        .or_else(|| window.current_monitor().ok().flatten())
        .ok_or_else(|| "Could not determine a monitor for Quick Chat.".to_string())?;
    let work_area = monitor.work_area();
    let window_size = window
        .inner_size()
        .map_err(|error| format!("Could not read Quick Chat size: {error}"))?;
    let (x, y) = quickchat_position(
        (work_area.position.x as f64, work_area.position.y as f64),
        (work_area.size.width as f64, work_area.size.height as f64),
        (window_size.width as f64, window_size.height as f64),
    );
    window
        .set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
        .map_err(|error| format!("Could not position Quick Chat: {error}"))
}

pub fn request_hide(app: &AppHandle) {
    app.state::<QuickChatState>()
        .hide_requested
        .store(true, Ordering::SeqCst);
    let _ = app.emit_to(QUICKCHAT_LABEL, "quickchat:hide-requested", ());
}

pub fn toggle_quickchat(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(QUICKCHAT_LABEL) {
        if window.is_visible().unwrap_or(false) {
            request_hide(app);
            return;
        }
    }
    if let Err(error) = show_quickchat(app) {
        eprintln!("Quick Chat unavailable: {error}");
    }
}

fn show_quickchat(app: &AppHandle) -> Result<(), String> {
    let window = ensure_quickchat_window(app)?;
    position_quickchat(app, &window)?;
    app.state::<QuickChatState>()
        .hide_requested
        .store(false, Ordering::SeqCst);
    window
        .show()
        .map_err(|error| format!("Could not show Quick Chat: {error}"))?;
    if let Err(error) = window.set_focus() {
        app.state::<QuickChatState>()
            .hide_requested
            .store(true, Ordering::SeqCst);
        return match window.hide() {
            Ok(()) => Err(format!("Could not focus Quick Chat: {error}")),
            Err(hide_error) => match window.destroy() {
                Ok(()) => Err(format!(
                    "Could not focus Quick Chat: {error}; could not hide it again: {hide_error}"
                )),
                Err(destroy_error) => {
                    let _ = window.emit("quickchat:shown", ());
                    Err(format!(
                        "Could not focus Quick Chat: {error}; could not hide it again: \
                         {hide_error}; could not destroy it: {destroy_error}"
                    ))
                }
            },
        };
    }
    window
        .emit("quickchat:shown", ())
        .map_err(|error| format!("Could not activate Quick Chat: {error}"))
}

fn require_quickchat_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == QUICKCHAT_LABEL {
        Ok(())
    } else {
        Err("Quick Chat command is available only to the Quick Chat window.".to_string())
    }
}

#[tauri::command]
pub async fn quickchat_identity(
    window: WebviewWindow,
    desktop: State<'_, DesktopState>,
    state: State<'_, QuickChatState>,
) -> Result<QuickChatIdentity, String> {
    require_quickchat_window(&window)?;
    let desktop = desktop.inner().clone();
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.identity(&desktop))
        .await
        .map_err(|error| format!("Quick Chat identity task failed: {error}"))?
}

#[tauri::command]
pub async fn quickchat_send(
    window: WebviewWindow,
    app: AppHandle,
    desktop: State<'_, DesktopState>,
    message: String,
) -> Result<(), String> {
    require_quickchat_window(&window)?;
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err("Message cannot be empty.".to_string());
    }
    let desktop = desktop.inner().clone();
    tauri::async_runtime::spawn_blocking(move || spawn_agent_turn(app, desktop, message))
        .await
        .map_err(|error| format!("Quick Chat send task failed: {error}"))?
}

#[tauri::command]
pub fn quickchat_hide(window: WebviewWindow) -> Result<(), String> {
    require_quickchat_window(&window)?;
    window
        .app_handle()
        .state::<QuickChatState>()
        .hide_requested
        .store(true, Ordering::SeqCst);
    window
        .hide()
        .map_err(|error| format!("Could not hide Quick Chat: {error}"))
}

#[tauri::command]
pub fn quickchat_ready(
    window: WebviewWindow,
    state: State<'_, QuickChatState>,
) -> Result<bool, String> {
    require_quickchat_window(&window)?;
    Ok(!state.hide_requested.load(Ordering::SeqCst))
}

#[tauri::command]
pub fn quickchat_show_dashboard(
    window: WebviewWindow,
    app: AppHandle,
    desktop: State<'_, DesktopState>,
) -> Result<(), String> {
    require_quickchat_window(&window)?;
    tray::open_dashboard(&app, desktop.inner());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_position(actual: (f64, f64), expected: (f64, f64)) {
        assert!((actual.0 - expected.0).abs() < 1e-9);
        assert!((actual.1 - expected.1).abs() < 1e-9);
    }

    #[test]
    fn position_centers_window_at_twenty_two_percent_of_work_area() {
        assert_position(
            quickchat_position((0.0, 0.0), (1920.0, 1080.0), (640.0, 92.0)),
            (640.0, 237.6),
        );
        assert_position(
            quickchat_position((-1280.0, 40.0), (1280.0, 984.0), (640.0, 92.0)),
            (-960.0, 256.48),
        );
    }

    #[test]
    fn position_stays_inside_small_work_area() {
        assert_eq!(
            quickchat_position((10.0, 20.0), (500.0, 80.0), (640.0, 92.0)),
            (10.0, 20.0)
        );
    }

    #[test]
    fn identity_prefers_identity_fields_for_default_agent() {
        let identity = default_identity(vec![
            AgentSummary {
                id: "other".to_string(),
                name: Some("Other".to_string()),
                identity_name: None,
                identity_emoji: None,
                is_default: false,
            },
            AgentSummary {
                id: "main".to_string(),
                name: Some("Configured".to_string()),
                identity_name: Some("Molty".to_string()),
                identity_emoji: Some("🦞".to_string()),
                is_default: true,
            },
        ])
        .expect("default identity");

        assert_eq!(identity.name, "Molty");
        assert_eq!(identity.emoji.as_deref(), Some("🦞"));
    }
}
