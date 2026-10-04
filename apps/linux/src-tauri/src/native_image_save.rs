//! Linux dashboard image saves require a native chooser, not WebKit's default download path.
use base64::Engine as _;
use gtk::prelude::*;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Webview};

const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;

fn suggested_name(name: &str) -> Result<&str, String> {
    if name.is_empty()
        || name.len() > 240
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
        || Path::new(name).file_name().and_then(|part| part.to_str()) != Some(name)
    {
        return Err("Invalid image filename.".into());
    }
    Ok(name)
}

fn write_image(path: PathBuf, bytes: Vec<u8>) -> Result<(), String> {
    let parent = path.parent().ok_or("No destination directory selected.")?;
    let staging = parent.join(format!(".openclaw-image-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)
            .map_err(|error| format!("Could not create image: {error}"))?;
        file.write_all(&bytes)
            .map_err(|error| format!("Could not write image: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("Could not finish image: {error}"))?;
        std::fs::rename(&staging, &path).map_err(|error| format!("Could not save image: {error}"))
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(staging);
    }
    result
}

#[tauri::command]
pub async fn native_image_save(
    app: AppHandle,
    webview: Webview,
    file_name: String,
    bytes_base64: String,
) -> Result<bool, String> {
    if webview.label() != "main" || !crate::window_chrome::authorized(&app, &webview) {
        return Err("Image saving is unavailable for this page.".into());
    }
    let file_name = suggested_name(&file_name)?.to_string();
    if bytes_base64.len() > ((MAX_IMAGE_BYTES + 2) / 3) * 4 + 4 {
        return Err("Image exceeds the 32 MiB limit.".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(bytes_base64)
        .map_err(|_| "Invalid image data.")?;
    if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image is empty or exceeds the 32 MiB limit.".into());
    }
    let (reply, receiver) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let parent = platform
                .inner()
                .toplevel()
                .and_then(|widget| widget.downcast::<gtk::Window>().ok());
            let chooser = gtk::FileChooserNative::new(
                Some("Save image as"),
                parent.as_ref(),
                gtk::FileChooserAction::Save,
                Some("Save"),
                Some("Cancel"),
            );
            if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
                if home.is_dir() {
                    chooser.set_current_folder(&home);
                }
            }
            chooser.set_current_name(&file_name);
            chooser.set_do_overwrite_confirmation(true);
            let destination = (chooser.run() == gtk::ResponseType::Accept)
                .then(|| chooser.filename())
                .flatten();
            let _ = reply.send(destination);
        })
        .map_err(|error| error.to_string())?;
    let Some(destination) = receiver
        .await
        .map_err(|_| "The image dialog closed unexpectedly.")?
    else {
        return Ok(false);
    };
    tauri::async_runtime::spawn_blocking(move || write_image(destination, bytes))
        .await
        .map_err(|error| format!("Image save task failed: {error}"))??;
    Ok(true)
}

pub fn initialization_script(origin: &str) -> String {
    include_str!("../../ui/native-image-save.js").replace(
        "__ORIGIN__",
        &serde_json::to_string(origin).expect("valid origin"),
    )
}

#[cfg(test)]
mod tests {
    use super::suggested_name;

    #[test]
    fn rejects_paths_but_preserves_an_image_name() {
        assert_eq!(
            suggested_name("Alice-reflets.png").unwrap(),
            "Alice-reflets.png"
        );
        for name in ["", "../oops.png", "a/b.png", "a\\b.png", "a\n.png"] {
            assert!(suggested_name(name).is_err());
        }
    }
}
