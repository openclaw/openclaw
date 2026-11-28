//! Work around WebKitGTK 2.50 delivering empty `clipboardData` on image pastes.
//! On Linux, reads image clipboard targets (or copied local image file URIs)
//! from GTK on Ctrl+V / Shift+Insert and context-menu Paste, and dispatches a
//! standard `ClipboardEvent('paste')` carrying `DataTransfer` `File` items.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
use base64::Engine as _;

const MAX_IMAGE_FILE_BYTES: u64 = 25 * 1024 * 1024;
const MAX_IMAGE_FILES: usize = 10;

#[derive(Debug, Clone, Serialize, Eq, PartialEq)]
pub(crate) struct ImagePayload {
    pub(crate) mime: String,
    pub(crate) name: String,
    pub(crate) b64: String,
}

#[derive(Debug, Deserialize)]
#[cfg(any(target_os = "linux", test))]
struct NativePasteRequest {
    nonce: String,
    action: String,
}

pub(crate) fn image_mime_priority(mime: &str) -> u8 {
    match mime {
        "image/png" => 100,
        "image/webp" => 90,
        "image/jpeg" => 85,
        "image/gif" => 80,
        "image/avif" => 75,
        "image/bmp" => 50,
        "image/tiff" => 40,
        other if other.starts_with("image/") && other != "image/svg+xml" => 20,
        _ => 0,
    }
}

pub(crate) fn is_web_native_image_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/avif"
    )
}

pub(crate) fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/avif" => "avif",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

pub(crate) fn mime_for_extension(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

/// Parses `x-special/gnome-copied-files` or `text/uri-list` payloads.
/// Returns `Some` only when every listed URI resolves to a readable regular
/// local image file within `max_bytes` (so non-image file copies pass through).
pub(crate) fn parse_copied_image_uris(
    raw: &str,
    max_bytes: u64,
    max_files: usize,
) -> Option<Vec<(PathBuf, &'static str)>> {
    let mut results = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "copy" || trimmed == "cut" {
            continue;
        }
        let url = tauri::Url::parse(trimmed).ok()?;
        if url.scheme() != "file" {
            return None;
        }
        let path = url.to_file_path().ok()?;
        let mime = mime_for_extension(&path)?;
        let meta = std::fs::metadata(&path).ok()?;
        if !meta.is_file() || meta.len() == 0 || meta.len() > max_bytes {
            return None;
        }
        if results.len() < max_files {
            results.push((path, mime));
        }
    }
    if results.is_empty() {
        None
    } else {
        Some(results)
    }
}

pub(crate) fn delivery_script(payloads: &[ImagePayload]) -> Option<String> {
    if payloads.is_empty() {
        return None;
    }
    let json = serde_json::to_string(payloads).ok()?;
    Some(format!(
        "window.__openclawLinuxClipboardPaste?.deliverImages({json});"
    ))
}

pub(crate) fn initialization_script(nonce: &str) -> String {
    let nonce_json = serde_json::to_string(nonce).expect("nonce serializes as JSON string");
    format!(
        r#"((nonce) => {{
  if (window.__openclawLinuxClipboardPaste) return;

  const NON_TEXT_INPUT_TYPES = new Set([
    "button",
    "checkbox",
    "color",
    "file",
    "hidden",
    "image",
    "radio",
    "range",
    "reset",
    "submit",
  ]);

  const isEditable = (el) => {{
    if (!el || typeof el !== "object") return false;
    const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
    if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (tag === "INPUT") {{
      const inputType = typeof el.type === "string" ? el.type.toLowerCase() : "text";
      if (NON_TEXT_INPUT_TYPES.has(inputType)) return false;
      return !el.disabled && !el.readOnly;
    }}
    return Boolean(el.isContentEditable);
  }};

  const isVisible = (el) => {{
    if (!el || !el.isConnected || el.hidden || typeof el.getBoundingClientRect !== "function") {{
      return false;
    }}
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }};

  const findPasteTarget = () => {{
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {{
      active = active.shadowRoot.activeElement;
    }}
    if (isEditable(active)) return active;
    if (document.documentElement?.classList?.contains("openclaw-native-desktop")) {{
      const candidates = document.querySelectorAll(
        '[data-composer-editor="true"], textarea.new-session-page__message, .agent-chat__input textarea, textarea',
      );
      for (const el of candidates) {{
        if (isEditable(el) && isVisible(el)) return el;
      }}
    }}
    return active || document.body;
  }};

  const decodeBase64 = (b64) => {{
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }};

  const deliverImages = (items) => {{
    if (!Array.isArray(items) || items.length === 0) return false;
    const target = findPasteTarget();
    if (!target || typeof target.dispatchEvent !== "function") return false;
    const dt = new DataTransfer();
    for (const item of items) {{
      if (!item || !item.b64 || !item.mime) continue;
      const bytes = decodeBase64(item.b64);
      const file = new File([bytes], item.name || "image.png", {{ type: item.mime }});
      dt.items.add(file);
    }}
    if (dt.files.length === 0) return false;
    const event = new ClipboardEvent("paste", {{
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    }});
    target.dispatchEvent(event);
    return true;
  }};

  window.__openclawLinuxClipboardPaste = {{ deliverImages }};

  // Fallback for right-click -> Paste when WebKitGTK emits an empty clipboardData for images.
  document.addEventListener(
    "paste",
    (event) => {{
      if (!event.isTrusted) return;
      const cd = event.clipboardData;
      const hasImage =
        Boolean(cd) &&
        ((cd.files && cd.files.length > 0) ||
          Array.from(cd.items || []).some(
            (item) =>
              item.kind === "file" ||
              (typeof item.type === "string" && item.type.startsWith("image/")),
          ));
      if (hasImage) return;
      const plain = cd && typeof cd.getData === "function" ? cd.getData("text/plain") : "";
      if (plain && plain.length > 0) return;
      try {{
        window.webkit?.messageHandlers?.__openclawLinuxClipboardPaste?.postMessage(
          JSON.stringify({{ nonce, action: "paste-image" }}),
        );
      }} catch {{}}
    }},
    true,
  );
}})({nonce_json});"#
    )
}

#[cfg(target_os = "linux")]
const SCRIPT_MESSAGE_HANDLER: &str = "__openclawLinuxClipboardPaste";

#[cfg(target_os = "linux")]
const INSTALLED_DATA_KEY: &str = "openclaw-linux-clipboard-paste-installed";

#[cfg(target_os = "linux")]
const NATIVE_GESTURE_WINDOW: std::time::Duration = std::time::Duration::from_millis(1500);

#[cfg(target_os = "linux")]
fn has_nonempty_text(clipboard: &gtk::Clipboard, atom: &gtk::gdk::Atom) -> bool {
    let Some(selection) = clipboard.wait_for_contents(atom) else {
        return false;
    };
    let bytes = selection.data();
    bytes
        .iter()
        .any(|byte| *byte != 0 && !byte.is_ascii_whitespace())
}

#[cfg(target_os = "linux")]
fn read_copied_image_files(
    clipboard: &gtk::Clipboard,
    uri_atom: &gtk::gdk::Atom,
) -> Option<Vec<ImagePayload>> {
    let selection = clipboard.wait_for_contents(uri_atom)?;
    let data = selection.data();
    let raw = std::str::from_utf8(&data).ok()?;
    let entries = parse_copied_image_uris(raw, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES)?;
    let mut payloads = Vec::with_capacity(entries.len());
    for (path, mime) in entries {
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        if bytes.is_empty() || bytes.len() as u64 > MAX_IMAGE_FILE_BYTES {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("image.png")
            .to_string();
        payloads.push(ImagePayload {
            mime: mime.to_string(),
            name,
            b64: base64::engine::general_purpose::STANDARD.encode(bytes),
        });
    }
    if payloads.is_empty() {
        None
    } else {
        Some(payloads)
    }
}

#[cfg(target_os = "linux")]
fn read_clipboard_images(from_key_event: bool) -> Option<Vec<ImagePayload>> {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    let targets = clipboard.wait_for_targets()?;

    let mut best_img: Option<(gtk::gdk::Atom, String, u8)> = None;
    let mut gnome_files: Option<gtk::gdk::Atom> = None;
    let mut uri_list: Option<gtk::gdk::Atom> = None;
    let mut text_atom: Option<gtk::gdk::Atom> = None;

    for atom in targets {
        let name = atom.name();
        let prio = image_mime_priority(name.as_str());
        if prio > best_img.as_ref().map_or(0, |(_, _, p)| *p) {
            best_img = Some((atom, name.to_string(), prio));
        }
        match name.as_str() {
            "x-special/gnome-copied-files" => gnome_files = Some(atom),
            "text/uri-list" => uri_list = Some(atom),
            "UTF8_STRING" => text_atom = Some(atom),
            "text/plain;charset=utf-8" | "text/plain" if text_atom.is_none() => {
                text_atom = Some(atom);
            }
            _ => {}
        }
    }

    if let Some(uri_atom) = gnome_files.as_ref().or(uri_list.as_ref()) {
        if let Some(payloads) = read_copied_image_files(&clipboard, uri_atom) {
            return Some(payloads);
        }
    }

    let (img_atom, img_mime, _) = best_img?;
    if from_key_event
        && text_atom
            .as_ref()
            .is_some_and(|atom| has_nonempty_text(&clipboard, atom))
    {
        return None;
    }

    let mut encoded: Option<(String, String)> = None;
    if is_web_native_image_mime(&img_mime) {
        if let Some(selection) = clipboard.wait_for_contents(&img_atom) {
            let bytes = selection.data();
            if !bytes.is_empty() && bytes.len() as u64 <= MAX_IMAGE_FILE_BYTES {
                encoded = Some((
                    img_mime.clone(),
                    base64::engine::general_purpose::STANDARD.encode(bytes),
                ));
            }
        }
    }

    if encoded.is_none() {
        if let Some(pixbuf) = clipboard.wait_for_image() {
            if let Ok(png_bytes) = pixbuf.save_to_bufferv("png", &[]) {
                if !png_bytes.is_empty() && png_bytes.len() as u64 <= MAX_IMAGE_FILE_BYTES {
                    encoded = Some((
                        "image/png".to_string(),
                        base64::engine::general_purpose::STANDARD.encode(png_bytes),
                    ));
                }
            }
        }
    }

    let (mime, b64) = encoded?;
    let name = format!("image.{}", ext_for_mime(&mime));
    Some(vec![ImagePayload { mime, name, b64 }])
}

#[cfg(target_os = "linux")]
fn try_deliver_clipboard_images(view: &webkit2gtk::WebView, from_key_event: bool) -> bool {
    use webkit2gtk::WebViewExt;

    let Some(payloads) = read_clipboard_images(from_key_event) else {
        return false;
    };
    let Some(script) = delivery_script(&payloads) else {
        return false;
    };
    view.evaluate_javascript(&script, None, None, gtk::gio::Cancellable::NONE, |_| {});
    true
}

#[cfg(target_os = "linux")]
pub(crate) fn install_webview(webview: &tauri::Webview) -> tauri::Result<()> {
    use gtk::gdk::{keys::constants, ModifierType};
    use gtk::glib::{object::ObjectExt, Propagation};
    use gtk::prelude::WidgetExt;
    use std::cell::Cell;
    use std::rc::Rc;
    use std::time::Instant;
    use webkit2gtk::{
        UserContentInjectedFrames, UserContentManagerExt, UserScript, UserScriptInjectionTime,
        WebViewExt,
    };

    webview.with_webview(|platform| {
        let view = platform.inner();
        // SAFETY: `INSTALLED_DATA_KEY` is only ever used by this module to store `()`.
        if unsafe { view.data::<()>(INSTALLED_DATA_KEY) }.is_some() {
            return;
        }
        unsafe { view.set_data(INSTALLED_DATA_KEY, ()) };

        let nonce = uuid::Uuid::new_v4().to_string();
        let init_script = initialization_script(&nonce);
        let last_native_input: Rc<Cell<Option<Instant>>> = Rc::new(Cell::new(None));

        let mark_press = Rc::clone(&last_native_input);
        view.connect_button_press_event(move |_, _| {
            mark_press.set(Some(Instant::now()));
            Propagation::Proceed
        });
        let mark_release = Rc::clone(&last_native_input);
        view.connect_button_release_event(move |_, _| {
            mark_release.set(Some(Instant::now()));
            Propagation::Proceed
        });
        let mark_ctx = Rc::clone(&last_native_input);
        view.connect_context_menu_dismissed(move |_| {
            mark_ctx.set(Some(Instant::now()));
        });

        let mark_key = Rc::clone(&last_native_input);
        view.connect_key_press_event(move |view, event| {
            mark_key.set(Some(Instant::now()));
            let mods = event.state()
                & (ModifierType::SHIFT_MASK
                    | ModifierType::CONTROL_MASK
                    | ModifierType::MOD1_MASK
                    | ModifierType::SUPER_MASK
                    | ModifierType::META_MASK);
            let keyval = event.keyval();
            let is_ctrl_v = mods == ModifierType::CONTROL_MASK
                && (keyval == constants::v || keyval == constants::V);
            let is_shift_insert = mods == ModifierType::SHIFT_MASK && keyval == constants::Insert;
            if (is_ctrl_v || is_shift_insert) && try_deliver_clipboard_images(view, true) {
                return Propagation::Stop;
            }
            Propagation::Proceed
        });

        if let Some(ucm) = view.user_content_manager() {
            let script = UserScript::new(
                &init_script,
                UserContentInjectedFrames::AllFrames,
                UserScriptInjectionTime::Start,
                &[],
                &[],
            );
            ucm.add_script(&script);

            if ucm.register_script_message_handler(SCRIPT_MESSAGE_HANDLER) {
                let weak_view = view.downgrade();
                let check_input = Rc::clone(&last_native_input);
                ucm.connect_script_message_received(Some(SCRIPT_MESSAGE_HANDLER), move |_, msg| {
                    let Some(view) = weak_view.upgrade() else {
                        return;
                    };
                    let recent_gesture = check_input
                        .get()
                        .is_some_and(|at| at.elapsed() <= NATIVE_GESTURE_WINDOW);
                    if !recent_gesture {
                        return;
                    }
                    let Some(raw) = msg.js_value().map(|value| value.to_string()) else {
                        return;
                    };
                    let Ok(req) = serde_json::from_str::<NativePasteRequest>(&raw) else {
                        return;
                    };
                    if req.nonce != nonce || req.action != "paste-image" {
                        return;
                    }
                    check_input.set(None);
                    try_deliver_clipboard_images(&view, false);
                });
            }
        }

        view.evaluate_javascript(
            &init_script,
            None,
            None,
            gtk::gio::Cancellable::NONE,
            |_| {},
        );
    })
}

#[cfg(test)]
mod tests {
    use super::{
        delivery_script, ext_for_mime, image_mime_priority, initialization_script,
        is_web_native_image_mime, mime_for_extension, parse_copied_image_uris, ImagePayload,
        MAX_IMAGE_FILES, MAX_IMAGE_FILE_BYTES,
    };
    use std::path::Path;
    use std::process::Command;

    #[test]
    fn mime_priority_and_extension_helpers_handle_common_image_formats() {
        assert!(image_mime_priority("image/png") > image_mime_priority("image/jpeg"));
        assert!(image_mime_priority("image/webp") > image_mime_priority("image/bmp"));
        assert_eq!(image_mime_priority("image/svg+xml"), 0);
        assert_eq!(image_mime_priority("text/plain"), 0);
        assert!(is_web_native_image_mime("image/png"));
        assert!(is_web_native_image_mime("image/webp"));
        assert!(!is_web_native_image_mime("image/bmp"));
        assert_eq!(ext_for_mime("image/jpeg"), "jpg");
        assert_eq!(ext_for_mime("image/png"), "png");
        assert_eq!(mime_for_extension(Path::new("shot.PNG")), Some("image/png"));
        assert_eq!(
            mime_for_extension(Path::new("photo.jpg")),
            Some("image/jpeg")
        );
        assert_eq!(mime_for_extension(Path::new("notes.txt")), None);
    }

    #[test]
    fn parse_copied_image_uris_accepts_local_images_and_rejects_non_images() {
        let dir =
            std::env::temp_dir().join(format!("openclaw-paste-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("my screenshot.png");
        let txt = dir.join("notes.txt");
        let empty = dir.join("empty.png");
        std::fs::write(&img, b"\x89PNG\r\n\x1a\nfake").unwrap();
        std::fs::write(&txt, b"hello").unwrap();
        std::fs::write(&empty, b"").unwrap();

        let img_uri = tauri::Url::from_file_path(&img).unwrap();
        let txt_uri = tauri::Url::from_file_path(&txt).unwrap();
        let empty_uri = tauri::Url::from_file_path(&empty).unwrap();

        let gnome_payload = format!("copy\n{img_uri}\n");
        let parsed =
            parse_copied_image_uris(&gnome_payload, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES).unwrap();
        assert_eq!(parsed, vec![(img.clone(), "image/png")]);

        // Mixed image + non-image list must not hijack normal paste.
        let mixed = format!("copy\n{img_uri}\n{txt_uri}\n");
        assert!(parse_copied_image_uris(&mixed, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES).is_none());

        // Empty or oversized files are rejected.
        assert!(
            parse_copied_image_uris(empty_uri.as_str(), MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES)
                .is_none()
        );
        assert!(parse_copied_image_uris(img_uri.as_str(), 4, MAX_IMAGE_FILES).is_none());

        // Non-file URIs are rejected.
        assert!(
            parse_copied_image_uris("https://example.com/a.png", MAX_IMAGE_FILE_BYTES, 10)
                .is_none()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_script_delivers_images_and_requests_native_fallback_only_for_empty_trusted_paste() {
        let init = initialization_script("nonce-123");
        let deliver = delivery_script(&[ImagePayload {
            mime: "image/png".to_string(),
            name: "shot.png".to_string(),
            b64: "iVBORw0K".to_string(),
        }])
        .unwrap();

        let runner = r#"
const initScript = process.argv[1];
const deliverScript = process.argv[2];
const pasteListeners = [];
const dispatched = [];
const posted = [];

class FakeDataTransfer {
  constructor() {
    this.files = [];
    this.items = {
      add: (file) => {
        this.files.push(file);
      },
    };
  }
}

class FakeClipboardEvent {
  constructor(type, init) {
    this.type = type;
    this.bubbles = Boolean(init?.bubbles);
    this.cancelable = Boolean(init?.cancelable);
    this.clipboardData = init?.clipboardData ?? null;
  }
}

globalThis.DataTransfer = FakeDataTransfer;
globalThis.ClipboardEvent = FakeClipboardEvent;

const composer = {
  tagName: "TEXTAREA",
  disabled: false,
  readOnly: false,
  isConnected: true,
  hidden: false,
  getBoundingClientRect: () => ({ width: 300, height: 60 }),
  dispatchEvent(ev) {
    dispatched.push({ target: "composer", ev });
    return true;
  },
};

globalThis.window = {
  webkit: {
    messageHandlers: {
      __openclawLinuxClipboardPaste: {
        postMessage(payload) {
          posted.push(JSON.parse(payload));
        },
      },
    },
  },
};

globalThis.document = {
  documentElement: {
    classList: { contains: (cls) => cls === "openclaw-native-desktop" },
  },
  body: { tagName: "BODY" },
  activeElement: null,
  querySelectorAll: () => [composer],
  addEventListener(type, fn, capture) {
    if (type === "paste") pasteListeners.push({ fn, capture });
  },
};
document.activeElement = document.body;

new Function(initScript)();
// Idempotent second run.
new Function(initScript)();
if (pasteListeners.length !== 1 || !pasteListeners[0].capture) {
  throw new Error(`unexpected paste listeners: ${pasteListeners.length}`);
}

// 1. deliverImages falls back to visible OpenClaw composer when body is focused.
new Function(deliverScript)();
if (dispatched.length !== 1 || dispatched[0].target !== "composer") {
  throw new Error(`expected delivery to composer, got ${dispatched.length}`);
}
const file = dispatched[0].ev.clipboardData.files[0];
if (file.name !== "shot.png" || file.type !== "image/png" || file.size !== 6) {
  throw new Error(`unexpected file: ${file.name} ${file.type} ${file.size}`);
}

// 2. Trusted empty paste triggers native fallback with the nonce.
pasteListeners[0].fn({
  isTrusted: true,
  clipboardData: { files: [], items: [], getData: () => "" },
});
if (posted.length !== 1 || posted[0].nonce !== "nonce-123" || posted[0].action !== "paste-image") {
  throw new Error(`unexpected native post: ${JSON.stringify(posted)}`);
}

// 3. Untrusted (synthetic) paste must not recurse.
pasteListeners[0].fn({
  isTrusted: false,
  clipboardData: { files: [], items: [], getData: () => "" },
});
// 4. Plain-text paste must not trigger image fallback.
pasteListeners[0].fn({
  isTrusted: true,
  clipboardData: { files: [], items: [{ kind: "string", type: "text/plain" }], getData: () => "hello" },
});
// 5. Paste that already carries an image must not double-paste.
pasteListeners[0].fn({
  isTrusted: true,
  clipboardData: { files: [file], items: [{ kind: "file", type: "image/png" }], getData: () => "" },
});
if (posted.length !== 1) {
  throw new Error(`expected only 1 native post, got ${posted.length}`);
}
"#;
        let output = Command::new("node")
            .args(["-e", runner, &init, &deliver])
            .output()
            .expect("Node is required by the OpenClaw workspace");
        assert!(
            output.status.success(),
            "linux clipboard paste script test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
