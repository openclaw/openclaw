use tauri::AppHandle;
use tauri_plugin_notification::{NotificationExt, PermissionState};

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let notification = app.notification();
    let permission = match notification.permission_state() {
        Ok(PermissionState::Granted) => PermissionState::Granted,
        Ok(_) => match notification.request_permission() {
            Ok(permission) => permission,
            Err(error) => {
                eprintln!("Could not request notification permission: {error}");
                return;
            }
        },
        Err(error) => {
            eprintln!("Could not check notification permission: {error}");
            return;
        }
    };
    if !matches!(permission, PermissionState::Granted) {
        return;
    }
    if let Err(error) = notification.builder().title(title).body(body).show() {
        eprintln!("Could not show notification: {error}");
    }
}
