use tauri::{
    utils::config::WindowEffectsConfig, window::Effect, AppHandle, Emitter, Manager, WebviewUrl,
    WebviewWindowBuilder,
};

pub fn show_notification(app: &AppHandle, title: &str, body: &str) {
    let label = "notification";

    if let Some(window) = app.get_webview_window(label) {
        let _ = window.emit(
            "notification-update",
            serde_json::json!({
                "title": title,
                "body": body
            }),
        );
        let _ = window.set_effects(Some(WindowEffectsConfig {
            effects: vec![Effect::Mica],
            ..Default::default()
        }));
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
    } else {
        let url = format!(
            "/notification?title={}&body={}",
            urlencoding::encode(title),
            urlencoding::encode(body)
        );
        let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
            .title("OpenClaw Notification")
            .inner_size(360.0, 100.0)
            .resizable(false)
            .always_on_top(true)
            .decorations(false)
            .transparent(true)
            .skip_taskbar(true)
            .center()
            .build();

        if let Ok(window) = window {
            let _ = window.set_effects(Some(WindowEffectsConfig {
                effects: vec![Effect::Mica],
                ..Default::default()
            }));
        }
    }
}
