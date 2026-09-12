//! Dashboard-only transport for the shared native browser contract.
use crate::native_browser::NativeBrowserState;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::ipc::CapabilityBuilder;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, State, Url, Webview};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone)]
struct DashboardDocument {
    url: Url,
    token: String,
    generation: u64,
    ready: bool,
}

#[derive(Default)]
struct BridgeState {
    document: Option<DashboardDocument>,
    generation: u64,
    reset_pending: bool,
    granted_origins: HashSet<String>,
}

#[derive(Default)]
pub struct NativeBrowserBridgeState {
    inner: Mutex<BridgeState>,
    lifecycle: tokio::sync::Mutex<()>,
}

fn matches_dashboard(candidate: &Url, dashboard: &Url) -> bool {
    if !matches!(candidate.scheme(), "http" | "https")
        || candidate.origin() != dashboard.origin()
        || !candidate.username().is_empty()
        || candidate.password().is_some()
    {
        return false;
    }
    let base = dashboard.path().trim_end_matches('/');
    base.is_empty()
        || candidate.path() == base
        || candidate
            .path()
            .strip_prefix(base)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

impl NativeBrowserBridgeState {
    pub fn document_token(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .document
            .as_ref()
            .map(|document| document.token.clone())
    }
    /// Returns an initialization script when the dashboard WebView must be replaced.
    pub fn select(
        &self,
        app: &AppHandle,
        dashboard: &Url,
        replace: bool,
    ) -> Result<Option<String>, String> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| "Native browser bridge is unavailable.")?;
        if !replace
            && state.document.as_ref().is_some_and(|current| {
                current.url.origin() == dashboard.origin()
                    && current.url.path().trim_end_matches('/')
                        == dashboard.path().trim_end_matches('/')
            })
        {
            return Ok(None);
        }
        let origin = dashboard.origin().ascii_serialization();
        // Tauri currently only adds runtime ACL entries. The live selected-document
        // check below revokes old Gateway authority, even though their ACL remains.
        if !state.granted_origins.contains(&origin) {
            app.add_capability(
                CapabilityBuilder::new(format!("native-browser-{}", uuid::Uuid::new_v4()))
                    .local(false)
                    .remote(format!("{origin}/*"))
                    .webview("main")
                    .permission("allow-native-browser-request"),
            )
            .map_err(|error| format!("Could not enable the native browser: {error}"))?;
            state.granted_origins.insert(origin);
        }
        state.generation = state.generation.wrapping_add(1);
        let document = DashboardDocument {
            url: dashboard.clone(),
            token: uuid::Uuid::new_v4().to_string(),
            generation: state.generation,
            ready: false,
        };
        let script = initialization_script(&document);
        state.document = Some(document);
        state.reset_pending = true;
        Ok(Some(script))
    }

    pub fn clear(&self, app: &AppHandle) {
        if let Ok(mut state) = self.inner.lock() {
            state.generation = state.generation.wrapping_add(1);
            state.document = None;
            state.reset_pending = true;
        }
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let bridge = app.state::<NativeBrowserBridgeState>();
            let _lifecycle = bridge.lifecycle.lock().await;
            if !bridge
                .inner
                .lock()
                .is_ok_and(|state| state.document.is_none())
            {
                return;
            }
            app.state::<NativeBrowserState>().reset(&app).await;
        });
    }

    fn authorize(&self, webview: &Webview, token: &str) -> Option<DashboardDocument> {
        if webview.label() != "main" {
            return None;
        }
        let url = webview.url().ok()?;
        let state = self.inner.lock().ok()?;
        state
            .document
            .as_ref()
            .filter(|document| {
                document.ready && document.token == token && matches_dashboard(&url, &document.url)
            })
            .cloned()
    }
}

fn scoped_script(document: &DashboardDocument, script: &str) -> String {
    let origin = json!(document.url.origin().ascii_serialization());
    let base = json!(document.url.path().trim_end_matches('/'));
    format!(
        r#"(() => {{
  if (window !== window.top || location.origin !== {origin}) return;
  const base = {base};
  if (base && location.pathname !== base && !location.pathname.startsWith(base + "/")) return;
  {script}
}})();"#
    )
}

fn initialization_script(document: &DashboardDocument) -> String {
    let token = json!(document.token);
    scoped_script(
        document,
        &format!(
            r#"
  const token = {token};
  let resolveReady;
  const ready = new Promise(resolve => {{ resolveReady = resolve; }});
  window.addEventListener("openclaw:native-browser-ready", resolveReady, {{ once: true }});
  const invoke = window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
  const handler = {{ postMessage: async message => {{
    await ready;
    try {{ return await invoke("native_browser_request", {{ message, token }}); }}
    catch (error) {{ return {{ ok: false, error: String(error) }}; }}
  }} }};
  window.webkit ??= {{}};
  window.webkit.messageHandlers ??= {{}};
  // WebKit can recreate its native registry wrapper when JavaScript no longer
  // retains it. Keep our JavaScript-only adapters alive for this document.
  const handlers = window.webkit.messageHandlers;
  Object.defineProperty(window, "__OPENCLAW_NATIVE_BROWSER_HANDLERS__", {{ value: handlers, configurable: true }});
  Object.defineProperty(handlers, "openclawBrowser", {{ value: handler, configurable: true }});
  Object.defineProperty(handlers, "openclawLink", {{ value: handler, configurable: true }});
  Object.defineProperty(window, "__OPENCLAW_NATIVE_BROWSER_TOKEN__", {{ value: token, configurable: true }});
"#
        ),
    )
}

pub fn dashboard_is_current(app: &AppHandle, webview: &Webview) -> bool {
    // Native URL reads may dispatch to the UI thread, whose callbacks also use
    // this state. Never hold the bridge mutex across a native dispatch.
    let Ok(url) = webview.url() else {
        return false;
    };
    let Some(state) = app.try_state::<NativeBrowserBridgeState>() else {
        return false;
    };
    let Ok(inner) = state.inner.lock() else {
        return false;
    };
    webview.label() == "main"
        && inner
            .document
            .as_ref()
            .is_some_and(|document| document.ready && matches_dashboard(&url, &document.url))
}

// Native callbacks can already hold the runtime's webview registry borrow. Their
// authority check must use the document lifecycle without reentering URL dispatch.
// Page-load callbacks invalidate this generation before a new document is ready.
pub fn generation_is_current(app: &AppHandle, generation: u64) -> bool {
    app.try_state::<NativeBrowserBridgeState>()
        .is_some_and(|state| {
            state.inner.lock().is_ok_and(|inner| {
                inner
                    .document
                    .as_ref()
                    .is_some_and(|document| document.ready && document.generation == generation)
            })
        })
}

pub fn request_is_current(app: &AppHandle, generation: u64) -> bool {
    let Some(webview) = app.get_webview("main") else {
        return false;
    };
    let Ok(url) = webview.url() else {
        return false;
    };
    let Some(state) = app.try_state::<NativeBrowserBridgeState>() else {
        return false;
    };
    let Ok(inner) = state.inner.lock() else {
        return false;
    };
    inner.document.as_ref().is_some_and(|document| {
        document.ready
            && document.generation == generation
            && matches_dashboard(&url, &document.url)
    })
}

pub fn publication_script(app: &AppHandle, serialized_state: &str) -> Option<String> {
    let state = app.try_state::<NativeBrowserBridgeState>()?;
    let inner = state.inner.lock().ok()?;
    let document = inner.document.as_ref().filter(|document| document.ready)?;
    let token = json!(document.token);
    Some(scoped_script(
        document,
        &format!(
            r#"
  if (window.__OPENCLAW_NATIVE_BROWSER_TOKEN__ !== {token}) return;
  window.__OPENCLAW_NATIVE_BROWSER__ = {serialized_state};
  window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", {{detail: window.__OPENCLAW_NATIVE_BROWSER__}}));
"#
        ),
    ))
}

pub fn page_load(webview: Webview, payload: PageLoadPayload<'_>, document_token: Option<&str>) {
    let app = webview.app_handle().clone();
    let Some(bridge) = app.try_state::<NativeBrowserBridgeState>() else {
        return;
    };
    let (generation, reset) = {
        let Ok(mut state) = bridge.inner.lock() else {
            return;
        };
        // WebViews reuse the "main" label. An old view can report a queued load
        // after replacement; only the callback installed for this view may retire
        // or ready the current dashboard document.
        if state
            .document
            .as_ref()
            .map(|document| document.token.as_str())
            != document_token
        {
            return;
        }
        if matches!(payload.event(), PageLoadEvent::Started) {
            state.generation = state.generation.wrapping_add(1);
            let generation = state.generation;
            if let Some(document) = state.document.as_mut() {
                document.generation = generation;
                document.ready = false;
            }
        }
        (state.generation, state.reset_pending)
    };
    let started = matches!(payload.event(), PageLoadEvent::Started);
    tauri::async_runtime::spawn(async move {
        let bridge = app.state::<NativeBrowserBridgeState>();
        let _lifecycle = bridge.lifecycle.lock().await;
        if !bridge
            .inner
            .lock()
            .is_ok_and(|state| state.generation == generation)
        {
            return;
        }
        if started {
            app.state::<NativeBrowserState>()
                .release_all_scopes(&app)
                .await;
            return;
        }
        if reset {
            app.state::<NativeBrowserState>().reset(&app).await;
        }
        let Ok(url) = webview.url() else {
            return;
        };
        let script = {
            let Ok(mut state) = bridge.inner.lock() else {
                return;
            };
            if state.generation != generation {
                return;
            }
            state.reset_pending = false;
            let Some(document) = state.document.as_mut() else {
                return;
            };
            if !matches_dashboard(&url, &document.url) {
                return;
            }
            document.ready = true;
            scoped_script(
                document,
                "window.dispatchEvent(new Event(\"openclaw:native-browser-ready\"));",
            )
        };
        let _ = webview.eval(script);
        app.state::<NativeBrowserState>().publish(&app).await;
    });
}

#[tauri::command]
pub async fn native_browser_request(
    app: AppHandle,
    webview: Webview,
    bridge: State<'_, NativeBrowserBridgeState>,
    browser: State<'_, NativeBrowserState>,
    message: Value,
    token: String,
) -> Result<Value, String> {
    let document = bridge
        .authorize(&webview, &token)
        .ok_or("The native browser is no longer available.")?;
    let result = if message.get("type").and_then(Value::as_str) == Some("open-link") {
        let url = message
            .get("url")
            .and_then(Value::as_str)
            .and_then(|url| Url::parse(url).ok())
            .filter(|url| {
                crate::external_browser_url_allowed(url) || matches!(url.scheme(), "mailto" | "tel")
            })
            .filter(|_| message.get("target").and_then(Value::as_str) == Some("external"))
            .ok_or("Invalid external browser link.")?;
        if !request_is_current(&app, document.generation) {
            return Err("The native browser document changed.".into());
        }
        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map(|_| json!({"ok": true}))
            .map_err(|error| format!("Could not open the external link: {error}"))
    } else {
        browser.handle(&app, message, document.generation).await
    };
    if !bridge
        .authorize(&webview, &token)
        .is_some_and(|current| current.generation == document.generation)
    {
        return Err("The native browser document changed.".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dashboard_authority_requires_exact_origin_and_path_boundary() {
        let dashboard = Url::parse("https://gateway.example/openclaw/").unwrap();
        for (candidate, expected) in [
            ("https://gateway.example/openclaw", true),
            ("https://gateway.example/openclaw/chat", true),
            ("https://gateway.example/openclaw-other", false),
            ("https://gateway.example:444/openclaw", false),
            ("http://gateway.example/openclaw", false),
            ("https://other.example/openclaw", false),
            ("https://user@gateway.example/openclaw", false),
        ] {
            assert_eq!(
                matches_dashboard(&Url::parse(candidate).unwrap(), &dashboard),
                expected,
                "{candidate}"
            );
        }
    }

    #[test]
    fn bridge_is_installed_only_in_the_dashboard_main_frame_and_waits_for_native_readiness() {
        let document = DashboardDocument {
            url: Url::parse("https://gateway.example/openclaw/").unwrap(),
            token: "fixture-bridge-token".into(),
            generation: 1,
            ready: false,
        };
        let runner = r#"
const vm = require('node:vm');
const assert = require('node:assert/strict');
const script = process.argv[1];
async function check(url, topFrame, allowed) {
  const events = new Map();
  const calls = [];
  const window = {
    addEventListener(name, listener) { events.set(name, listener); },
    __TAURI_INTERNALS__: { invoke(command, args) { calls.push([command, args]); return Promise.resolve({ok: true, tabId: 'fixture-tab'}); } },
  };
  window.top = topFrame ? window : {};
  vm.runInNewContext(script, {window, location: new URL(url), Promise});
  const bridge = window.webkit?.messageHandlers?.openclawBrowser;
  assert.equal(Boolean(bridge), allowed);
  if (!allowed) return;
  const reply = bridge.postMessage({type: 'open', tabId: 'fixture-tab', url: 'https://example.com', sessionKey: 'chat'});
  await Promise.resolve();
  assert.equal(calls.length, 0);
  events.get('openclaw:native-browser-ready')();
  assert.equal((await reply).tabId, 'fixture-tab');
  assert.equal(calls[0][0], 'native_browser_request');
  assert.equal(calls[0][1].token, 'fixture-bridge-token');
  await window.webkit.messageHandlers.openclawLink.postMessage({type: 'open-link', url: 'https://example.com', target: 'external'});
  assert.equal(calls[1][1].message.target, 'external');
}
async function checkNativeRegistryLifetime() {
  // WebKit's native registry getter weakly caches its JavaScript wrapper.
  let registry;
  const webkit = {};
  Object.defineProperty(webkit, 'messageHandlers', {get() {
    let value = registry?.deref();
    if (!value) {
      value = {ipc: {postMessage() {}}};
      registry = new WeakRef(value);
    }
    return value;
  }});
  const window = {webkit, addEventListener() {}, __TAURI_INTERNALS__: {invoke() {}}};
  window.top = window;
  vm.runInNewContext(script, {window, location: new URL('https://gateway.example/openclaw/chat'), Promise});
  await new Promise(setImmediate);
  global.gc();
  await new Promise(setImmediate);
  assert.equal(typeof window.webkit.messageHandlers.openclawBrowser?.postMessage, 'function');
  assert.equal(typeof window.webkit.messageHandlers.openclawLink?.postMessage, 'function');
}
(async () => {
  await check('https://gateway.example/openclaw/chat', true, true);
  await check('https://gateway.example/openclaw/chat', false, false);
  await check('https://gateway.example/openclaw-other', true, false);
  await check('https://identity.example/openclaw', true, false);
  await checkNativeRegistryLifetime();
})().catch(error => { console.error(error); process.exitCode = 1; });
"#;
        let output = std::process::Command::new("node")
            .args([
                "--expose-gc",
                "-e",
                runner,
                &initialization_script(&document),
            ])
            .output()
            .expect("Node.js is required to exercise the injected browser bridge");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
