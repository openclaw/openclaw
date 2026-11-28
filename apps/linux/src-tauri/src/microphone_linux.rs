//! Dashboard microphone consent belongs to the native WebKit permission request.
use gtk::prelude::*;
use std::{cell::RefCell, rc::Rc};
use tauri::Url;
use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebViewExt};

pub fn install(view: &webkit2gtk::WebView, admit: impl Fn(&Url) -> bool + 'static) {
    if let Some(settings) = WebViewExt::settings(view) {
        settings.set_enable_media_stream(true);
        settings.set_enable_webrtc(true);
    }
    let pending: Rc<RefCell<Option<gtk::MessageDialog>>> = Rc::default();
    let admit = Rc::new(admit);
    let active = pending.clone();
    view.connect_permission_request(move |view, request| {
        let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>() else {
            return false;
        };
        // The Rust wrapper omits this getter, available since WebKitGTK 2.34.
        let display = unsafe {
            webkit2gtk::ffi::webkit_user_media_permission_is_for_display_device(media.as_ptr()) != 0
        };
        let origin = view.uri().and_then(|uri| Url::parse(&uri).ok());
        let Some(origin) = origin.filter(|url| {
            media.is_for_audio_device()
                && !media.is_for_video_device()
                && !display
                && admit(url)
                && active.borrow().is_none()
        }) else {
            request.deny();
            return true;
        };
        let Some(parent) = view
            .toplevel()
            .and_then(|widget| widget.downcast::<gtk::Window>().ok())
        else {
            request.deny();
            return true;
        };
        let dialog = gtk::MessageDialog::builder()
            .title("Microphone access")
            .transient_for(&parent)
            .modal(true)
            .destroy_with_parent(true)
            .message_type(gtk::MessageType::Question)
            .text("Allow microphone access?")
            .secondary_text(format!(
                "{} wants to use your microphone for voice input.",
                origin.origin().ascii_serialization()
            ))
            .build();
        dialog.add_buttons(&[
            ("Deny", gtk::ResponseType::Cancel),
            ("Allow", gtk::ResponseType::Accept),
        ]);
        dialog.set_default_response(gtk::ResponseType::Cancel);
        let request = request.clone();
        let weak_view = view.downgrade();
        let pending = active.clone();
        let admit = admit.clone();
        dialog.connect_response(move |dialog, response| {
            let current = weak_view
                .upgrade()
                .and_then(|view| view.uri())
                .and_then(|uri| Url::parse(&uri).ok());
            if response == gtk::ResponseType::Accept
                && current
                    .as_ref()
                    .is_some_and(|url| url == &origin && admit(url))
            {
                request.allow();
            } else {
                request.deny();
            }
            pending.borrow_mut().take();
            dialog.close();
        });
        *active.borrow_mut() = Some(dialog.clone());
        dialog.show_all();
        true
    });
    let navigating = pending.clone();
    view.connect_load_changed(move |_, event| {
        if event == webkit2gtk::LoadEvent::Started {
            let dialog = navigating.borrow_mut().take();
            if let Some(dialog) = dialog {
                dialog.response(gtk::ResponseType::Cancel);
            }
        }
    });
    view.connect_destroy(move |_| {
        let dialog = pending.borrow_mut().take();
        if let Some(dialog) = dialog {
            dialog.response(gtk::ResponseType::Cancel);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        time::{Duration, Instant},
    };
    use webkit2gtk::{SettingsExt, UserContentManagerExt};

    // Run explicitly with a display and --test-threads=1. WebKit supplies synthetic
    // capture devices, so accepting these prompts never records a real microphone.
    #[test]
    #[ignore = "requires a Linux display and WebKit media support"]
    fn webkit_microphone_consent() {
        gtk::init().expect("GTK display");
        for (audio, video, admitted, answer, expected) in [
            (
                true,
                false,
                true,
                gtk::ResponseType::Accept,
                "allowed:audio",
            ),
            (
                true,
                false,
                true,
                gtk::ResponseType::Cancel,
                "NotAllowedError",
            ),
            (
                true,
                true,
                true,
                gtk::ResponseType::Accept,
                "NotAllowedError",
            ),
            (
                true,
                false,
                false,
                gtk::ResponseType::Accept,
                "NotAllowedError",
            ),
        ] {
            let outcome = Rc::new(RefCell::new(None));
            let manager = webkit2gtk::UserContentManager::new();
            manager.register_script_message_handler("result");
            let result = outcome.clone();
            manager.connect_script_message_received(Some("result"), move |_, value| {
                *result.borrow_mut() = Some(value.js_value().unwrap().to_string());
            });
            let view = webkit2gtk::WebView::with_user_content_manager(&manager);
            let settings = WebViewExt::settings(&view).unwrap();
            settings.set_enable_mock_capture_devices(true);
            install(&view, move |url| {
                admitted && url.origin().ascii_serialization() == "http://localhost"
            });
            let window = gtk::Window::new(gtk::WindowType::Toplevel);
            window.set_title("Microphone consent regression");
            window.add(&view);
            window.show_all();
            let prompted = Rc::new(Cell::new(false));
            let seen = prompted.clone();
            let responder = gtk::glib::timeout_add_local(Duration::from_millis(100), move || {
                for window in gtk::Window::list_toplevels() {
                    if let Ok(dialog) = window.downcast::<gtk::MessageDialog>() {
                        if dialog.title().as_deref() == Some("Microphone access") {
                            seen.set(true);
                            dialog.response(answer);
                        }
                    }
                }
                gtk::glib::ControlFlow::Continue
            });
            view.load_html(
                &format!(
                    r#"<script>
                navigator.mediaDevices.getUserMedia({{audio:{audio},video:{video}}})
                .then(stream => {{
                    const result = 'allowed:' + stream.getTracks().map(t => t.kind).join(',');
                    stream.getTracks().forEach(t => t.stop());
                    window.webkit.messageHandlers.result.postMessage(result);
                }}).catch(error => window.webkit.messageHandlers.result.postMessage(error.name));
            </script>"#
                ),
                Some("http://localhost/"),
            );
            let deadline = Instant::now() + Duration::from_secs(20);
            while outcome.borrow().is_none() && Instant::now() < deadline {
                gtk::glib::MainContext::default().iteration(false);
                std::thread::sleep(Duration::from_millis(10));
            }
            responder.remove();
            window.close();
            assert_eq!(outcome.borrow().as_deref(), Some(expected));
            assert_eq!(prompted.get(), admitted && audio && !video);
        }
    }
}
