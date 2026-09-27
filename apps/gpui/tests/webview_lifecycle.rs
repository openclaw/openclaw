#[cfg(target_os = "macos")]
#[path = "../src/ui/webview_surface_macos.rs"]
mod macos;

#[cfg(target_os = "macos")]
fn main() {
    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSView, NSWindow,
        NSWindowStyleMask,
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use objc2_web_kit::{WKWebView, WKWebViewConfiguration, WKWebsiteDataStore};

    // This executable keeps AppKit on the process main thread and never orders a window front.
    let main = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(main);
    app.setActivationPolicy(NSApplicationActivationPolicy::Prohibited);
    let initial = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(640.0, 480.0));
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(main),
            initial,
            NSWindowStyleMask::Borderless,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    unsafe { window.setReleasedWhenClosed(false) };
    let parent = NSView::initWithFrame(NSView::alloc(main), initial);
    window.setContentView(Some(&parent));
    let configuration = unsafe { WKWebViewConfiguration::new(main) };
    unsafe {
        configuration.setWebsiteDataStore(&WKWebsiteDataStore::nonPersistentDataStore(main));
    }
    let native = unsafe {
        WKWebView::initWithFrame_configuration(WKWebView::alloc(main), initial, &configuration)
    };
    parent.addSubview(&native);
    let webkit_class = native.class();
    macos::configure(&native).unwrap();
    assert_eq!(
        native.class(),
        webkit_class,
        "presentation must preserve WebKit object identity"
    );
    let requested = NSRect::new(NSPoint::new(20.0, 30.0), NSSize::new(360.0, 280.0));
    assert!(macos::set_bounds(&native, requested).unwrap());
    assert_eq!(native.frame().size, requested.size);
    macos::present(&native, false, false);
    assert!(
        macos::set_bounds(&native, initial).unwrap(),
        "hidden attached spares can resize"
    );

    // Retaining a parent is insufficient: removing the content tree leaves its views alive.
    window.setContentView(None);
    let before = native.frame();
    assert!(
        !macos::set_bounds(&native, requested).unwrap(),
        "detached tree must not resize WebKit"
    );
    assert_eq!(native.frame(), before);
    window.setContentView(Some(&parent));
    assert!(macos::set_bounds(&native, requested).unwrap());
    assert_eq!(native.frame().size, requested.size);
    macos::detach(&native);
    let before = native.frame();
    assert!(
        !macos::set_bounds(&native, initial).unwrap(),
        "retired view must not resize"
    );
    assert_eq!(native.frame(), before);
    assert!(unsafe { native.superview() }.is_none());
    assert!(
        macos::configure(&native).is_err(),
        "unattached views cannot configure"
    );
    window.close();
    println!(
        "WebKit lifecycle: hidden attached resize, detached-tree refusal, reattach, and retirement passed"
    );
}

#[cfg(not(target_os = "macos"))]
fn main() {}
