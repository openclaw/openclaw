use objc2::{AnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;

pub fn install() {
    let main = MainThreadMarker::new().expect("install the Dock icon on the app thread");
    let data = NSData::with_bytes(include_bytes!(
        "../../macos/Sources/OpenClaw/Resources/OpenClaw.icns"
    ));
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        log::warn!("Could not decode the OpenClaw Dock icon");
        return;
    };
    // AppKit retains the image; setting it does not activate a background window.
    unsafe { NSApplication::sharedApplication(main).setApplicationIconImage(Some(&image)) };
}
