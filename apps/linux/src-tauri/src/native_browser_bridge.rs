//! Dashboard-only transport for the shared native browser contract.
use crate::native_browser::NativeBrowserState;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, State, Url, Webview};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone)]
pub(crate) struct DashboardDocument {
    url: Url,
    token: String,
    pub(crate) generation: u64,
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
            let capability =
                CapabilityBuilder::new(format!("native-browser-{}", uuid::Uuid::new_v4()))
                    .local(false)
                    .remote(format!("{origin}/*"))
                    .webview("main")
                    .permission("allow-native-browser-request")
                    .permission("allow-native-device-settings-request")
                    .permission("allow-window-chrome-request");
            #[cfg(not(target_os = "macos"))]
            let capability = capability.permission("allow-window-chrome-drag");
            app.add_capability(capability)
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
        let script = format!(
            "{}\n{}",
            initialization_script(&document),
            crate::window_chrome::initialization_script(Some(dashboard), true)
        );
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

    pub(crate) fn authorize(&self, webview: &Webview, token: &str) -> Option<DashboardDocument> {
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

    pub(crate) fn with_document_authority<T>(
        &self,
        generation: u64,
        action: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self
            .inner
            .lock()
            .map_err(|_| "Desktop document authority is unavailable.")?;
        if !state
            .document
            .as_ref()
            .is_some_and(|document| document.ready && document.generation == generation)
        {
            return Err("The desktop settings document changed.".into());
        }
        action()
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
  let deviceSettingsSnapshot;
  const acceptDeviceSettings = snapshot => {{
    if (deviceSettingsSnapshot && snapshot.revision <= deviceSettingsSnapshot.revision) return deviceSettingsSnapshot;
    deviceSettingsSnapshot = snapshot;
    window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__ = snapshot;
    window.dispatchEvent(new CustomEvent("openclaw:native-device-settings-changed", {{ detail: snapshot }}));
    return snapshot;
  }};
  Object.defineProperty(window, "__OPENCLAW_ACCEPT_NATIVE_DEVICE_SETTINGS__", {{ value: acceptDeviceSettings, configurable: true }});
  let deviceSettingsRequests = Promise.resolve();
  Object.defineProperty(handlers, "openclawDeviceSettings", {{ value: {{ postMessage: message => {{
    const request = deviceSettingsRequests.then(async () => {{
      await ready;
      const result = await invoke("native_device_settings_request", {{ message, token }});
      return message.type === "chrome-extension-setup" ? result : acceptDeviceSettings(result);
    }});
    deviceSettingsRequests = request.catch(() => {{}});
    return request;
  }} }}, configurable: true }});
  Object.defineProperty(window, "__OPENCLAW_NATIVE_BROWSER_TOKEN__", {{ value: token, configurable: true }});
"#
        ),
    )
}

pub fn dashboard_is_current(app: &AppHandle, webview: &Webview) -> bool {
    // Native URL reads may dispatch to the UI thread, whose callbacks also use
    // this state. Never hold the bridge mutex across a native dispatch.
    webview.label() == "main"
        && webview
            .url()
            .is_ok_and(|url| dashboard_source_matches(app, &url))
}

fn dashboard_source_matches(app: &AppHandle, source: &Url) -> bool {
    let Some(state) = app.try_state::<NativeBrowserBridgeState>() else {
        return false;
    };
    let Ok(inner) = state.inner.lock() else {
        return false;
    };
    inner
        .document
        .as_ref()
        .is_some_and(|document| document.ready && matches_dashboard(source, &document.url))
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

pub(crate) enum Publication {
    Browser,
    DeviceSettings,
}

pub fn publication_script(
    app: &AppHandle,
    serialized_state: &str,
    publication: Publication,
) -> Option<String> {
    let state = app.try_state::<NativeBrowserBridgeState>()?;
    let inner = state.inner.lock().ok()?;
    let document = inner.document.as_ref().filter(|document| document.ready)?;
    let token = json!(document.token);
    let script = match publication {
        Publication::Browser => format!(
            r#"
  if (window.__OPENCLAW_NATIVE_BROWSER_TOKEN__ !== {token}) return;
  window.__OPENCLAW_NATIVE_BROWSER__ = {serialized_state};
  window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", {{detail: window.__OPENCLAW_NATIVE_BROWSER__}}));
"#
        ),
        Publication::DeviceSettings => format!(
            r#"
  if (window.__OPENCLAW_NATIVE_BROWSER_TOKEN__ !== {token}) return;
  window.__OPENCLAW_ACCEPT_NATIVE_DEVICE_SETTINGS__({serialized_state});
"#
        ),
    };
    Some(scoped_script(document, &script))
}

pub fn page_load(webview: Webview, started: bool, document_token: Option<&str>) {
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
        if started {
            state.generation = state.generation.wrapping_add(1);
            let generation = state.generation;
            if let Some(document) = state.document.as_mut() {
                document.generation = generation;
                document.ready = false;
            }
        }
        (state.generation, state.reset_pending)
    };
    if started {
        crate::window_chrome::loading(&webview);
    }
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
        crate::native_device_settings::publish(&app);
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
    fn queued_document_action_rechecks_authority_before_entering_its_side_effect() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let bridge = Arc::new(NativeBrowserBridgeState::default());
        {
            let mut state = bridge.inner.lock().unwrap();
            state.generation = 1;
            state.document = Some(DashboardDocument {
                url: Url::parse("https://gateway.example/openclaw/").unwrap(),
                token: "original-document".into(),
                generation: 1,
                ready: true,
            });
        }
        let captured_generation = bridge
            .inner
            .lock()
            .unwrap()
            .document
            .as_ref()
            .unwrap()
            .generation;
        let side_effects = Arc::new(AtomicUsize::new(0));
        let (queued, pending) = mpsc::channel();
        let (release, resume) = mpsc::channel();
        let queued_bridge = Arc::clone(&bridge);
        let queued_effects = Arc::clone(&side_effects);
        let request = tauri::async_runtime::spawn_blocking(move || {
            queued.send(()).unwrap();
            resume.recv_timeout(Duration::from_secs(5)).unwrap();
            queued_bridge.with_document_authority(captured_generation, || {
                queued_effects.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
        });
        pending.recv_timeout(Duration::from_secs(5)).unwrap();
        {
            let mut state = bridge.inner.lock().unwrap();
            state.generation = 2;
            let document = state.document.as_mut().unwrap();
            document.generation = 2;
            document.token = "replacement-document".into();
        }
        release.send(()).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(request).unwrap(),
            Err("The desktop settings document changed.".into())
        );
        assert_eq!(side_effects.load(Ordering::SeqCst), 0);
        bridge
            .with_document_authority(2, || {
                side_effects.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .unwrap();
        assert_eq!(side_effects.load(Ordering::SeqCst), 1);
    }

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
    fn device_settings_preserve_newer_events_and_fifo_edits_after_a_rejection() {
        let document = DashboardDocument {
            url: Url::parse("https://gateway.example/openclaw/").unwrap(),
            token: "fixture-bridge-token".into(),
            generation: 1,
            ready: false,
        };
        let runner = r#"
const vm = require('node:vm');
const assert = require('node:assert/strict');
const calls = [];
const changes = [];
const events = new Map();
const window = {
  addEventListener(name, listener) { events.set(name, listener); },
  dispatchEvent(event) { changes.push(event.detail); },
  __TAURI_INTERNALS__: { invoke(command, args) {
    return new Promise((resolve, reject) => calls.push({command, args, resolve, reject}));
  } },
};
window.top = window;
vm.runInNewContext(process.argv[1], {
  window, location: new URL('https://gateway.example/openclaw/chat'), Promise,
  CustomEvent: class { constructor(name, {detail}) { this.detail = detail; } },
});
const flush = () => new Promise(setImmediate);
const post = value => window.webkit.messageHandlers.openclawDeviceSettings.postMessage({
  type: 'set', key: 'capabilities.desktopSharingEnabled', value,
});
const snapshot = (revision, state, enabled) => ({
  contract: 1, revision, capabilities: {desktopSharingEnabled: enabled}, desktopSharing: {state},
});
(async () => {
  const on = post(true);
  const off = post(false);
  await flush();
  assert.equal(calls.length, 0, 'edits must wait for document readiness');
  events.get('openclaw:native-browser-ready')();
  await flush();
  assert.equal(calls.length, 1, 'the second edit must not race the first native save');
  assert.equal(calls[0].command, 'native_device_settings_request');
  assert.equal(calls[0].args.message.value, true);
  const running = snapshot(2, 'running', true);
  window.__OPENCLAW_ACCEPT_NATIVE_DEVICE_SETTINGS__(running);
  calls[0].resolve(snapshot(1, 'starting', true));
  assert.equal(await on, running, 'an older reply must return the newer native state');
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.message.value, false);
  const stopped = snapshot(4, 'off', false);
  window.__OPENCLAW_ACCEPT_NATIVE_DEVICE_SETTINGS__(stopped);
  window.__OPENCLAW_ACCEPT_NATIVE_DEVICE_SETTINGS__(snapshot(3, 'starting', false));
  calls[1].resolve(snapshot(3, 'starting', false));
  assert.equal(await off, stopped);
  assert.equal(window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__, stopped);
  assert.deepEqual(changes.map(value => value.revision), [2, 4]);

  const rejected = assert.rejects(post(true), /synthetic vault failure/);
  const finalOff = post(false);
  await flush();
  assert.equal(calls.length, 3);
  calls[2].reject(new Error('synthetic vault failure'));
  await rejected;
  await flush();
  assert.equal(calls.length, 4, 'a rejected edit must not poison the document queue');
  assert.equal(calls[3].args.message.value, false);
  calls[3].resolve(snapshot(5, 'off', false));
  assert.equal((await finalOff).revision, 5);
  assert.deepEqual(calls.map(call => call.args.message.value), [true, false, true, false]);

  const setup = window.webkit.messageHandlers.openclawDeviceSettings.postMessage({
    type: 'chrome-extension-setup', action: 'inspect',
  });
  const afterSetup = post(true);
  await flush();
  assert.equal(calls.length, 5);
  assert.equal(calls[4].command, 'native_device_settings_request');
  assert.equal(calls[4].args.message.action, 'inspect');
  const setupReport = {action: 'inspect', phase: 'blocked', target: {kind: 'local-host'}};
  const latest = snapshot(6, 'off', false);
  window.__OPENCLAW_ACCEPT_NATIVE_DEVICE_SETTINGS__(latest);
  calls[4].resolve(setupReport);
  assert.equal(await setup, setupReport, 'setup returns its canonical result');
  assert.equal(window.__OPENCLAW_NATIVE_DEVICE_SETTINGS__, latest, 'setup must not replace settings');
  assert.deepEqual(changes.map(value => value.revision), [2, 4, 5, 6]);
  await flush();
  assert.equal(calls.length, 6, 'settings remain ordered after setup');
  calls[5].resolve(snapshot(7, 'running', true));
  assert.equal((await afterSetup).revision, 7);
})().catch(error => { console.error(error); process.exitCode = 1; });
"#;
        let output = std::process::Command::new("node")
            .args(["-e", runner, &initialization_script(&document)])
            .output()
            .expect("Node.js is required to exercise the injected settings bridge");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
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
    __TAURI_INTERNALS__: { invoke(command, args) {
      calls.push([command, args]);
      if (args.message.type === 'chrome-extension-setup') {
        if (args.message.action === 'invalid') return Promise.reject('Invalid Chrome setup action.');
        return Promise.resolve({action: args.message.action, phase: 'blocked', reason: 'fixture', target: {kind: 'local-host'}});
      }
      return Promise.resolve({ok: true, tabId: 'fixture-tab'});
    } },
  };
  window.top = topFrame ? window : {};
  vm.runInNewContext(script, {window, location: new URL(url), Promise});
  const bridge = window.webkit?.messageHandlers?.openclawBrowser;
  assert.equal(Boolean(bridge), allowed);
  assert.equal(Boolean(window.webkit?.messageHandlers?.openclawDeviceSettings), allowed);
  assert.equal(calls.length, 0, 'loading must not inspect or install');
  if (!allowed) return;
  const setup = window.webkit.messageHandlers.openclawDeviceSettings;
  const inspect = setup.postMessage({type: 'chrome-extension-setup', action: 'inspect'});
  const reply = bridge.postMessage({type: 'open', tabId: 'fixture-tab', url: 'https://example.com', sessionKey: 'chat'});
  await Promise.resolve();
  assert.equal(calls.length, 0);
  events.get('openclaw:native-browser-ready')();
  assert.equal((await reply).tabId, 'fixture-tab');
  assert.equal((await inspect).phase, 'blocked', 'canonical blocked is not a transport failure');
  const inspection = calls.find(call => call[1].message.type === 'chrome-extension-setup');
  assert.equal(inspection[0], 'native_device_settings_request');
  assert.equal(inspection[1].token, 'fixture-bridge-token');
  assert.equal(inspection[1].message.action, 'inspect');
  for (const action of ['install', 'verify']) {
    const result = await setup.postMessage({type: 'chrome-extension-setup', action});
    assert.equal(result.action, action);
    assert.equal(result.ok, undefined, 'returns canonical result without envelope');
    assert.deepEqual(Object.keys(calls.at(-1)[1].message).sort(), ['action', 'type']);
  }
  await assert.rejects(setup.postMessage({type: 'chrome-extension-setup', action: 'invalid'}), error => error === 'Invalid Chrome setup action.');
  await window.webkit.messageHandlers.openclawLink.postMessage({type: 'open-link', url: 'https://example.com', target: 'external'});
  assert.equal(calls.at(-1)[1].message.target, 'external');
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
  assert.equal(typeof window.webkit.messageHandlers.openclawDeviceSettings?.postMessage, 'function');
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
