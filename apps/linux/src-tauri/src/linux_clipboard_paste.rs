//! Work around WebKitGTK 2.50 delivering empty `clipboardData` on image pastes
//! and pasting raw file paths for copied local image files.
//! On Linux, installed only on Gateway dashboard webviews, reads image clipboard
//! targets (or copied local image file URIs) from GTK on Ctrl+V / Shift+Insert
//! and context-menu Paste when an attachment-capable composer is active, and
//! dispatches a standard `ClipboardEvent('paste')` carrying `DataTransfer`
//! `File` items.

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

#[derive(Debug, Clone, Eq, PartialEq)]
pub(crate) enum CopiedImages {
    None,
    Ready(Vec<(PathBuf, &'static str)>),
    TooMany { count: usize, max: usize },
}

#[derive(Debug, Deserialize)]
#[cfg(any(target_os = "linux", test))]
struct NativePasteRequest {
    nonce: String,
    action: String,
    #[serde(default)]
    active: Option<bool>,
    #[serde(default)]
    fallback_text: Option<String>,
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
/// Returns `Ready` only when every listed URI resolves to a readable regular
/// local image file within `max_bytes` and the total count does not exceed
/// `max_files`. When every entry is a valid local image file but there are more
/// than `max_files`, returns `TooMany` instead of silently truncating.
pub(crate) fn parse_copied_image_uris(raw: &str, max_bytes: u64, max_files: usize) -> CopiedImages {
    let mut results = Vec::new();
    let mut total_count = 0usize;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') || trimmed == "copy" || trimmed == "cut" {
            continue;
        }
        let Ok(url) = tauri::Url::parse(trimmed) else {
            return CopiedImages::None;
        };
        if url.scheme() != "file" {
            return CopiedImages::None;
        }
        let Ok(path) = url.to_file_path() else {
            return CopiedImages::None;
        };
        let Some(mime) = mime_for_extension(&path) else {
            return CopiedImages::None;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            return CopiedImages::None;
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > max_bytes {
            return CopiedImages::None;
        }
        total_count += 1;
        if results.len() < max_files {
            results.push((path, mime));
        }
    }
    if total_count == 0 {
        CopiedImages::None
    } else if total_count > max_files {
        CopiedImages::TooMany {
            count: total_count,
            max: max_files,
        }
    } else {
        CopiedImages::Ready(results)
    }
}

pub(crate) fn delivery_script(
    payloads: &[ImagePayload],
    fallback_text: Option<&str>,
) -> Option<String> {
    if payloads.is_empty() {
        return None;
    }
    let json = serde_json::to_string(payloads).ok()?;
    let fallback_json = serde_json::to_string(&fallback_text).ok()?;
    Some(format!(
        "window.__openclawLinuxClipboardPaste?.deliverImages({json}, {fallback_json});"
    ))
}

pub(crate) fn limit_exceeded_script(count: usize, max: usize) -> String {
    format!("window.__openclawLinuxClipboardPaste?.reportLimitExceeded({count}, {max});")
}

pub(crate) fn fallback_text_script(text: &str) -> Option<String> {
    let text_json = serde_json::to_string(text).ok()?;
    Some(format!(
        "window.__openclawLinuxClipboardPaste?.insertFallbackText({text_json});"
    ))
}

pub(crate) fn initialization_script(nonce: &str) -> String {
    let nonce_json = serde_json::to_string(nonce).expect("nonce serializes as JSON string");
    format!(
        r##"((nonce) => {{
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
  const ATTACHMENT_COMPOSER_SELECTOR =
    '[data-attachment-composer="true"], [data-composer-editor="true"], textarea.new-session-page__message, textarea.chat-session-rail__input, .agent-chat__input textarea, .chat-session-rail__prompt textarea, [aria-labelledby="cmd-palette-tab-compose"] textarea';
  const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif)$/i;

  const postNative = (payload) => {{
    try {{
      window.webkit?.messageHandlers?.__openclawLinuxClipboardPaste?.postMessage(
        JSON.stringify({{ nonce, ...payload }}),
      );
    }} catch {{}}
  }};

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

  const isAttachmentComposer = (el) => {{
    if (!isEditable(el)) return false;
    if (typeof el.closest === "function" && el.closest('[aria-labelledby="cmd-palette-tab-search"]')) {{
      return false;
    }}
    if (
      typeof el.matches === "function" &&
      el.matches(
        '[data-attachment-composer="true"], [data-composer-editor="true"], textarea.new-session-page__message, textarea.chat-session-rail__input',
      )
    ) {{
      return true;
    }}
    if (
      typeof el.closest === "function" &&
      el.closest('.agent-chat__input, .chat-session-rail__prompt, [aria-labelledby="cmd-palette-tab-compose"]')
    ) {{
      return true;
    }}
    return false;
  }};

  const isVisible = (el) => {{
    if (!el || !el.isConnected || el.hidden || typeof el.getBoundingClientRect !== "function") {{
      return false;
    }}
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }};

  const getActiveElement = () => {{
    let active = document.activeElement;
    while (active && active.shadowRoot && active.shadowRoot.activeElement) {{
      active = active.shadowRoot.activeElement;
    }}
    return active;
  }};

  const findAttachmentComposer = () => {{
    const active = getActiveElement();
    if (isEditable(active)) {{
      return isAttachmentComposer(active) ? active : null;
    }}
    if (typeof document.querySelectorAll !== "function") return null;
    const candidates = document.querySelectorAll(ATTACHMENT_COMPOSER_SELECTOR);
    for (const el of candidates) {{
      if (isAttachmentComposer(el) && isVisible(el)) return el;
    }}
    return null;
  }};

  let lastReportedActive = null;
  const syncTargetState = () => {{
    const active = Boolean(findAttachmentComposer());
    if (active === lastReportedActive) return;
    lastReportedActive = active;
    postNative({{ action: "target-state", active }});
  }};

  const scheduleTargetSync = () => {{
    if (typeof queueMicrotask === "function") {{
      queueMicrotask(syncTargetState);
    }} else {{
      syncTargetState();
    }}
  }};

  const insertFallbackText = (text) => {{
    if (typeof text !== "string" || text.length === 0) return false;
    const active = getActiveElement();
    if (!isEditable(active)) return false;
    try {{
      if (typeof document.execCommand === "function" && document.execCommand("insertText", false, text)) {{
        return true;
      }}
    }} catch {{}}
    if (typeof active.value === "string") {{
      const start = typeof active.selectionStart === "number" ? active.selectionStart : active.value.length;
      const end = typeof active.selectionEnd === "number" ? active.selectionEnd : active.value.length;
      active.value = active.value.slice(0, start) + text + active.value.slice(end);
      if (typeof active.setSelectionRange === "function") {{
        active.setSelectionRange(start + text.length, start + text.length);
      }}
      if (typeof active.dispatchEvent === "function" && typeof Event === "function") {{
        active.dispatchEvent(new Event("input", {{ bubbles: true }}));
      }}
      return true;
    }}
    return false;
  }};

  const looksLikeCopiedImagePaths = (text) => {{
    if (typeof text !== "string" || !text.trim()) return false;
    let count = 0;
    for (const rawLine of text.split(/\r?\n/)) {{
      const line = rawLine.trim();
      if (!line || line === "copy" || line === "cut") continue;
      if (!(line.startsWith("/") || line.startsWith("file://"))) return false;
      if (!IMAGE_EXT_RE.test(line)) return false;
      count += 1;
    }}
    return count > 0;
  }};

  const decodeBase64 = (b64) => {{
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }};

  const deliverImages = (items, fallbackText = null) => {{
    if (!Array.isArray(items) || items.length === 0) return false;
    const target = findAttachmentComposer();
    if (!target || typeof target.dispatchEvent !== "function") {{
      return insertFallbackText(fallbackText);
    }}
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
    if (!event.defaultPrevented && fallbackText) {{
      return insertFallbackText(fallbackText);
    }}
    return true;
  }};

  let noticeTimer = null;
  const reportLimitExceeded = (count, max) => {{
    const message = `Cannot paste ${{count}} images at once. Copy up to ${{max}} images at a time.`;
    if (typeof document.createElement === "function" && document.body) {{
      let notice =
        typeof document.getElementById === "function"
          ? document.getElementById("openclaw-linux-clipboard-notice")
          : null;
      if (!notice) {{
        notice = document.createElement("div");
        notice.id = "openclaw-linux-clipboard-notice";
        notice.setAttribute("role", "alert");
        notice.setAttribute("aria-live", "assertive");
        if (notice.style) {{
          notice.style.position = "fixed";
          notice.style.left = "50%";
          notice.style.bottom = "20px";
          notice.style.transform = "translateX(-50%)";
          notice.style.zIndex = "2147483647";
          notice.style.padding = "10px 14px";
          notice.style.borderRadius = "8px";
          notice.style.background = "rgba(32, 24, 24, 0.96)";
          notice.style.color = "#fff5f5";
          notice.style.border = "1px solid rgba(255, 118, 118, 0.55)";
          notice.style.boxShadow = "0 8px 24px rgba(0, 0, 0, 0.35)";
          notice.style.font = "500 13px/1.4 system-ui, -apple-system, sans-serif";
          notice.style.maxWidth = "min(460px, calc(100vw - 32px))";
        }}
        document.body.appendChild(notice);
      }}
      notice.textContent = message;
      if (notice.style) notice.style.display = "block";
      if (noticeTimer !== null && typeof clearTimeout === "function") {{
        clearTimeout(noticeTimer);
      }}
      if (typeof setTimeout === "function") {{
        noticeTimer = setTimeout(() => {{
          if (notice.style) notice.style.display = "none";
          noticeTimer = null;
        }}, 6000);
      }}
    }}
    if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {{
      window.dispatchEvent(
        new CustomEvent("openclaw:clipboard-paste-error", {{
          detail: {{ code: "too_many_images", count, max, message }},
        }}),
      );
    }}
    return message;
  }};

  window.__openclawLinuxClipboardPaste = {{
    deliverImages,
    insertFallbackText,
    reportLimitExceeded,
    syncTargetState,
  }};

  document.addEventListener("focusin", syncTargetState, true);
  document.addEventListener("focusout", scheduleTargetSync, true);
  document.addEventListener("pointerdown", scheduleTargetSync, true);
  document.addEventListener("click", scheduleTargetSync, true);
  document.addEventListener("DOMContentLoaded", syncTargetState, false);
  if (typeof window.addEventListener === "function") {{
    window.addEventListener("load", syncTargetState, false);
    window.addEventListener("blur", scheduleTargetSync, false);
  }}
  syncTargetState();

  // Fallback for right-click -> Paste when WebKitGTK emits an empty clipboardData
  // for screenshots or plain file-path text for copied local image files.
  document.addEventListener(
    "paste",
    (event) => {{
      if (!event.isTrusted) return;
      const target = event.target;
      if (isEditable(target) && !isAttachmentComposer(target)) return;
      if (!isAttachmentComposer(target) && !findAttachmentComposer()) return;

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
      if (!plain || plain.length === 0) {{
        postNative({{ action: "paste-image" }});
        return;
      }}
      if (looksLikeCopiedImagePaths(plain)) {{
        if (typeof event.preventDefault === "function") {{
          event.preventDefault();
        }}
        postNative({{ action: "paste-image", fallback_text: plain }});
      }}
    }},
    true,
  );
}})({nonce_json});"##
    )
}

#[cfg(target_os = "linux")]
const SCRIPT_MESSAGE_HANDLER: &str = "__openclawLinuxClipboardPaste";

#[cfg(target_os = "linux")]
const INSTALLED_DATA_KEY: &str = "openclaw-linux-clipboard-paste-installed";

#[cfg(target_os = "linux")]
const NATIVE_GESTURE_WINDOW: std::time::Duration = std::time::Duration::from_millis(1500);

#[cfg(target_os = "linux")]
enum CopiedFilePayloads {
    None,
    Ready(Vec<ImagePayload>),
    TooMany { count: usize, max: usize },
}

#[cfg(target_os = "linux")]
enum ClipboardImageResult {
    None,
    Images {
        payloads: Vec<ImagePayload>,
        fallback_text: Option<String>,
    },
    TooMany {
        count: usize,
        max: usize,
    },
}

#[cfg(target_os = "linux")]
fn read_nonempty_text(clipboard: &gtk::Clipboard, atom: &gtk::gdk::Atom) -> Option<String> {
    let selection = clipboard.wait_for_contents(atom)?;
    let bytes = selection.data();
    let trimmed_nul = bytes.split(|byte| *byte == 0).next().unwrap_or(&bytes);
    let text = std::str::from_utf8(trimmed_nul).ok()?;
    if text.trim().is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

#[cfg(target_os = "linux")]
fn read_copied_image_files(
    clipboard: &gtk::Clipboard,
    uri_atom: &gtk::gdk::Atom,
) -> CopiedFilePayloads {
    let Some(selection) = clipboard.wait_for_contents(uri_atom) else {
        return CopiedFilePayloads::None;
    };
    let data = selection.data();
    let Ok(raw) = std::str::from_utf8(&data) else {
        return CopiedFilePayloads::None;
    };
    let entries = match parse_copied_image_uris(raw, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES) {
        CopiedImages::None => return CopiedFilePayloads::None,
        CopiedImages::TooMany { count, max } => {
            return CopiedFilePayloads::TooMany { count, max };
        }
        CopiedImages::Ready(entries) => entries,
    };
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
        CopiedFilePayloads::None
    } else {
        CopiedFilePayloads::Ready(payloads)
    }
}

#[cfg(target_os = "linux")]
fn read_clipboard_images(prefer_text_over_mixed_image: bool) -> ClipboardImageResult {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    let Some(targets) = clipboard.wait_for_targets() else {
        return ClipboardImageResult::None;
    };

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

    let fallback_text = text_atom
        .as_ref()
        .and_then(|atom| read_nonempty_text(&clipboard, atom));

    if let Some(uri_atom) = gnome_files.as_ref().or(uri_list.as_ref()) {
        match read_copied_image_files(&clipboard, uri_atom) {
            CopiedFilePayloads::Ready(payloads) => {
                return ClipboardImageResult::Images {
                    payloads,
                    fallback_text,
                };
            }
            CopiedFilePayloads::TooMany { count, max } => {
                return ClipboardImageResult::TooMany { count, max };
            }
            CopiedFilePayloads::None => {}
        }
    }

    let Some((img_atom, img_mime, _)) = best_img else {
        return ClipboardImageResult::None;
    };
    if prefer_text_over_mixed_image && fallback_text.is_some() {
        return ClipboardImageResult::None;
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

    let Some((mime, b64)) = encoded else {
        return ClipboardImageResult::None;
    };
    let name = format!("image.{}", ext_for_mime(&mime));
    ClipboardImageResult::Images {
        payloads: vec![ImagePayload { mime, name, b64 }],
        fallback_text,
    }
}

#[cfg(target_os = "linux")]
fn try_deliver_clipboard_images(
    view: &webkit2gtk::WebView,
    from_key_event: bool,
    js_fallback_text: Option<&str>,
) -> bool {
    use webkit2gtk::WebViewExt;

    match read_clipboard_images(from_key_event) {
        ClipboardImageResult::Images {
            payloads,
            fallback_text,
        } => {
            let fallback = js_fallback_text.or(fallback_text.as_deref());
            let Some(script) = delivery_script(&payloads, fallback) else {
                return false;
            };
            view.evaluate_javascript(&script, None, None, gtk::gio::Cancellable::NONE, |_| {});
            true
        }
        ClipboardImageResult::TooMany { count, max } => {
            let script = limit_exceeded_script(count, max);
            view.evaluate_javascript(&script, None, None, gtk::gio::Cancellable::NONE, |_| {});
            true
        }
        ClipboardImageResult::None => {
            if let Some(text) = js_fallback_text {
                if let Some(script) = fallback_text_script(text) {
                    view.evaluate_javascript(
                        &script,
                        None,
                        None,
                        gtk::gio::Cancellable::NONE,
                        |_| {},
                    );
                }
            }
            false
        }
    }
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
        ContextMenuAction, ContextMenuExt, ContextMenuItem, ContextMenuItemExt,
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
        let attachment_target_active: Rc<Cell<bool>> = Rc::new(Cell::new(false));

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
        let mark_ctx_open = Rc::clone(&last_native_input);
        let check_ctx_target = Rc::clone(&attachment_target_active);
        view.connect_context_menu(move |view, menu, _, _| {
            mark_ctx_open.set(Some(Instant::now()));
            if !check_ctx_target.get() {
                return false;
            }
            let items = menu.items();
            for (index, item) in items.iter().enumerate() {
                if item.stock_action() == ContextMenuAction::Paste {
                    let action = gtk::gio::SimpleAction::new("openclaw-paste-image", None);
                    let weak_view = view.downgrade();
                    action.connect_activate(move |_, _| {
                        if let Some(view) = weak_view.upgrade() {
                            if !try_deliver_clipboard_images(&view, true, None) {
                                view.execute_editing_command("Paste");
                            }
                        }
                    });
                    let replacement = ContextMenuItem::from_gaction(&action, "Paste", None);
                    menu.remove(item);
                    menu.insert(&replacement, index as i32);
                    break;
                }
            }
            false
        });
        let mark_ctx = Rc::clone(&last_native_input);
        view.connect_context_menu_dismissed(move |_| {
            mark_ctx.set(Some(Instant::now()));
        });

        let mark_key = Rc::clone(&last_native_input);
        let check_target_active = Rc::clone(&attachment_target_active);
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
            if (is_ctrl_v || is_shift_insert)
                && check_target_active.get()
                && try_deliver_clipboard_images(view, true, None)
            {
                return Propagation::Stop;
            }
            Propagation::Proceed
        });

        if let Some(ucm) = view.user_content_manager() {
            let script = UserScript::new(
                &init_script,
                UserContentInjectedFrames::TopFrame,
                UserScriptInjectionTime::Start,
                &[],
                &[],
            );
            ucm.add_script(&script);

            if ucm.register_script_message_handler(SCRIPT_MESSAGE_HANDLER) {
                let weak_view = view.downgrade();
                let check_input = Rc::clone(&last_native_input);
                let set_target_active = Rc::clone(&attachment_target_active);
                ucm.connect_script_message_received(Some(SCRIPT_MESSAGE_HANDLER), move |_, msg| {
                    let Some(view) = weak_view.upgrade() else {
                        return;
                    };
                    let Some(raw) = msg.js_value().map(|value| value.to_string()) else {
                        return;
                    };
                    let Ok(req) = serde_json::from_str::<NativePasteRequest>(&raw) else {
                        return;
                    };
                    if req.nonce != nonce {
                        return;
                    }
                    if req.action == "target-state" {
                        set_target_active.set(req.active.unwrap_or(false));
                        return;
                    }
                    if req.action != "paste-image" {
                        return;
                    }
                    let recent_gesture = check_input
                        .get()
                        .is_some_and(|at| at.elapsed() <= NATIVE_GESTURE_WINDOW);
                    if !recent_gesture {
                        return;
                    }
                    check_input.set(None);
                    try_deliver_clipboard_images(&view, false, req.fallback_text.as_deref());
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
        is_web_native_image_mime, limit_exceeded_script, mime_for_extension,
        parse_copied_image_uris, CopiedImages, ImagePayload, MAX_IMAGE_FILES, MAX_IMAGE_FILE_BYTES,
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
    fn parse_copied_image_uris_accepts_local_images_rejects_non_images_and_reports_over_limit() {
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
        assert_eq!(
            parse_copied_image_uris(&gnome_payload, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES),
            CopiedImages::Ready(vec![(img.clone(), "image/png")])
        );

        // 11 valid local PNGs must report TooMany instead of silently truncating to 10.
        let mut eleven_payload = String::from("copy\n");
        for idx in 1..=11 {
            let p = dir.join(format!("img-{idx:02}.png"));
            std::fs::write(&p, b"\x89PNG\r\n\x1a\nfake").unwrap();
            let u = tauri::Url::from_file_path(&p).unwrap();
            eleven_payload.push_str(u.as_str());
            eleven_payload.push('\n');
        }
        assert_eq!(
            parse_copied_image_uris(&eleven_payload, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES),
            CopiedImages::TooMany {
                count: 11,
                max: MAX_IMAGE_FILES,
            }
        );

        // Mixed image + non-image list must not hijack normal paste (even when >10 entries).
        let mixed = format!("copy\n{img_uri}\n{txt_uri}\n");
        assert_eq!(
            parse_copied_image_uris(&mixed, MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES),
            CopiedImages::None
        );

        // Empty or oversized files are rejected.
        assert_eq!(
            parse_copied_image_uris(empty_uri.as_str(), MAX_IMAGE_FILE_BYTES, MAX_IMAGE_FILES),
            CopiedImages::None
        );
        assert_eq!(
            parse_copied_image_uris(img_uri.as_str(), 4, MAX_IMAGE_FILES),
            CopiedImages::None
        );

        // Non-file URIs are rejected.
        assert_eq!(
            parse_copied_image_uris("https://example.com/a.png", MAX_IMAGE_FILE_BYTES, 10),
            CopiedImages::None
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn injected_script_scopes_paste_to_attachment_composers_and_surfaces_limit_errors() {
        let init = initialization_script("nonce-123");
        let deliver = delivery_script(
            &[ImagePayload {
                mime: "image/png".to_string(),
                name: "shot.png".to_string(),
                b64: "iVBORw0K".to_string(),
            }],
            Some("/tmp/shot.png"),
        )
        .unwrap();
        let limit_script = limit_exceeded_script(11, MAX_IMAGE_FILES);

        let runner = r#"
const initScript = process.argv[1];
const deliverScript = process.argv[2];
const limitScript = process.argv[3];
const docListeners = new Map();
const dispatched = [];
const posted = [];
const insertedTexts = [];
const createdElements = [];
const customEvents = [];

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
    this.defaultPrevented = false;
  }
  preventDefault() {
    this.defaultPrevented = true;
  }
}

class FakeCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init?.detail;
  }
}

globalThis.DataTransfer = FakeDataTransfer;
globalThis.ClipboardEvent = FakeClipboardEvent;
globalThis.CustomEvent = FakeCustomEvent;

let composerPreventsDefault = true;
const composer = {
  tagName: "TEXTAREA",
  disabled: false,
  readOnly: false,
  isConnected: true,
  hidden: false,
  matches: (sel) => sel.includes("new-session-page__message"),
  closest: (sel) => (sel.includes(".agent-chat__input") ? {} : null),
  getBoundingClientRect: () => ({ width: 300, height: 60 }),
  dispatchEvent(ev) {
    if (composerPreventsDefault) ev.preventDefault();
    dispatched.push({ target: "composer", ev });
    return !ev.defaultPrevented;
  },
};

const searchInput = {
  tagName: "INPUT",
  type: "search",
  disabled: false,
  readOnly: false,
  isConnected: true,
  hidden: false,
  matches: () => false,
  closest: () => null,
  getBoundingClientRect: () => ({ width: 200, height: 32 }),
  dispatchEvent(ev) {
    dispatched.push({ target: "searchInput", ev });
    return true;
  },
};

const paletteSearchInput = {
  tagName: "TEXTAREA",
  disabled: false,
  readOnly: false,
  isConnected: true,
  hidden: false,
  matches: () => false,
  closest: (sel) =>
    sel.includes('cmd-palette-tab-search') || sel.includes('.agent-chat__input') ? {} : null,
  getBoundingClientRect: () => ({ width: 280, height: 40 }),
  dispatchEvent(ev) {
    dispatched.push({ target: "paletteSearchInput", ev });
    return true;
  },
};

globalThis.window = {
  addEventListener() {},
  dispatchEvent(ev) {
    customEvents.push(ev);
    return true;
  },
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

const bodyChildren = [];
globalThis.document = {
  body: {
    tagName: "BODY",
    appendChild(el) {
      bodyChildren.push(el);
    },
  },
  activeElement: null,
  querySelectorAll: () => [composer],
  getElementById: (id) => bodyChildren.find((el) => el.id === id) || null,
  createElement(tag) {
    const attrs = {};
    const el = {
      tagName: tag.toUpperCase(),
      id: "",
      style: {},
      textContent: "",
      attrs,
      setAttribute(k, v) {
        attrs[k] = v;
      },
    };
    createdElements.push(el);
    return el;
  },
  execCommand(cmd, _ui, value) {
    if (cmd === "insertText") {
      insertedTexts.push(value);
      return true;
    }
    return false;
  },
  addEventListener(type, fn, capture) {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push({ fn, capture });
  },
};
document.activeElement = document.body;

new Function(initScript)();
// Idempotent second run.
new Function(initScript)();
const pasteListeners = docListeners.get("paste") || [];
if (pasteListeners.length !== 1 || !pasteListeners[0].capture) {
  throw new Error(`unexpected paste listeners: ${pasteListeners.length}`);
}

// Initial sync sees visible composer while body is focused -> target-state active=true.
if (posted.length !== 1 || posted[0].action !== "target-state" || posted[0].active !== true) {
  throw new Error(`expected initial active target-state, got ${JSON.stringify(posted)}`);
}

// 1. deliverImages delivers to visible attachment composer when body is focused.
new Function(deliverScript)();
if (dispatched.length !== 1 || dispatched[0].target !== "composer") {
  throw new Error(`expected delivery to composer, got ${dispatched.length}`);
}
const file = dispatched[0].ev.clipboardData.files[0];
if (file.name !== "shot.png" || file.type !== "image/png" || file.size !== 6) {
  throw new Error(`unexpected file: ${file.name} ${file.type} ${file.size}`);
}

// 2. Focusing a text-only input sets target-state active=false and preserves native text paste.
document.activeElement = searchInput;
for (const l of docListeners.get("focusin")) l.fn({ target: searchInput });
const lastState = posted[posted.length - 1];
if (lastState.action !== "target-state" || lastState.active !== false) {
  throw new Error(`expected active=false for search input, got ${JSON.stringify(lastState)}`);
}
// If deliverImages were ever invoked while searchInput is focused, it must NOT dispatch image
// paste and must fall back to inserting fallbackText.
dispatched.length = 0;
new Function(deliverScript)();
if (dispatched.length !== 0 || insertedTexts[0] !== "/tmp/shot.png") {
  throw new Error(`search input fallback failed: dispatched=${dispatched.length} texts=${JSON.stringify(insertedTexts)}`);
}

// 2b. Command Palette search mode is also treated as text-only (active=false).
document.activeElement = paletteSearchInput;
for (const l of docListeners.get("focusin")) l.fn({ target: paletteSearchInput });
if (posted[posted.length - 1].active !== false) {
  throw new Error("Command Palette search mode must not activate image paste interception");
}

// 2c. Context-menu paste into text-only input must NOT request native image paste.
const beforeTextPasteCount = posted.length;
let prevented = false;
pasteListeners[0].fn({
  isTrusted: true,
  target: searchInput,
  clipboardData: { files: [], items: [{ kind: "string", type: "text/plain" }], getData: () => "/tmp/shot.png" },
  preventDefault() { prevented = true; },
});
if (prevented || posted.length !== beforeTextPasteCount) {
  throw new Error("text-only input paste should stay native");
}

// 3. Back in attachment composer: trusted empty paste & copied-image-path paste request native fallback.
document.activeElement = composer;
for (const l of docListeners.get("focusin")) l.fn({ target: composer });
if (posted[posted.length - 1].active !== true) {
  throw new Error("expected active=true when composer focused");
}
const pastePostsBefore = posted.length;
pasteListeners[0].fn({
  isTrusted: true,
  target: composer,
  clipboardData: { files: [], items: [], getData: () => "" },
});
if (posted.length !== pastePostsBefore + 1 || posted[posted.length - 1].action !== "paste-image") {
  throw new Error(`expected empty paste to request paste-image: ${JSON.stringify(posted)}`);
}

prevented = false;
pasteListeners[0].fn({
  isTrusted: true,
  target: composer,
  clipboardData: {
    files: [],
    items: [{ kind: "string", type: "text/plain" }],
    getData: () => "/tmp/shot.png",
  },
  preventDefault() { prevented = true; },
});
if (!prevented || posted[posted.length - 1].fallback_text !== "/tmp/shot.png") {
  throw new Error(`expected copied image path context-menu paste to preventDefault and send fallback_text: ${JSON.stringify(posted[posted.length - 1])}`);
}

// 4. Ordinary text, untrusted paste, and native image paste must NOT trigger native fallback.
const countAfterValid = posted.length;
pasteListeners[0].fn({
  isTrusted: false,
  target: composer,
  clipboardData: { files: [], items: [], getData: () => "" },
});
pasteListeners[0].fn({
  isTrusted: true,
  target: composer,
  clipboardData: { files: [], items: [{ kind: "string", type: "text/plain" }], getData: () => "hello world" },
});
pasteListeners[0].fn({
  isTrusted: true,
  target: composer,
  clipboardData: { files: [file], items: [{ kind: "file", type: "image/png" }], getData: () => "" },
});
if (posted.length !== countAfterValid) {
  throw new Error(`unexpected extra native posts: ${JSON.stringify(posted.slice(countAfterValid))}`);
}

// 5. Over-limit rejection renders a visible accessible role="alert" notice.
new Function(limitScript)();
const notice = document.getElementById("openclaw-linux-clipboard-notice");
if (!notice || notice.attrs.role !== "alert" || !notice.textContent.includes("Cannot paste 11 images at once")) {
  throw new Error(`expected visible alert notice, got ${JSON.stringify(notice)}`);
}
if (customEvents.length !== 1 || customEvents[0].detail.count !== 11 || customEvents[0].detail.max !== 10) {
  throw new Error(`expected limit error CustomEvent, got ${JSON.stringify(customEvents)}`);
}
"#;
        let output = Command::new("node")
            .args(["-e", runner, &init, &deliver, &limit_script])
            .output()
            .expect("Node is required by the OpenClaw workspace");
        assert!(
            output.status.success(),
            "linux clipboard paste script test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
