//! This computer's settings are app-global; only the current trusted dashboard may edit them.
use crate::desktop_node::DesktopNode;
use crate::native_browser_bridge::{self, NativeBrowserBridgeState, Publication};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State, Webview};

pub(crate) fn snapshot(app: &AppHandle) -> Option<Value> {
    let node = app.try_state::<DesktopNode>()?;
    let (revision, status) = node.status();
    Some(snapshot_value(
        revision,
        status,
        &app.package_info().version.to_string(),
        std::env::var("OPENCLAW_PROFILE").ok(),
    ))
}

fn snapshot_value(
    revision: u64,
    status: crate::desktop_node::Status,
    version: &str,
    profile: Option<String>,
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
        let value = snapshot_value(0, crate::desktop_node::Status::default(), "2026.9.5", None);
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
