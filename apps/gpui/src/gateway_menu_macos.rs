//! AppKit properties absent from GPUI's native menu contract. GPUI retains
//! ownership of the menu, action dispatch, and keyboard equivalents.
use objc2::MainThreadMarker;
use objc2_app_kit::{NSAccessibility, NSApplication, NSEventModifierFlags, NSImage};
use objc2_foundation::NSString;

use crate::model::gateway_menu::{GatewayStatus, MenuRow, NativeMenuEntry, native_entries};

pub fn update(rows: &[MenuRow]) {
    let Some(main) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(main);
    let Some(menu) = app
        .mainMenu()
        .and_then(|bar| bar.itemWithTitle(&NSString::from_str("Gateways")))
        .and_then(|item| item.submenu())
    else {
        return;
    };
    let delegate = app.delegate();
    for item in menu.itemArray() {
        if !item.isSeparatorItem() {
            // A background AXPress has no key-window responder chain. The
            // application delegate already owns GPUI's menu action selector.
            unsafe { item.setTarget(delegate.as_deref().map(|delegate| delegate.as_ref())) };
        }
    }
    let items = menu.itemArray();
    for (entry, item) in native_entries(rows).into_iter().zip(items.iter()) {
        let NativeMenuEntry::Gateway { index, new_window } = entry else {
            continue;
        };
        if new_window {
            item.setAlternate(true);
            item.setKeyEquivalentModifierMask(if rows[index].number.is_some() {
                NSEventModifierFlags::Command | NSEventModifierFlags::Option
            } else {
                NSEventModifierFlags::Option
            });
            continue;
        }
        let row = &rows[index];
        item.setState(if row.checked { 1 } else { 0 });
        let image_name = match row.status {
            GatewayStatus::Connected => "NSStatusAvailable",
            GatewayStatus::Connecting | GatewayStatus::NeedsSignIn => "NSStatusPartiallyAvailable",
            GatewayStatus::Offline => "NSStatusNone",
        };
        item.setImage(NSImage::imageNamed(&NSString::from_str(image_name)).as_deref());
        if objc2::available!(macos = 14.0) {
            item.setSubtitle(Some(&NSString::from_str(&format!(
                "{}{}",
                if row.primary { "Primary · " } else { "" },
                row.status.label(),
            ))));
        }
        // AppKit otherwise joins the subtitle into AXTitle, changing the menu
        // path whenever connection status changes. Keep its identity stable.
        item.setAccessibilityTitle(Some(&NSString::from_str(&row.name)));
        item.setToolTip(Some(&NSString::from_str(&format!(
            "{}{} · {}",
            row.name,
            if row.primary { " · Primary" } else { "" },
            row.status.label(),
        ))));
    }
}
