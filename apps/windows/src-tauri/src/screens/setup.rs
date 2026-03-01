use std::sync::Arc;
use tauri::{
    utils::config::WindowEffectsConfig, window::Effect, AppHandle, Emitter, Manager, State,
    WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_frame::WebviewWindowExt;

pub fn open(app: &AppHandle) {
    let builder = WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("/setup".into()))
        .title("OpenClaw - Setup")
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .inner_size(900.0, 650.0)
        .center();

    if let Ok(window) = builder.build() {
        let _ = window.set_effects(Some(WindowEffectsConfig {
            effects: vec![Effect::Mica],
            ..Default::default()
        }));
        let _ = window.create_overlay_titlebar();
        let _ = window.emit("frame-page-load", ());
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub async fn mark_setup_completed(
    app: AppHandle,
    config_service: State<'_, Arc<crate::services::ConfigService>>,
) -> crate::error::Result<()> {
    config_service
        .update(|config| {
            config.is_setup_completed = true;
        })
        .await?;

    // Safely close the setup window
    if let Some(window) = app.get_webview_window("setup") {
        let _ = window.close();
    }
    Ok(())
}
