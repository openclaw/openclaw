use gtk4::gio;
use gtk4::prelude::*;

/// Send a desktop notification via the GIO notification API.
///
/// Uses the application's built-in notification support, which integrates
/// with the desktop's notification daemon (GNOME, KDE, etc.) without
/// requiring libnotify as an extra dependency.
pub fn send_notification(
    app: &impl gtk4::prelude::IsA<gio::Application>,
    title: &str,
    body: &str,
    icon: &str,
) {
    let notification = gio::Notification::new(title);
    notification.set_body(Some(body));
    notification.set_icon(&gio::ThemedIcon::new(icon));
    app.send_notification(Some("openclaw-status"), &notification);
}
