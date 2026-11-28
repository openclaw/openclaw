//! Linux WebKitGTK does not bind Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y to Undo/Redo
//! in standard text inputs. Install a bubble-phase keydown fallback that leaves
//! custom editors (such as CodeMirror) untouched when they call preventDefault.

pub(crate) const INITIALIZATION_SCRIPT: &str = r#"(() => {
  if (window.__openclawLinuxEditInstalled) return;
  window.__openclawLinuxEditInstalled = true;

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

  const isEditable = (el) => {
    if (!el || typeof el !== "object") return false;
    const tag = typeof el.tagName === "string" ? el.tagName.toUpperCase() : "";
    if (tag === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (tag === "INPUT") {
      const inputType = typeof el.type === "string" ? el.type.toLowerCase() : "text";
      if (NON_TEXT_INPUT_TYPES.has(inputType)) return false;
      return !el.disabled && !el.readOnly;
    }
    return Boolean(el.isContentEditable);
  };

  const activeEditable = () => {
    let target = document.activeElement;
    while (target && target.shadowRoot && target.shadowRoot.activeElement) {
      target = target.shadowRoot.activeElement;
    }
    return isEditable(target) ? target : null;
  };

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!event.ctrlKey || event.metaKey || event.altKey) return;
      const key = typeof event.key === "string" ? event.key.toLowerCase() : "";
      let command = null;
      if (key === "z") {
        command = event.shiftKey ? "redo" : "undo";
      } else if (key === "y") {
        command = event.shiftKey ? null : "redo";
      } else if (!/^[\x20-\x7e]$/.test(key)) {
        if (event.code === "KeyZ") {
          command = event.shiftKey ? "redo" : "undo";
        } else if (event.code === "KeyY" && !event.shiftKey) {
          command = "redo";
        }
      }
      if (!command) return;
      if (!activeEditable()) return;

      event.preventDefault();
      let handled = false;
      try {
        handled = typeof document.execCommand === "function" && document.execCommand(command);
      } catch {
        handled = false;
      }
      if (!handled) {
        try {
          window.webkit?.messageHandlers?.__openclawLinuxEdit?.postMessage(command);
        } catch {}
      }
    },
    false,
  );
})();"#;

#[cfg(target_os = "linux")]
const SCRIPT_MESSAGE_HANDLER: &str = "__openclawLinuxEdit";

#[cfg(target_os = "linux")]
const INSTALLED_DATA_KEY: &str = "openclaw-linux-editing-installed";

#[cfg(target_os = "linux")]
pub(crate) fn install_webview(webview: &tauri::Webview) -> tauri::Result<()> {
    use gtk::glib::object::ObjectExt;
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

        if let Some(ucm) = view.user_content_manager() {
            let script = UserScript::new(
                INITIALIZATION_SCRIPT,
                UserContentInjectedFrames::AllFrames,
                UserScriptInjectionTime::Start,
                &[],
                &[],
            );
            ucm.add_script(&script);

            if ucm.register_script_message_handler(SCRIPT_MESSAGE_HANDLER) {
                let weak_view = view.downgrade();
                ucm.connect_script_message_received(Some(SCRIPT_MESSAGE_HANDLER), move |_, msg| {
                    let Some(view) = weak_view.upgrade() else {
                        return;
                    };
                    let command = msg.js_value().map(|value| value.to_string());
                    match command.as_deref() {
                        Some("undo") => view.execute_editing_command("Undo"),
                        Some("redo") => view.execute_editing_command("Redo"),
                        _ => {}
                    }
                });
            }
        }

        view.evaluate_javascript(
            INITIALIZATION_SCRIPT,
            None,
            None,
            gtk::gio::Cancellable::NONE,
            |_| {},
        );
    })
}

#[cfg(test)]
mod tests {
    use super::INITIALIZATION_SCRIPT;
    use std::process::Command;

    #[test]
    fn ctrl_z_and_redo_fall_back_for_editable_inputs_and_respect_custom_editors() {
        let runner = r#"
const script = process.argv[1];
const listeners = [];
const execCalls = [];
const nativeCalls = [];
let execReturn = true;

globalThis.window = {
  addEventListener(type, fn, capture) {
    listeners.push({ type, fn, capture });
  },
  webkit: {
    messageHandlers: {
      __openclawLinuxEdit: {
        postMessage(cmd) {
          nativeCalls.push(cmd);
        },
      },
    },
  },
};

globalThis.document = {
  activeElement: null,
  execCommand(cmd) {
    execCalls.push(cmd);
    return execReturn;
  },
};

new Function(script)();
// Second injection must be a no-op.
new Function(script)();
if (listeners.length !== 1 || listeners[0].type !== "keydown" || listeners[0].capture !== false) {
  throw new Error(`unexpected listeners: ${JSON.stringify(listeners)}`);
}

const dispatch = (overrides) => {
  const event = {
    key: "z",
    code: "KeyZ",
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...overrides,
  };
  listeners[0].fn(event);
  return event;
};

// 1. Plain textarea: Ctrl+Z -> undo, Ctrl+Shift+Z -> redo, Ctrl+Y -> redo.
document.activeElement = { tagName: "TEXTAREA", disabled: false, readOnly: false };
let ev = dispatch({ key: "z", code: "KeyZ" });
if (!ev.defaultPrevented) throw new Error("Ctrl+Z did not preventDefault");
ev = dispatch({ key: "Z", code: "KeyZ", shiftKey: true });
if (!ev.defaultPrevented) throw new Error("Ctrl+Shift+Z did not preventDefault");
ev = dispatch({ key: "y", code: "KeyY" });
if (!ev.defaultPrevented) throw new Error("Ctrl+Y did not preventDefault");
if (JSON.stringify(execCalls) !== JSON.stringify(["undo", "redo", "redo"])) {
  throw new Error(`unexpected execCalls: ${JSON.stringify(execCalls)}`);
}

// 2. Non-Latin layout (e.g., Cyrillic key with physical KeyZ/KeyY) still triggers undo/redo.
execCalls.length = 0;
ev = dispatch({ key: "я", code: "KeyZ" });
if (!ev.defaultPrevented || execCalls[0] !== "undo") {
  throw new Error("physical KeyZ fallback failed");
}
execCalls.length = 0;
ev = dispatch({ key: "н", code: "KeyY" });
if (!ev.defaultPrevented || execCalls[0] !== "redo") {
  throw new Error("physical KeyY fallback failed");
}

// 2b. QWERTZ layout: logical key wins over physical key code.
// On QWERTZ, Ctrl+Z sends key="z", code="KeyY" (must undo, not redo),
// Ctrl+Shift+Z sends key="Z", code="KeyY", shiftKey=true (must redo),
// and Ctrl+Y sends key="y", code="KeyZ" (must redo, not undo).
execCalls.length = 0;
ev = dispatch({ key: "z", code: "KeyY", shiftKey: false });
if (!ev.defaultPrevented || execCalls[0] !== "undo") {
  throw new Error(`QWERTZ Ctrl+Z expected undo, got ${JSON.stringify(execCalls)}`);
}
execCalls.length = 0;
ev = dispatch({ key: "Z", code: "KeyY", shiftKey: true });
if (!ev.defaultPrevented || execCalls[0] !== "redo") {
  throw new Error(`QWERTZ Ctrl+Shift+Z expected redo, got ${JSON.stringify(execCalls)}`);
}
execCalls.length = 0;
ev = dispatch({ key: "y", code: "KeyZ", shiftKey: false });
if (!ev.defaultPrevented || execCalls[0] !== "redo") {
  throw new Error(`QWERTZ Ctrl+Y expected redo, got ${JSON.stringify(execCalls)}`);
}

// 2c. Other Latin layouts (e.g., AZERTY Ctrl+W or Dvorak Ctrl+; on physical KeyZ) must not misfire.
for (const sample of [
  { key: "w", code: "KeyZ", shiftKey: false },
  { key: ";", code: "KeyZ", shiftKey: false },
]) {
  execCalls.length = 0;
  ev = dispatch(sample);
  if (ev.defaultPrevented || execCalls.length !== 0) {
    throw new Error(`ASCII ${sample.key} on physical KeyZ should be ignored, got ${JSON.stringify(execCalls)}`);
  }
}

// 2d. Ctrl+Shift+Y should not trigger undo or redo.
execCalls.length = 0;
ev = dispatch({ key: "Y", code: "KeyY", shiftKey: true });
if (ev.defaultPrevented || execCalls.length !== 0) {
  throw new Error(`Ctrl+Shift+Y should be ignored, got ${JSON.stringify(execCalls)}`);
}

// 3. Custom editor (e.g., CodeMirror) already prevented default -> no double undo.
execCalls.length = 0;
ev = dispatch({ defaultPrevented: true });
if (execCalls.length !== 0 || nativeCalls.length !== 0) {
  throw new Error("defaultPrevented event should not trigger undo");
}

// 4. Non-editable, disabled, readOnly, and checkbox inputs are ignored.
for (const el of [
  { tagName: "DIV", isContentEditable: false },
  { tagName: "TEXTAREA", disabled: true, readOnly: false },
  { tagName: "TEXTAREA", disabled: false, readOnly: true },
  { tagName: "INPUT", type: "checkbox", disabled: false, readOnly: false },
]) {
  document.activeElement = el;
  ev = dispatch({});
  if (ev.defaultPrevented || execCalls.length !== 0) {
    throw new Error(`unexpected undo on ${JSON.stringify(el)}`);
  }
}

// 5. Shadow-DOM contenteditable target works and falls back to native WebKit command when execCommand returns false.
execCalls.length = 0;
execReturn = false;
document.activeElement = {
  tagName: "DIV",
  shadowRoot: { activeElement: { tagName: "DIV", isContentEditable: true } },
};
ev = dispatch({});
if (!ev.defaultPrevented || execCalls[0] !== "undo" || nativeCalls[0] !== "undo") {
  throw new Error(`shadow/native fallback failed: exec=${JSON.stringify(execCalls)} native=${JSON.stringify(nativeCalls)}`);
}

// 6. Alt/Meta modifiers and IME composition are ignored.
execCalls.length = 0;
nativeCalls.length = 0;
for (const mods of [{ altKey: true }, { metaKey: true }, { isComposing: true }]) {
  ev = dispatch(mods);
  if (ev.defaultPrevented || execCalls.length !== 0 || nativeCalls.length !== 0) {
    throw new Error(`unexpected trigger for ${JSON.stringify(mods)}`);
  }
}
"#;
        let output = Command::new("node")
            .args(["-e", runner, INITIALIZATION_SCRIPT])
            .output()
            .expect("Node is required by the OpenClaw workspace");
        assert!(
            output.status.success(),
            "linux editing script test failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
