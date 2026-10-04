//! Let an authorized Gateway dashboard request microphone capture on Linux.
//! WebKitGTK denies user-media requests by default unless the embedder handles them.
use gtk::prelude::*;
use tauri::{AppHandle, Manager, Url, Webview};
use webkit2gtk::{PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebViewExt};

fn dashboard_url(app: &AppHandle, label: &str, uri: Option<&str>) -> Option<Url> {
    let url = Url::parse(uri?).ok()?;
    if !matches!(url.scheme(), "http" | "https")
        || !crate::window_chrome::authorized_source(app, label, &url)
    {
        return None;
    }
    Some(url)
}

pub fn install_webview(webview: &Webview) -> Result<(), String> {
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    webview
        .with_webview(move |platform| {
            let inner = platform.inner();
            if let Some(settings) = WebViewExt::settings(&inner) {
                settings.set_enable_media_stream(true);
            }
            let parent = inner
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok());
            inner.connect_permission_request(move |view, request| {
                let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>()
                else {
                    return false;
                };
                // Do not grant camera, screen, or mixed audio/video capture here.
                if !media.is_for_audio_device() || media.is_for_video_device() {
                    request.deny();
                    return true;
                }
                let before = dashboard_url(&app, &label, view.uri().as_deref());
                let Some(before) = before else {
                    request.deny();
                    return true;
                };
                let dialog = gtk::MessageDialog::new(
                    parent.as_ref(),
                    gtk::DialogFlags::MODAL,
                    gtk::MessageType::Question,
                    gtk::ButtonsType::None,
                    "Allow this OpenClaw Gateway to use the microphone?",
                );
                dialog.set_secondary_text(Some(&before.origin().ascii_serialization()));
                dialog.add_button("Deny", gtk::ResponseType::No);
                dialog.add_button("Allow microphone", gtk::ResponseType::Yes);
                let accepted = dialog.run() == gtk::ResponseType::Yes;
                dialog.close();
                // A navigation or Gateway switch while the prompt is open
                // invalidates the permission, even if the user clicked Allow.
                let current = dashboard_url(&app, &label, view.uri().as_deref());
                if accepted && current.as_ref() == Some(&before) {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            });
        })
        .map_err(|error| error.to_string())
}
