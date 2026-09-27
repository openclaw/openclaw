use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};
use objc2_web_kit::WKWebView;

define_class!(
    #[unsafe(super(NSView))]
    #[ivars = ()]
    struct PresentationView;

    unsafe impl NSObjectProtocol for PresentationView {}

    impl PresentationView {
        #[unsafe(method(hitTest:))]
        fn hit_test(&self, point: NSPoint) -> *mut NSView {
            // Opacity preserves WebKit's rendering lifecycle; the container
            // separately excludes masked documents from AppKit hit testing.
            if self.alphaValue() < 1.0 {
                std::ptr::null_mut()
            } else {
                unsafe { msg_send![super(self), hitTest: point] }
            }
        }

        #[unsafe(method(acceptsFirstResponder))]
        fn accepts_first_responder(&self) -> bool {
            false
        }
    }
);

pub(super) fn configure(native: &WKWebView) -> Result<(), String> {
    let main = MainThreadMarker::new().ok_or("Webview presentation requires the main thread")?;
    let parent = unsafe { native.superview() }.ok_or("Webview parent is missing")?;
    if parent.window().is_none() {
        return Err("Webview parent is not attached to a window".into());
    }
    let frame = native.frame();
    let container: Retained<PresentationView> = unsafe {
        msg_send![super(PresentationView::alloc(main).set_ivars(())), initWithFrame: frame]
    };
    container.setAlphaValue(0.0);
    container.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    native.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
    // Attach the complete responder chain before changing WebKit's viewport.
    parent.addSubview(&container);
    container.addSubview(native);
    native.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
    Ok(())
}

fn container(native: &WKWebView) -> Option<Retained<NSView>> {
    // Presentation and hierarchy access stay on GPUI's main thread.
    unsafe { native.superview() }.filter(|view| view.isKindOfClass(PresentationView::class()))
}

pub(super) fn hide(native: &WKWebView) {
    if let Some(container) = container(native) {
        container.setAlphaValue(0.0);
        if let Some(window) = container.window()
            && let Some(responder) = window
                .firstResponder()
                .and_then(|responder| responder.downcast::<NSView>().ok())
            && responder.isDescendantOf(&container)
            && let Some(parent) = unsafe { container.superview() }
        {
            let _ = window.makeFirstResponder(Some(&parent));
        }
    }
}

pub(super) fn present(native: &WKWebView, render: bool, reveal: bool) {
    if let Some(container) = container(native) {
        if reveal {
            container.setAlphaValue(1.0);
        } else {
            hide(native);
        }
        native.setHidden(!render);
        container.setHidden(!render);
    }
}

pub(super) fn set_bounds(native: &WKWebView, bounds: NSRect) -> Result<bool, String> {
    let Some(container) = container(native) else {
        return Ok(false);
    };
    let Some(parent) = (unsafe { container.superview() }) else {
        return Ok(false);
    };
    let Some(window) = parent.window() else {
        return Ok(false);
    };
    // Hidden pooled views are valid, but retained detached trees are not.
    if native.window().as_ref() != Some(&window) || container.window().as_ref() != Some(&window) {
        return Ok(false);
    }
    // Match wry's window_position conversion against GPUI's original parent;
    // the WKWebView itself now fills the container in local coordinates.
    let y = if parent.isFlipped() {
        bounds.origin.y
    } else {
        parent.frame().size.height - bounds.origin.y - bounds.size.height
    };
    let size = NSSize::new(bounds.size.width, bounds.size.height);
    container.setFrame(NSRect::new(NSPoint::new(bounds.origin.x, y), size));
    native.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), size));
    Ok(true)
}

pub(super) fn detach(native: &WKWebView) {
    hide(native);
    if let Some(container) = container(native) {
        native.removeFromSuperview();
        container.removeFromSuperview();
    }
}
