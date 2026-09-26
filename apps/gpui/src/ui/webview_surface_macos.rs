use objc2::{ClassType, MainThreadMarker, MainThreadOnly, define_class, msg_send, rc::Retained};
use objc2_app_kit::{NSAutoresizingMaskOptions, NSView};
use objc2_foundation::{NSObjectProtocol, NSPoint, NSRect, NSSize};
use wry::{WebView, WebViewExtMacOS, WryWebView};

use super::SurfaceBounds;

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

pub(super) fn configure(view: &WebView) -> Result<(), String> {
    let main = MainThreadMarker::new().ok_or("Webview presentation requires the main thread")?;
    let native = view.webview();
    let parent = unsafe { native.superview() }.ok_or("Webview parent is missing")?;
    let frame = native.frame();
    let container: Retained<PresentationView> = unsafe {
        msg_send![super(PresentationView::alloc(main).set_ivars(())), initWithFrame: frame]
    };
    container.setAlphaValue(0.0);
    container.setAutoresizingMask(NSAutoresizingMaskOptions::ViewMinYMargin);
    native.removeFromSuperview();
    native.setAutoresizingMask(NSAutoresizingMaskOptions::empty());
    native.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), frame.size));
    container.addSubview(&native);
    parent.addSubview(&container);
    Ok(())
}

fn container(native: &WryWebView) -> Option<Retained<NSView>> {
    // Presentation and hierarchy access stay on GPUI's main thread.
    unsafe { native.superview() }.filter(|view| view.isKindOfClass(PresentationView::class()))
}

pub(super) fn hide(native: &WryWebView) {
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

pub(super) fn present(view: &WebView, render: bool, reveal: bool) {
    let native = view.webview();
    if let Some(container) = container(&native) {
        if reveal {
            container.setAlphaValue(1.0);
        } else {
            hide(&native);
        }
        native.setHidden(!render);
        container.setHidden(!render);
    }
}

pub(super) fn set_bounds(view: &WebView, bounds: SurfaceBounds) -> Result<(), String> {
    let native = view.webview();
    let container = container(&native).ok_or("Webview presentation container is missing")?;
    let parent = unsafe { container.superview() }.ok_or("Webview parent is missing")?;
    // Match wry's window_position conversion against GPUI's original parent;
    // the WKWebView itself now fills the container in local coordinates.
    let y = if parent.isFlipped() {
        bounds.y
    } else {
        parent.frame().size.height - bounds.y - bounds.height
    };
    let size = NSSize::new(bounds.width, bounds.height);
    container.setFrame(NSRect::new(NSPoint::new(bounds.x, y), size));
    native.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), size));
    Ok(())
}

pub(super) fn detach(view: &WebView) {
    let native = view.webview();
    hide(&native);
    if let Some(container) = container(&native) {
        native.removeFromSuperview();
        container.removeFromSuperview();
    }
}
