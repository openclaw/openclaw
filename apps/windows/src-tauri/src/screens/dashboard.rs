use tauri::{
    utils::config::WindowEffectsConfig, window::Effect, AppHandle, Emitter, Manager, WebviewUrl,
    WebviewWindowBuilder,
};
use tauri_plugin_frame::WebviewWindowExt;

pub fn open(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }

    let builder = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App("/dashboard".into()))
        .title("OpenClaw - Dashboard")
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .maximized(true)
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
pub async fn open_dashboard(app: AppHandle) {
    open(&app);
}
