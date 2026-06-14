//! Shared empty-state + loading-state widgets.
//!
//! All tabs use the same `AdwStatusPage` chrome for empty/loading/error
//! states, so the app feels consistent and matches the GNOME HIG pattern
//! used by Files, Weather, Software, etc.

// Both preludes bring in trait methods we use via builder chains (e.g.
// `set_description`, `set_child`); rustc can't always see the usage because
// of the `.builder().build()` pattern. Keep them wholesale.
#[allow(unused_imports)]
use gtk4::prelude::*;
use libadwaita as adw;
#[allow(unused_imports)]
use libadwaita::prelude::*;

/// A centered status page with icon + title + (optional) subtitle.
/// Use for empty states like "No sessions yet", "No agents connected".
pub fn empty(icon_name: &str, title: &str, subtitle: Option<&str>) -> adw::StatusPage {
    let page = adw::StatusPage::builder()
        .icon_name(icon_name)
        .title(title)
        .vexpand(true)
        .hexpand(true)
        .build();
    if let Some(s) = subtitle {
        page.set_description(Some(s));
    }
    page
}

/// A loading state with a spinner, title, and dim subtitle.
/// Use while awaiting initial data on a freshly-opened tab.
pub fn loading(title: &str) -> gtk4::Box {
    let outer = gtk4::Box::builder()
        .orientation(gtk4::Orientation::Vertical)
        .valign(gtk4::Align::Center)
        .halign(gtk4::Align::Center)
        .vexpand(true)
        .hexpand(true)
        .spacing(12)
        .build();

    let spinner = gtk4::Spinner::builder()
        .spinning(true)
        .width_request(32)
        .height_request(32)
        .build();

    let label = gtk4::Label::builder()
        .label(title)
        .css_classes(vec!["dim-label".to_string()])
        .build();

    outer.append(&spinner);
    outer.append(&label);
    outer
}

/// An error state — red warning icon + error message + (optional) retry button.
/// Use for "Failed to load agents" or disconnected network states.
pub fn error(title: &str, details: Option<&str>) -> adw::StatusPage {
    let page = adw::StatusPage::builder()
        .icon_name("dialog-warning-symbolic")
        .title(title)
        .vexpand(true)
        .hexpand(true)
        .css_classes(vec!["error".to_string()])
        .build();
    if let Some(d) = details {
        page.set_description(Some(d));
    }
    page
}

/// Replace all children of `container` with `replacement`. Safe to call
/// during GLib main loop.
pub fn swap_child(container: &gtk4::Box, replacement: &impl IsA<gtk4::Widget>) {
    while let Some(child) = container.first_child() {
        container.remove(&child);
    }
    container.append(replacement);
}
