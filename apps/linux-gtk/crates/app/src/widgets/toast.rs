//! Global toast surface. Views grab the overlay from `AppState` and call
//! `.show_toast(...)` to surface errors / success messages without opening
//! modal dialogs.
//!
//! Pattern matches GNOME apps: use `AdwToast` for transient feedback,
//! `AdwAlertDialog` for destructive confirmations.
//!
//! Not yet wired into the view layer — kept ready for the next iteration.

#![allow(dead_code)]

#[allow(unused_imports)]
use libadwaita as adw;
#[allow(unused_imports)]
use libadwaita::prelude::*;

/// Convenience for building a toast with a title and a short timeout.
pub fn info(message: impl Into<String>) -> adw::Toast {
    adw::Toast::builder()
        .title(message.into())
        .timeout(3)
        .build()
}

/// Build an error toast (longer timeout, can be dismissed manually).
pub fn error(message: impl Into<String>) -> adw::Toast {
    adw::Toast::builder()
        .title(message.into())
        .timeout(6)
        .build()
}

/// Build a toast with an action button (e.g. "Retry", "Open logs").
pub fn with_action(
    message: impl Into<String>,
    button_label: impl Into<String>,
    action_name: &str,
) -> adw::Toast {
    adw::Toast::builder()
        .title(message.into())
        .button_label(button_label.into())
        .action_name(action_name)
        .timeout(8)
        .build()
}

/// Thin wrapper around AdwToastOverlay so views don't need to know
/// which widget they're attaching to.
#[derive(Clone)]
pub struct ToastSurface {
    overlay: adw::ToastOverlay,
}

impl ToastSurface {
    pub fn new() -> Self {
        Self {
            overlay: adw::ToastOverlay::new(),
        }
    }

    pub fn overlay(&self) -> &adw::ToastOverlay {
        &self.overlay
    }

    pub fn show(&self, toast: adw::Toast) {
        self.overlay.add_toast(toast);
    }

    pub fn info(&self, message: impl Into<String>) {
        self.show(info(message));
    }

    pub fn error(&self, message: impl Into<String>) {
        self.show(error(message));
    }
}

impl Default for ToastSurface {
    fn default() -> Self {
        Self::new()
    }
}
