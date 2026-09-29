//! AppKit owns drag gestures; WebKit only identifies passive dashboard regions.
use objc2::rc::{Retained, Weak};
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, ClassType, DefinedClass, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSAutoresizingMaskOptions, NSEvent, NSEventType, NSTitlebarSeparatorStyle,
    NSToolbar, NSView, NSWindow, NSWindowStyleMask, NSWindowTitleVisibility, NSWindowToolbarStyle,
};
use objc2_foundation::{
    MainThreadMarker, NSDictionary, NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize, NSString,
};
use objc2_web_kit::{WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView};
use tauri::{AppHandle, Manager, Url, Webview, Window};

const DRAG_HANDLER: &str = "openclawWindowDrag";

fn handle_gesture(event: &NSEvent, window: &NSWindow, mtm: MainThreadMarker) {
    if !matches!(
        event.r#type(),
        NSEventType::LeftMouseDown | NSEventType::LeftMouseDragged
    ) || !event
        .window(mtm)
        .is_some_and(|target| std::ptr::eq(&*target, window))
    {
        return;
    }
    if event.r#type() == NSEventType::LeftMouseDown && event.clickCount() == 2 {
        window.performZoom(None);
    } else {
        window.performWindowDragWithEvent(event);
    }
}

define_class!(
    #[unsafe(super = NSView)]
    #[name = "OpenClawTauriWindowDragRegion"]
    #[thread_kind = MainThreadOnly]
    struct WindowDragRegion;

    unsafe impl NSObjectProtocol for WindowDragRegion {}

    impl WindowDragRegion {
        #[unsafe(method(mouseDownCanMoveWindow))]
        fn mouse_down_can_move_window(&self) -> bool {
            true
        }

        #[unsafe(method(mouseDown:))]
        fn mouse_down(&self, event: &NSEvent) {
            if let Some(window) = self.window() {
                handle_gesture(event, &window, self.mtm());
            }
        }
    }
);

impl WindowDragRegion {
    fn new(frame: NSRect, mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(());
        unsafe { msg_send![super(this), initWithFrame: frame] }
    }
}

struct DragHandlerState {
    app: AppHandle,
    label: String,
    webview: Weak<WKWebView>,
}

define_class!(
    #[unsafe(super = NSObject)]
    #[name = "OpenClawTauriWindowDragHandler"]
    #[thread_kind = MainThreadOnly]
    #[ivars = DragHandlerState]
    struct WindowDragHandler;

    unsafe impl NSObjectProtocol for WindowDragHandler {}

    unsafe impl WKScriptMessageHandler for WindowDragHandler {
        #[unsafe(method(userContentController:didReceiveScriptMessage:))]
        fn did_receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
            unsafe { self.receive(message) };
        }
    }
);

impl WindowDragHandler {
    fn new(
        app: AppHandle,
        label: String,
        webview: &WKWebView,
        mtm: MainThreadMarker,
    ) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(DragHandlerState {
            app,
            label,
            webview: Weak::new(webview),
        });
        unsafe { msg_send![super(this), init] }
    }

    unsafe fn receive(&self, message: &WKScriptMessage) {
        if message.name().to_string() != DRAG_HANDLER || !message.frameInfo().isMainFrame() {
            return;
        }
        let body = message.body();
        let Some(body) = body.downcast_ref::<NSDictionary>() else {
            return;
        };
        if !body
            .objectForKey(&NSString::from_str("type"))
            .is_some_and(|kind| {
                kind.downcast_ref::<NSString>()
                    .is_some_and(|kind| kind.to_string() == "window-drag")
            })
        {
            return;
        }
        let (Some(expected), Some(sender)) = (self.ivars().webview.load(), message.webView())
        else {
            return;
        };
        if !std::ptr::eq(&*expected, &*sender) {
            return;
        }
        let Some(source) = message
            .frameInfo()
            .request()
            .URL()
            .and_then(|url| url.absoluteString())
            .and_then(|url| Url::parse(&url.to_string()).ok())
        else {
            return;
        };
        let state = self.ivars();
        let Some(current) = state.app.get_webview(&state.label) else {
            return;
        };
        let expected_address = Retained::as_ptr(&sender) as usize;
        let app = state.app.clone();
        let label = state.label.clone();
        // Tauri executes with_webview inline on this main-thread callback.
        // Compare the actual current view, since replacements reuse its label.
        let _ = current.with_webview(move |platform| {
            if platform.inner() as usize != expected_address {
                return;
            }
            let browser = &*platform.inner().cast::<WKWebView>();
            let Some(current_url) = browser
                .URL()
                .and_then(|url| url.absoluteString())
                .and_then(|url| Url::parse(&url.to_string()).ok())
            else {
                return;
            };
            if !crate::window_chrome::authorized_source(&app, &label, &source)
                || !crate::window_chrome::authorized_source(&app, &label, &current_url)
            {
                return;
            }
            let Some(window) = browser.window() else {
                return;
            };
            if window.toolbar().is_none() {
                return;
            }
            let mtm =
                MainThreadMarker::new().expect("WebKit view callbacks run on the main thread");
            // Match the Swift host: use the current real press, never reconstruct
            // one from JavaScript coordinates or a completed mouse-up event.
            if let Some(event) = NSApplication::sharedApplication(mtm).currentEvent() {
                handle_gesture(&event, &window, mtm);
            }
        });
    }
}

fn with_window(
    window: &Window,
    update: impl FnOnce(&NSWindow, MainThreadMarker) + Send + 'static,
) -> tauri::Result<()> {
    let target = window.clone();
    window.run_on_main_thread(move || {
        let Ok(native) = target.ns_window() else {
            return;
        };
        let mtm =
            MainThreadMarker::new().expect("Tauri dispatches window callbacks on the main thread");
        unsafe { update(&*native.cast::<NSWindow>(), mtm) };
    })
}

fn sync_visibility(window: &NSWindow) {
    // The sizing toolbar is owned by this module. Its presence records unified
    // mode even while fullscreen temporarily hides it, without a second store.
    let toolbar = window.toolbar();
    let unified = toolbar.is_some();
    let mask = window.styleMask();
    let fullscreen = mask.contains(NSWindowStyleMask::FullScreen);
    if !fullscreen {
        let desired_mask = if unified {
            mask | NSWindowStyleMask::FullSizeContentView
        } else {
            mask & !NSWindowStyleMask::FullSizeContentView
        };
        if mask != desired_mask {
            // AppKit can restore the pre-fullscreen style mask on exit. Apply
            // the selected mode again, preserving focus across its view relayout.
            let responder = window.firstResponder();
            window.setStyleMask(desired_mask);
            if let Some(responder) = responder {
                window.makeFirstResponder(Some(&responder));
            }
        }
    }
    let title_visibility = if unified {
        NSWindowTitleVisibility::Hidden
    } else {
        NSWindowTitleVisibility::Visible
    };
    if window.titleVisibility() != title_visibility {
        window.setTitleVisibility(title_visibility);
    }
    if window.titlebarAppearsTransparent() != unified {
        window.setTitlebarAppearsTransparent(unified);
    }
    let toolbar_style = if unified {
        NSWindowToolbarStyle::Unified
    } else {
        NSWindowToolbarStyle::Automatic
    };
    if window.toolbarStyle() != toolbar_style {
        window.setToolbarStyle(toolbar_style);
    }
    let separator_style = if unified {
        NSTitlebarSeparatorStyle::None
    } else {
        NSTitlebarSeparatorStyle::Automatic
    };
    if window.titlebarSeparatorStyle() != separator_style {
        window.setTitlebarSeparatorStyle(separator_style);
    }
    let visible = unified && !fullscreen;
    if let Some(toolbar) = toolbar {
        if toolbar.isVisible() != visible {
            toolbar.setVisible(visible);
        }
    }
    if let Some(parent) = window.contentView() {
        for child in parent.subviews() {
            if child.isKindOfClass(WindowDragRegion::class()) {
                child.setHidden(!visible);
            }
        }
    }
}

pub fn install_window(window: &Window) -> tauri::Result<()> {
    set_unified(window, false)
}

pub fn set_unified(window: &Window, unified: bool) -> tauri::Result<()> {
    with_window(window, move |window, mtm| {
        if unified {
            if window.toolbar().is_none() {
                // As in the Swift app, an empty toolbar sizes the unified row
                // to 52pt only after the document announces support for it.
                let toolbar = NSToolbar::new(mtm);
                toolbar.setAllowsUserCustomization(false);
                toolbar.setAutosavesConfiguration(false);
                toolbar.setVisible(false);
                window.setToolbar(Some(&toolbar));
            }
        } else if window.toolbar().is_some() {
            window.setToolbar(None);
        }
        sync_visibility(window);
    })
}

pub fn install_webview(webview: &Webview) -> tauri::Result<()> {
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    webview.with_webview(move |platform| unsafe {
        let browser = &*platform.inner().cast::<WKWebView>();
        let mtm = MainThreadMarker::new().expect("WebKit view callbacks run on the main thread");
        let controller = browser.configuration().userContentController();
        let name = NSString::from_str(DRAG_HANDLER);
        controller.removeScriptMessageHandlerForName(&name);
        let handler = WindowDragHandler::new(app, label, browser, mtm);
        // WebKit retains the handler; its reference back to the view is weak.
        controller.addScriptMessageHandler_name(ProtocolObject::from_ref(&*handler), &name);

        let (Some(parent), Some(window)) = (browser.superview(), browser.window()) else {
            return;
        };
        // Wry appends a replacement WebView above existing siblings. Recreate
        // only our thin regions above it, preserving Wry's parent and children.
        for child in parent.subviews() {
            if child.isKindOfClass(WindowDragRegion::class()) {
                child.removeFromSuperview();
            }
        }
        let bounds = parent.bounds();
        let (width, height) = (bounds.size.width, bounds.size.height);
        let top_margin = if parent.isFlipped() {
            NSAutoresizingMaskOptions::ViewMaxYMargin
        } else {
            NSAutoresizingMaskOptions::ViewMinYMargin
        };
        for (x, region_width, region_height, horizontal) in [
            (
                78.0,
                (width - 458.0).max(0.0),
                12.0,
                NSAutoresizingMaskOptions::ViewWidthSizable,
            ),
            (
                (width - 380.0).max(78.0),
                (width - 86.0).clamp(0.0, 372.0),
                6.0,
                NSAutoresizingMaskOptions::ViewMinXMargin,
            ),
        ] {
            let y = if parent.isFlipped() {
                0.0
            } else {
                height - region_height
            };
            let region = WindowDragRegion::new(
                NSRect::new(NSPoint::new(x, y), NSSize::new(region_width, region_height)),
                mtm,
            );
            region.setHidden(true);
            region.setAutoresizingMask(horizontal | top_margin);
            parent.addSubview(&region);
        }
        sync_visibility(&window);
    })
}

pub fn publish(window: &Window) {
    let _ = with_window(window, |window, _| sync_visibility(window));
}
