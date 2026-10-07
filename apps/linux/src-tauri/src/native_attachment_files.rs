//! User-initiated Linux file attachments from the clipboard or native window drop.
use base64::Engine as _;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, DragDropEvent, Manager, Webview, WebviewEvent, Window, WindowEvent};

const MAX_FILES: usize = 8;
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_BATCH_BYTES: u64 = 64 * 1024 * 1024;
const DROP_LIFETIME: Duration = Duration::from_secs(15);
const PASTE_LIFETIME: Duration = Duration::from_millis(750);

#[derive(Default)]
pub struct DropState(Mutex<AttachmentAuthority>);

#[derive(Default)]
struct AttachmentAuthority {
    documents: HashMap<String, String>,
    drops: HashMap<String, PendingDrop>,
    pastes: HashMap<String, PendingPaste>,
}

struct PendingDrop {
    token: String,
    document: String,
    paths: Vec<PathBuf>,
    created: Instant,
}

struct PendingPaste {
    document: String,
    created: Instant,
}

impl AttachmentAuthority {
    fn with_document<T>(
        &self,
        label: &str,
        document: &str,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if self.documents.get(label).map(String::as_str) != Some(document) {
            return Err("The document changed before the native operation".to_string());
        }
        operation()
    }

    fn take_paste(&mut self, label: &str) -> Result<String, String> {
        match self.pastes.remove(label) {
            Some(paste)
                if paste.created.elapsed() <= PASTE_LIFETIME
                    && self.documents.get(label) == Some(&paste.document) =>
            {
                Ok(paste.document)
            }
            _ => Err("A current native paste gesture is required".to_string()),
        }
    }

    fn take_drop(&mut self, label: &str, token: &str) -> Result<(String, Vec<PathBuf>), String> {
        match self.drops.remove(label) {
            Some(drop)
                if drop.token == token
                    && drop.created.elapsed() <= DROP_LIFETIME
                    && self.documents.get(label) == Some(&drop.document) =>
            {
                Ok((drop.document, drop.paths))
            }
            _ => Err("File drop expired or belongs to another window".to_string()),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAttachmentFile {
    file_name: String,
    mime_type: String,
    bytes_base64: String,
}

/// A new native WebView replaces the prior document authority for this label.
pub fn install_webview(webview: &Webview) -> Result<(), String> {
    use gtk::prelude::WidgetExt;
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    let document = uuid::Uuid::new_v4().to_string();
    {
        let state = app.state::<DropState>();
        let mut authority = state
            .0
            .lock()
            .map_err(|_| "Attachment authority unavailable")?;
        authority.documents.insert(label.clone(), document.clone());
        authority.drops.remove(&label);
        authority.pastes.remove(&label);
    }
    webview
        .with_webview(move |platform| {
            let app = app.clone();
            let label = label.clone();
            platform.inner().connect_key_press_event(move |_, event| {
                let key = event.keyval();
                let modifiers = event.state();
                let paste = (key == gtk::gdk::keys::constants::v
                    || key == gtk::gdk::keys::constants::V)
                    && modifiers.contains(gtk::gdk::ModifierType::CONTROL_MASK)
                    && !modifiers.intersects(
                        gtk::gdk::ModifierType::MOD1_MASK | gtk::gdk::ModifierType::SUPER_MASK,
                    );
                if paste {
                    if let Some(state) = app.try_state::<DropState>() {
                        if let Ok(mut authority) = state.0.lock() {
                            if let Some(document) = authority.documents.get(&label).cloned() {
                                authority.pastes.insert(
                                    label.clone(),
                                    PendingPaste {
                                        document,
                                        created: Instant::now(),
                                    },
                                );
                            }
                        }
                    }
                }
                gtk::glib::Propagation::Proceed
            });
        })
        .map_err(|error| error.to_string())
}

pub fn rotate_document(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<DropState>() {
        if let Ok(mut authority) = state.0.lock() {
            if authority.documents.contains_key(label) {
                authority
                    .documents
                    .insert(label.to_string(), uuid::Uuid::new_v4().to_string());
                authority.drops.remove(label);
                authority.pastes.remove(label);
            }
        }
    }
}

pub fn forget_webview(app: &AppHandle, label: &str) {
    if let Some(state) = app.try_state::<DropState>() {
        if let Ok(mut authority) = state.0.lock() {
            authority.documents.remove(label);
            authority.drops.remove(label);
            authority.pastes.remove(label);
        }
    }
}

fn stage_drop(app: &AppHandle, label: &str, paths: &[PathBuf], x: f64, y: f64) {
    if paths.is_empty() {
        return;
    }
    let Some(webview) = app.get_webview(label) else {
        return;
    };
    if !crate::window_chrome::authorized(app, &webview) {
        return;
    }
    let token = uuid::Uuid::new_v4().to_string();
    let Some(state) = app.try_state::<DropState>() else {
        return;
    };
    if let Ok(mut authority) = state.0.lock() {
        let Some(document) = authority.documents.get(label).cloned() else {
            return;
        };
        authority.drops.insert(
            label.to_string(),
            PendingDrop {
                token: token.clone(),
                document,
                paths: paths.to_vec(),
                created: Instant::now(),
            },
        );
    } else {
        return;
    }
    let detail = serde_json::json!({"token": token, "x": x, "y": y});
    let _ = webview.eval(format!(
        "window.dispatchEvent(new CustomEvent('openclaw-native-attachment-drop', {{detail: {detail}}}));"
    ));
}

pub fn handle_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event {
        stage_drop(
            window.app_handle(),
            window.label(),
            paths,
            position.x,
            position.y,
        );
    }
}

// Connected dashboards are child webviews; their drops do not surface as
// WindowEvent::DragDrop. Keep the window handler for local window content.
pub fn handle_webview_event(webview: &Webview, event: &WebviewEvent) {
    if let WebviewEvent::DragDrop(DragDropEvent::Drop { paths, position }) = event {
        stage_drop(
            webview.app_handle(),
            webview.label(),
            paths,
            position.x,
            position.y,
        );
    }
}

fn clipboard_paths(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let (send, receive) = mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
        let paths = clipboard
            .wait_for_uris()
            .into_iter()
            .filter_map(|uri| {
                let (path, host) = gtk::glib::filename_from_uri(uri.as_str()).ok()?;
                if host.is_some_and(|value| value.as_str() != "localhost") {
                    return None;
                }
                Some(path)
            })
            .collect();
        let _ = send.send(paths);
    })
    .map_err(|error| format!("Clipboard unavailable: {error}"))?;
    receive
        .recv_timeout(Duration::from_secs(3))
        .map_err(|_| "Clipboard did not respond".to_string())
}

pub(crate) fn capture_document(app: &AppHandle, label: &str) -> Result<String, String> {
    let state = app.state::<DropState>();
    let authority = state
        .0
        .lock()
        .map_err(|_| "Attachment authority unavailable")?;
    authority
        .documents
        .get(label)
        .cloned()
        .ok_or_else(|| "The document is unavailable".to_string())
}

pub(crate) fn with_document_authority<T>(
    app: &AppHandle,
    label: &str,
    document: &str,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<DropState>();
    let authority = state
        .0
        .lock()
        .map_err(|_| "Attachment authority unavailable")?;
    // Keep the authority guard through the final effect, so a replacement cannot
    // rotate document authority between this check and the write.
    authority.with_document(label, document, operation)
}

fn read_bounded(mut file: impl Read, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "A selected file cannot be read".to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Selected files exceed the attachment size limit".to_string());
    }
    Ok(bytes)
}

fn read_files(paths: Vec<PathBuf>) -> Result<Vec<NativeAttachmentFile>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    if paths.len() > MAX_FILES {
        return Err(format!("Select at most {MAX_FILES} files"));
    }
    let mut total = 0_u64;
    let mut result = Vec::with_capacity(paths.len());
    for path in paths {
        // A FIFO without a writer must not block while attachment authority is held.
        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&path)
            .map_err(|_| "A selected file cannot be read".to_string())?;
        let metadata = file
            .metadata()
            .map_err(|_| "A selected file cannot be read".to_string())?;
        if !metadata.is_file() {
            return Err("Only regular files can be attached".to_string());
        }
        let remaining = MAX_BATCH_BYTES - total;
        let limit = MAX_FILE_BYTES.min(remaining);
        if metadata.len() > limit {
            return Err("Selected files exceed the attachment size limit".to_string());
        }
        // The opened file can grow after metadata inspection. Limit actual I/O,
        // not just the size that was reported before the read.
        let bytes = read_bounded(file, limit)?;
        total += bytes.len() as u64;
        let (content_type, _) =
            gtk::gio::content_type_guess(Some(&path), &bytes[..bytes.len().min(4096)]);
        let mime_type = gtk::gio::content_type_get_mime_type(&content_type)
            .map(|value| value.to_string())
            .unwrap_or_else(|| "application/octet-stream".to_string());
        result.push(NativeAttachmentFile {
            file_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            mime_type,
            bytes_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    Ok(result)
}

/// Bridge user file gestures into the already-running Gateway Control UI.
/// The dashboard is served by the Gateway, not bundled with the AppImage.
pub fn initialization_script(origin: &str) -> String {
    const SCRIPT: &str = r#"(() => {
  const allowedOrigin = __ORIGIN__;
  if (window !== window.top) return;
  function nativeInvoke() {
    const internals = window.__TAURI_INTERNALS__;
    if (internals?.invoke) return internals.invoke.bind(internals);
    const core = window.__TAURI__?.core;
    return core?.invoke?.bind(core);
  }
  function inComposer(target) {
    return target instanceof Element &&
      Boolean(target.closest('.chat, .new-session-page__composer, .chat-session-rail'));
  }
  function forwardFiles(target, files) {
    if (!(target instanceof Element) || !target.isConnected || !inComposer(target)) return;
    const transfer = new DataTransfer();
    for (const entry of files) {
      const raw = atob(entry.bytesBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      transfer.items.add(new File([bytes], entry.fileName, {type: entry.mimeType}));
    }
    if (!transfer.files.length) return;
    const drop = new Event('drop', {bubbles: true, cancelable: true});
    Object.defineProperty(drop, 'dataTransfer', {value: transfer});
    target.dispatchEvent(drop);
  }
  function showFailure(error) {
    const text = String(error);
    console.warn('Native file attachment failed', text);
    document.getElementById('openclaw-native-attachment-error')?.remove();
    const notice = document.createElement('div');
    notice.id = 'openclaw-native-attachment-error';
    notice.setAttribute('role', 'alert');
    notice.textContent = 'Could not attach selected file: ' + text;
    notice.style.cssText = 'position:fixed;z-index:2147483647;left:1rem;bottom:1rem;max-width:32rem;padding:.75rem 1rem;border:1px solid #e55;border-radius:.5rem;background:#2b181b;color:#fff;box-shadow:0 4px 18px #0008';
    document.body.append(notice);
    setTimeout(() => notice.remove(), 10000);
  }
  window.addEventListener('paste', (event) => {
    if (location.origin !== allowedOrigin || !inComposer(event.target)) return;
    const data = event.clipboardData;
    if (!data || !Array.from(data.types || []).includes('text/uri-list')) return;
    if (Array.from(data.items || []).some((item) => item.kind === 'file')) return;
    const invoke = nativeInvoke();
    if (!invoke) return;
    const target = event.target;
    event.preventDefault();
    event.stopImmediatePropagation();
    invoke('native_attachment_files', {token: null})
      .then((files) => forwardFiles(target, files))
      .catch(showFailure);
  }, true);
  window.addEventListener('openclaw-native-attachment-drop', (event) => {
    if (location.origin !== allowedOrigin) return;
    const detail = event.detail;
    if (!detail || typeof detail.token !== 'string') return;
    const scale = window.devicePixelRatio || 1;
    const target = document.elementFromPoint(detail.x / scale, detail.y / scale);
    if (!inComposer(target)) return;
    const invoke = nativeInvoke();
    if (!invoke) return;
    invoke('native_attachment_files', {token: detail.token})
      .then((files) => forwardFiles(target, files))
      .catch(showFailure);
  });
})();"#;
    SCRIPT.replace(
        "__ORIGIN__",
        &serde_json::to_string(origin).unwrap_or_default(),
    )
}

#[tauri::command]
pub async fn native_attachment_files(
    app: AppHandle,
    webview: Webview,
    token: Option<String>,
) -> Result<Vec<NativeAttachmentFile>, String> {
    if !crate::window_chrome::authorized(&app, &webview) {
        return Err("The attachment page is no longer authorized".to_string());
    }
    let label = webview.label().to_string();
    let (document, paths) = if let Some(token) = token {
        let state = app.state::<DropState>();
        let mut authority = state.0.lock().map_err(|_| "Drop state unavailable")?;
        authority.take_drop(&label, &token)?
    } else {
        let document = {
            let state = app.state::<DropState>();
            let mut authority = state.0.lock().map_err(|_| "Paste state unavailable")?;
            authority.take_paste(&label)?
        };
        (document, clipboard_paths(&app)?)
    };
    // Hold document authority through the file reads. Replacement invalidates
    // the document first and therefore waits for any already-admitted read.
    let read_app = app.clone();
    let read_webview = webview.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !crate::window_chrome::authorized(&read_app, &read_webview) {
            return Err("The attachment page changed".to_string());
        }
        let state = read_app.state::<DropState>();
        let authority = state
            .0
            .lock()
            .map_err(|_| "Attachment authority unavailable")?;
        if authority.documents.get(&label) != Some(&document) {
            return Err("The attachment document changed".to_string());
        }
        read_files(paths)
    })
    .await
    .map_err(|_| "Could not read selected files".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_authority_needs_native_paste_and_current_document() {
        let mut authority = AttachmentAuthority::default();
        authority
            .documents
            .insert("main".into(), "document-a".into());
        assert!(authority.take_paste("main").is_err());
        authority.pastes.insert(
            "main".into(),
            PendingPaste {
                document: "document-a".into(),
                created: Instant::now(),
            },
        );
        assert_eq!(authority.take_paste("main").unwrap(), "document-a");
        assert!(authority.take_paste("main").is_err());
        authority.pastes.insert(
            "main".into(),
            PendingPaste {
                document: "document-a".into(),
                created: Instant::now(),
            },
        );
        authority
            .documents
            .insert("main".into(), "document-b".into());
        assert!(authority.take_paste("main").is_err());
    }

    #[test]
    fn drop_token_cannot_cross_windows_or_replaced_documents() {
        let mut authority = AttachmentAuthority::default();
        authority
            .documents
            .insert("main".into(), "document-a".into());
        authority
            .documents
            .insert("other".into(), "document-b".into());
        authority.drops.insert(
            "main".into(),
            PendingDrop {
                token: "token".into(),
                document: "document-a".into(),
                paths: vec![PathBuf::from("/tmp/example")],
                created: Instant::now(),
            },
        );
        assert!(authority.take_drop("other", "token").is_err());
        assert!(authority.take_drop("main", "wrong").is_err());
        authority.drops.insert(
            "main".into(),
            PendingDrop {
                token: "token".into(),
                document: "document-a".into(),
                paths: vec![PathBuf::from("/tmp/example")],
                created: Instant::now(),
            },
        );
        authority
            .documents
            .insert("main".into(), "document-new".into());
        assert!(authority.take_drop("main", "token").is_err());
    }

    #[test]
    fn reads_a_user_selected_file_without_exposing_its_path() {
        let path =
            std::env::temp_dir().join(format!("openclaw-native-{}.txt", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"attachment probe").unwrap();
        let files = read_files(vec![path.clone()]).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(
            files[0].file_name,
            path.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(
            base64::engine::general_purpose::STANDARD
                .decode(&files[0].bytes_base64)
                .unwrap(),
            b"attachment probe"
        );
        assert!(!files[0].file_name.contains("/"));
    }

    #[test]
    fn rejects_directories_and_oversized_batches() {
        assert!(read_files(vec![std::env::temp_dir()]).is_err());
        assert!(read_files(vec![PathBuf::from("ignored"); MAX_FILES + 1]).is_err());
    }

    #[test]
    fn rejects_fifo_without_waiting_for_a_writer() {
        use std::os::unix::ffi::OsStrExt;
        let path = std::env::temp_dir().join(format!(
            "openclaw-attachment-fifo-test-{}",
            std::process::id()
        ));
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let result = read_files(vec![path.clone()]);
        std::fs::remove_file(path).unwrap();
        assert_eq!(
            result.err().as_deref(),
            Some("Only regular files can be attached")
        );
    }

    #[test]
    fn replaced_document_cannot_complete_native_effect() {
        let mut authority = AttachmentAuthority::default();
        authority.documents.insert("main".into(), "first".into());
        assert_eq!(
            authority.with_document("main", "first", || Ok(7)).unwrap(),
            7
        );
        authority.documents.insert("main".into(), "second".into());
        let mut effected = false;
        assert!(authority
            .with_document("main", "first", || {
                effected = true;
                Ok(())
            })
            .is_err());
        assert!(!effected);
    }

    #[test]
    fn actual_read_limit_rejects_growth_past_reported_size() {
        let bytes = std::io::Cursor::new(vec![1_u8, 2, 3, 4]);
        assert_eq!(
            read_bounded(bytes, 3).unwrap_err(),
            "Selected files exceed the attachment size limit"
        );
        assert_eq!(
            read_bounded(std::io::Cursor::new(vec![1_u8, 2, 3]), 3).unwrap(),
            vec![1, 2, 3]
        );
    }

    #[test]
    fn script_scopes_attachment_bridge_to_the_connected_origin() {
        let script = initialization_script("https://gateway.example");
        assert!(script.contains("const allowedOrigin = \"https://gateway.example\""));
        assert!(script.contains("location.origin !== allowedOrigin"));
    }
}
