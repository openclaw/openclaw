use tauri::{
    utils::config::WindowEffectsConfig, window::Effect, AppHandle, Emitter, Manager, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_frame::WebviewWindowExt;

pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let builder = WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("/settings".into()))
        .title("OpenClaw - Settings")
        .decorations(false)
        .transparent(true);

    if let Ok(window) = builder.build() {
        let _ = window.set_effects(Some(WindowEffectsConfig {
            effects: vec![Effect::Mica],
            ..Default::default()
        }));
        let _ = window.create_overlay_titlebar();
        let _ = window.emit("frame-page-load", ());
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.maximize();
    }
}

#[tauri::command]
pub async fn open_settings(app: AppHandle) {
    open(&app);
}
