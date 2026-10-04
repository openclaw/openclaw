//! This computer's settings are app-global; only the current trusted dashboard may edit them.
use crate::desktop_node::DesktopNode;
use crate::native_browser_bridge::{self, NativeBrowserBridgeState, Publication};
use serde_json::{json, Value};
#[cfg(target_os = "linux")]
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
#[cfg(target_os = "linux")]
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, Webview};

static SNAPSHOT_REVISION: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "linux")]
pub(crate) struct MotionPreference {
    enabled: Mutex<bool>,
    original_animations: bool,
}

#[cfg(target_os = "linux")]
fn preference_path(app: &impl Manager<tauri::Wry>) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("companion-settings.sqlite"))
        .map_err(|error| format!("Could not resolve motion preference: {error}"))
}

#[cfg(target_os = "linux")]
fn read_motion(path: &std::path::Path) -> Result<Option<bool>, String> {
    use rusqlite::OptionalExtension;
    if !path.exists() {
        return Ok(None);
    }
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|error| format!("Could not read Companion settings: {error}"))?;
    connection
        .query_row(
            "SELECT value FROM preferences WHERE key = 'reduced_motion'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map(|value| value.map(|value| value != 0))
        .map_err(|error| format!("Could not read motion setting: {error}"))
}

#[cfg(target_os = "linux")]
fn write_motion(path: &std::path::Path, enabled: bool) -> Result<(), String> {
    use rusqlite::params;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    std::fs::create_dir_all(path.parent().ok_or("Invalid settings path")?)
        .map_err(|error| format!("Could not create Companion settings directory: {error}"))?;
    // The database is native app state, not an export. Protect it on first use.
    if !path.exists() {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true).mode(0o600);
        match options.open(path) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("Could not create Companion settings: {error}")),
        }
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| format!("Could not protect Companion settings: {error}"))?;
    let mut connection = rusqlite::Connection::open(path)
        .map_err(|error| format!("Could not open Companion settings: {error}"))?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Could not update Companion settings: {error}"))?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value INTEGER NOT NULL)",
        )
        .map_err(|error| format!("Could not initialize Companion settings: {error}"))?;
    transaction
        .execute(
            "INSERT INTO preferences(key, value) VALUES('reduced_motion', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![i64::from(enabled)],
        )
        .map_err(|error| format!("Could not save motion setting: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Could not commit motion setting: {error}"))
}

#[cfg(target_os = "linux")]
pub(crate) fn initialize_motion(app: &mut tauri::App) {
    use gtk::prelude::GtkSettingsExt;
    let saved = preference_path(app)
        .ok()
        .and_then(|path| read_motion(&path).ok().flatten());
    // A prior test AppImage used this file. Read it only if no database exists;
    // the next user change saves the authoritative SQLite value.
    let legacy = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("reduced-motion")).ok())
        .map(|value| value.trim() == "1");
    let enabled = saved.or(legacy).unwrap_or_else(|| {
        std::env::var_os("OPENCLAW_REDUCED_MOTION").as_deref() == Some(std::ffi::OsStr::new("1"))
    });
    let settings = gtk::Settings::default();
    let original_animations = settings
        .as_ref()
        .is_none_or(|settings| settings.is_gtk_enable_animations());
    if enabled {
        if let Some(settings) = settings {
            settings.set_gtk_enable_animations(false);
        }
    }
    app.manage(MotionPreference {
        enabled: Mutex::new(enabled),
        original_animations,
    });
}

#[cfg(target_os = "linux")]
fn save_motion(app: &AppHandle, enabled: bool) -> Result<(), String> {
    write_motion(&preference_path(app)?, enabled)
}

#[cfg(target_os = "linux")]
pub(crate) fn toggle_initialization_script() -> &'static str {
    r#"
  (() => {
    const rowId = 'openclaw-companion-reduced-motion';
    const motionCopy = () => {
      const locale = document.documentElement.lang || navigator.language || 'en';
      return locale.toLowerCase().startsWith('fr')
        ? ['Réduire les animations', 'Arrête les animations de l’interface dans ce Companion.']
        : ['Reduce animations', 'Stops interface animations in this Companion.'];
    };

    let pending = false;
    const refresh = () => {
      const page = document.querySelector('openclaw-device-page');
      const group = page?.querySelector('.settings-workspace__body .settings-section .settings-group');
      if (!group) return;
      let row = group.querySelector('#' + rowId);
      if (!row) {
        row = document.createElement('div');
        row.id = rowId;
        row.className = 'settings-row settings-row--toggle';
        const copy = document.createElement('div');
        copy.className = 'settings-row__text';
        const title = document.createElement('span');
        title.className = 'settings-row__title';
        title.textContent = motionCopy()[0];
        const description = document.createElement('span');
        description.className = 'settings-row__desc';
        description.textContent = motionCopy()[1];
        copy.append(title, description);
        const control = document.createElement('div');
        control.className = 'settings-row__control';
        const toggle = document.createElement('wa-switch');
        toggle.className = 'settings-toggle';
        toggle.setAttribute('size', 's');
        toggle.setAttribute('aria-label', motionCopy()[0]);
        control.append(toggle);
        row.append(copy, control);
        group.append(row);
        row.addEventListener('click', event => {
          if (event.target.closest('wa-switch')) return;
          toggle.click();
        });
        toggle.addEventListener('change', async () => {
          if (pending) return;
          pending = true;
          const desired = !!toggle.checked;
          toggle.disabled = true;
          try {
            await window.webkit.messageHandlers.openclawDeviceSettings.postMessage({
              type: 'set', key: 'app.reducedMotionEnabled', value: desired
            });
          } catch (error) {
            console.warn('Could not change reduced motion', error);
            toggle.checked = !desired;
          } finally {
            pending = false;
            toggle.disabled = false;
            refresh();
          }
        });
      }
      const [motionTitle, motionDescription] = motionCopy();
      row.querySelector('.settings-row__title').textContent = motionTitle;
      row.querySelector('.settings-row__desc').textContent = motionDescription;
      row.querySelector('wa-switch').setAttribute('aria-label', motionTitle);
      const state = window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__?.app?.reducedMotionEnabled;
      if (typeof state === 'boolean' && !pending) {
        row.querySelector('wa-switch').checked = state;
      }
    };
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; refresh(); });
    };
    new MutationObserver(records => {
      if (document.querySelector('openclaw-device-page') ||
          records.some(record => [...record.addedNodes].some(node =>
            node.nodeType === 1 && (node.matches?.('openclaw-device-page') ||
              node.querySelector?.('openclaw-device-page'))))) schedule();
    }).observe(document, {childList: true, subtree: true});
    window.addEventListener('openclaw:native-device-settings-changed', schedule);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, {once: true});
    else schedule();
  })();
"#
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn toggle_initialization_script() -> &'static str {
    ""
}

pub(crate) fn snapshot(app: &AppHandle) -> Option<Value> {
    let node = app.try_state::<DesktopNode>()?;
    let (_, status) = node.status();
    let revision = SNAPSHOT_REVISION.fetch_add(1, Ordering::Relaxed) + 1;
    #[cfg(target_os = "linux")]
    let motion = *app.state::<MotionPreference>().enabled.lock().ok()?;
    #[cfg(not(target_os = "linux"))]
    let motion = false;
    Some(snapshot_value(
        revision,
        status,
        &app.package_info().version.to_string(),
        std::env::var("OPENCLAW_PROFILE").ok(),
        motion,
    ))
}

fn snapshot_value(
    revision: u64,
    status: crate::desktop_node::Status,
    version: &str,
    profile: Option<String>,
    motion: bool,
) -> Value {
    let mut capabilities = serde_json::Map::new();
    if let Some(enabled) = status.enabled {
        capabilities.insert("desktopSharingEnabled".into(), json!(enabled));
    }
    let mut sharing = json!({ "state": status.state });
    if let Some(detail) = status.detail {
        sharing["detail"] = json!(detail);
    }
    json!({
        "contract": 1,
        "revision": revision,
        "device": {
            "platform": std::env::consts::OS,
            "formFactor": "desktop",
            "appVersion": version,
            "appBuild": version,
            "profileName": profile,
        },
        "app": { "reducedMotionEnabled": motion },
        "capabilities": capabilities,
        "desktopSharing": sharing,
        "permissions": { "entries": [] },
        "voice": { "supported": false, "wakeEnabled": false },
        "browser": { "chromeSetupActions": ["inspect", "install", "verify"] },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    #[test]
    fn motion_setting_survives_reopen_without_legacy_sidecar() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("openclaw-motion-{}", uuid::Uuid::new_v4()));
        let path = dir.join("companion-settings.sqlite");
        assert_eq!(read_motion(&path).unwrap(), None);
        write_motion(&path, true).unwrap();
        assert_eq!(read_motion(&path).unwrap(), Some(true));
        write_motion(&path, false).unwrap();
        assert_eq!(read_motion(&path).unwrap(), Some(false));
        assert!(!dir.join("reduced-motion").exists());
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn off_snapshot_omits_optional_detail_and_unimplemented_permissions() {
        let value = snapshot_value(
            17,
            crate::desktop_node::Status {
                enabled: Some(false),
                state: "off",
                detail: None,
            },
            "2026.9.5",
            None,
            false,
        );
        let wire: Value = serde_json::from_str(&value.to_string()).unwrap();
        assert_eq!(wire["revision"], 17);
        assert_eq!(wire["capabilities"]["desktopSharingEnabled"], false);
        assert_eq!(wire["desktopSharing"], json!({"state":"off"}));
        assert_eq!(wire["permissions"], json!({"entries":[]}));
        assert_eq!(
            wire["browser"],
            json!({"chromeSetupActions":["inspect","install","verify"]})
        );
        assert_eq!(
            wire["voice"],
            json!({"supported":false,"wakeEnabled":false})
        );
    }

    #[test]
    fn unresolved_snapshot_does_not_claim_a_desktop_preference() {
        let value = snapshot_value(
            0,
            crate::desktop_node::Status::default(),
            "2026.9.5",
            None,
            false,
        );
        assert!(value["capabilities"].get("desktopSharingEnabled").is_none());
        assert_eq!(value["desktopSharing"]["state"], "starting");
        assert!(value["desktopSharing"]["detail"].is_string());
    }
}

pub(crate) fn publish(app: &AppHandle) {
    let Some(snapshot) = snapshot(app) else {
        return;
    };
    let Some(script) = native_browser_bridge::publication_script(
        app,
        &snapshot.to_string(),
        Publication::DeviceSettings,
    ) else {
        return;
    };
    if let Some(webview) = app.get_webview("main") {
        let _ = webview.eval(script);
    }
}

#[tauri::command]
pub async fn native_device_settings_request(
    app: AppHandle,
    webview: Webview,
    bridge: State<'_, NativeBrowserBridgeState>,
    message: Value,
    token: String,
) -> Result<Value, String> {
    let generation = bridge
        .authorize(&webview, &token)
        .ok_or("This desktop settings document is no longer current.")?
        .generation;
    let mut setup_result = None;
    match message.get("type").and_then(Value::as_str) {
        Some("status") => {}
        Some("chrome-extension-setup") => {
            let action = crate::chrome_setup::parse_request(message)?;
            let current_app = app.clone();
            setup_result = Some(
                tauri::async_runtime::spawn_blocking(move || {
                    current_app
                        .state::<crate::DesktopState>()
                        .inner
                        .chrome_setup
                        .run_for_document(current_app.clone(), action, generation)
                })
                .await
                .map_err(|_| "Chrome setup could not complete. Try again.")??,
            );
        }
        #[cfg(target_os = "linux")]
        Some("set")
            if message.get("key").and_then(Value::as_str) == Some("app.reducedMotionEnabled") =>
        {
            let enabled = message
                .get("value")
                .and_then(Value::as_bool)
                .ok_or("Reduced motion must be true or false.")?;
            let current_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                current_app
                    .state::<NativeBrowserBridgeState>()
                    .with_document_authority(generation, || save_motion(&current_app, enabled))
            })
            .await
            .map_err(|_| "Motion preference could not be saved.")??;
            let (sender, receiver) = tokio::sync::oneshot::channel();
            let current_app = app.clone();
            app.run_on_main_thread(move || {
                use gtk::prelude::GtkSettingsExt;
                let preference = current_app.state::<MotionPreference>();
                if let Some(settings) = gtk::Settings::default() {
                    settings.set_gtk_enable_animations(if enabled {
                        false
                    } else {
                        preference.original_animations
                    });
                }
                if let Ok(mut value) = preference.enabled.lock() {
                    *value = enabled;
                }
                let _ = sender.send(());
            })
            .map_err(|error| format!("Could not apply motion preference: {error}"))?;
            receiver
                .await
                .map_err(|_| "Motion preference could not be applied.")?;
        }
        Some("set")
            if message.get("key").and_then(Value::as_str)
                == Some("capabilities.desktopSharingEnabled") =>
        {
            let enabled = message
                .get("value")
                .and_then(Value::as_bool)
                .ok_or("Desktop sharing must be true or false.")?;
            let current_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                current_app
                    .state::<NativeBrowserBridgeState>()
                    .with_document_authority(generation, || {
                        current_app.state::<DesktopNode>().set_enabled(enabled)
                    })
            })
            .await
            .map_err(|_| "Desktop sharing preference could not be saved.")??;
        }
        _ => return Err("This setting is not supported by OpenClaw-Tauri.".into()),
    }
    if !bridge
        .authorize(&webview, &token)
        .is_some_and(|current| current.generation == generation)
    {
        return Err("The desktop settings document changed.".into());
    }
    if let Some(result) = setup_result {
        return Ok(result);
    }
    let snapshot = snapshot(&app).ok_or("Desktop sharing is not ready.")?;
    publish(&app);
    Ok(snapshot)
}
