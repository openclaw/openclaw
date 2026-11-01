//! The companion owns its window controls; Gateway pages only operate their own window.
use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url, Webview, Window};

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WindowAction {
    Ready,
    NativeFrame,
    Minimize,
    ToggleMaximize,
    Close,
    State,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    maximized: bool,
    fullscreen: bool,
    focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    history: Option<HistoryState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HistoryState {
    can_go_back: bool,
    can_go_forward: bool,
}

pub fn install(window: &Window) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    return crate::window_chrome_linux::install(window);
    #[cfg(target_os = "macos")]
    return crate::window_chrome_macos::set_unified(window, false);
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = window;
        Ok(())
    }
}

pub fn loading(webview: &Webview) {
    // Failed loads and redirects outside the dashboard still need usable OS
    // controls. Only a mounted companion titlebar may replace this frame.
    #[cfg(not(target_os = "macos"))]
    let _ = webview.window().set_decorations(true);
    #[cfg(target_os = "macos")]
    let _ = crate::window_chrome_macos::set_unified(&webview.window(), false);
}

pub fn grant(app: &AppHandle, label: &str, url: &Url) -> Result<(), String> {
    let capability = CapabilityBuilder::new(format!("window-chrome-{}", uuid::Uuid::new_v4()))
        .local(false)
        .remote(format!("{}/*", url.origin().ascii_serialization()))
        .webview(label)
        .permission("allow-window-chrome-request");
    #[cfg(not(target_os = "macos"))]
    let capability = capability.permission("allow-window-chrome-drag");
    app.add_capability(capability)
        .map_err(|error| format!("Could not enable window controls: {error}"))
}

pub fn initialization_script(url: Option<&Url>, main: bool) -> String {
    initialization_script_mode(url, main, false)
}

pub(crate) fn locale_initialization_script() -> String {
    initialization_script_mode(None, false, true)
}

fn initialization_script_mode(url: Option<&Url>, main: bool, locale_only: bool) -> String {
    let local_page = url.is_none();
    let config = serde_json::json!({
        "platform": std::env::consts::OS,
        "origin": url.map(|url| url.origin().ascii_serialization()),
        "base": url.map(|url| url.path().trim_end_matches('/')),
        "waitForDashboard": main && url.is_some(),
        "localeOnly": locale_only,
        "css": include_str!("../../ui/window-chrome.css"),
        "chrome": crate::shell_i18n::chrome_copy(),
        "shellLocale": local_page.then(crate::shell_i18n::locale),
    });
    format!("({})({config});", include_str!("../../ui/window-chrome.js"))
}

fn state(window: &Window) -> Result<WindowState, String> {
    Ok(WindowState {
        maximized: window.is_maximized().map_err(|error| error.to_string())?,
        fullscreen: window.is_fullscreen().map_err(|error| error.to_string())?,
        focused: window.is_focused().map_err(|error| error.to_string())?,
        history: None,
    })
}

pub fn publish(window: &Window) {
    #[cfg(target_os = "linux")]
    {
        let app = window.app_handle().clone();
        let label = window.label().to_string();
        // GTK emits resize before Tao updates its maximized flag. Read after
        // the signal handlers finish, rather than publishing the previous state.
        gtk::glib::idle_add_once(move || {
            if let Some(window) = app.get_window(&label) {
                publish_current(&window);
            }
        });
    }
    #[cfg(not(target_os = "linux"))]
    publish_current(window);
}

fn publish_current(window: &Window) {
    #[cfg(target_os = "macos")]
    crate::window_chrome_macos::publish(window);
    let Some(webview) = window.app_handle().get_webview(window.label()) else {
        return;
    };
    if let Ok(state) = state(window)
        .and_then(|state| serde_json::to_string(&state).map_err(|error| error.to_string()))
    {
        let _ = webview.eval(format!(
            "window.dispatchEvent(new CustomEvent('openclaw:window-state', {{detail:{state}}}));"
        ));
    }
}

pub fn observe_history(webview: &Webview) {
    let view = webview.clone();
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = crate::native_browser_platform::observe_navigation(&view, move || {
            let app = app.clone();
            let label = label.clone();
            tauri::async_runtime::spawn(async move {
                if let Some(view) = app.get_webview(&label) {
                    let _ = view.eval(
                        "window.dispatchEvent(new Event('openclaw:window-history-changed'));",
                    );
                }
            });
        })
        .await
        {
            eprintln!("Could not observe window history: {error}");
        }
    });
}

pub(super) fn authorized_source(app: &AppHandle, label: &str, source: &Url) -> bool {
    if app
        .try_state::<crate::gateway_windows::GatewayWindows>()
        .is_some_and(|windows| windows.authorized_source(label, source))
    {
        return true;
    }
    if label == "main" {
        app.state::<crate::DesktopState>()
            .main_window_has_local_url(source)
    } else {
        false
    }
}

fn authorize(app: &AppHandle, webview: &Webview) -> Result<(), String> {
    webview
        .url()
        .is_ok_and(|url| authorized_source(app, webview.label(), &url))
        .then_some(())
        .ok_or_else(|| "Window controls are no longer available for this page.".into())
}

#[cfg(test)]
mod tests {
    use super::{initialization_script, locale_initialization_script, Url};
    use std::process::Command;

    #[test]
    fn local_shell_scripts_accept_only_packaged_top_level_documents() {
        let runner = r#"
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const fixture = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const chromeScript = fixture.chromeScript;
const englishChromeScript = fixture.englishChromeScript;
const noticeScript = fixture.noticeScript;
const i18nScript = fixture.i18nScript;
const dashboardChromeScript = fixture.dashboardChromeScript;
const dashboardConfig = JSON.parse(fixture.dashboardConfig);
const localeOnlyScript = fixture.localeOnlyScript;

function installConsumerCatalog(window) {
  Object.defineProperty(window, '__OPENCLAW_TAURI_CATALOG__', {value: fixture.catalog});
}

async function check(url, topFrame, allowed, noticeAllowed = allowed, expectedLocale = 'pt-PT', localChromeScript = chromeScript, includeCatalog = true) {
  const parsed = new URL(url);
  const location = {
    href: parsed.href,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
  };
  const events = [];
  const window = {
    addEventListener(name) { events.push(name); },
    __TAURI_INTERNALS__: { invoke() {} },
  };
  window.top = topFrame ? window : {};
  const document = {
    baseURI: location.href,
    readyState: 'loading',
    documentElement: {},
    addEventListener(name) { events.push(name); },
    querySelectorAll() { return []; },
  };
  let fetchCount = 0;
  const context = {
    window, location, document, Promise, URL,
    fetch() {
      fetchCount += 1;
      throw new Error('unexpected network request');
    },
  };
  vm.runInNewContext(localChromeScript, context);
  if (allowed && includeCatalog) installConsumerCatalog(window);
  vm.runInNewContext(noticeScript, context);
  vm.runInNewContext(i18nScript, context);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_LOCALE__'), allowed);
  assert.equal(Boolean(window.__OPENCLAW_GATEWAY_NOTICE_INSTALLED__), noticeAllowed);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_CATALOG__'), allowed && includeCatalog);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_I18N_READY__'), allowed);
  if (allowed) {
    const api = await window.__OPENCLAW_TAURI_I18N_READY__;
    if (!includeCatalog) {
      assert.equal(api.locale, 'en');
      assert.equal(document.documentElement.lang, 'en');
      assert.equal(api.text('quickChat.messageAgent', {name: 'Ada'}, 'Message {name}'), 'Message Ada');
      assert.throws(() => api.text('quickChat.messageAgent', {name: 'Ada', extra: 'ignored'}, 'Message {name}'), /exactly match/);
      assert.equal(fetchCount, 0);
      return;
    }
    assert.equal(api.locale, expectedLocale);
    assert.equal(api.text('quickChat.messageAgent', {name: '<b>{other}</b>'}, 'Message {name}'), expectedLocale === 'pt-PT' ? 'Mensagem para <b>{other}</b>' : 'Message <b>{other}</b>');
    assert.throws(() => api.text('quickChat.messageAgent', {}, 'Message {name}'), /exactly match/);
    assert.throws(() => api.text('quickChat.messageAgent', {name: 'Ada', extra: 'ignored'}, 'Message {name}'), /exactly match/);
    assert.equal(fetchCount, 0);
  } else {
    assert.equal(fetchCount, 0);
  }
}

async function checkConfiguredDashboard(url, topFrame, allowed) {
  const parsed = new URL(url);
  const location = {
    href: parsed.href,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
  };
  const events = [];
  const window = {
    addEventListener(name) { events.push(name); },
    __TAURI_INTERNALS__: { invoke() {} },
  };
  window.top = topFrame ? window : {};
  const document = {
    baseURI: location.href,
    readyState: 'loading',
    documentElement: {},
    addEventListener(name) { events.push(name); },
    querySelectorAll() { return []; },
  };
  let fetchCount = 0;
  const context = {
    window, location, document, Promise, URL,
    fetch() {
      fetchCount += 1;
      throw new Error('unexpected network request');
    },
  };
  vm.runInNewContext(dashboardChromeScript, context);
  vm.runInNewContext(noticeScript, context);
  vm.runInNewContext(`installGatewayNotice(${JSON.stringify(dashboardConfig)});`, context);
  vm.runInNewContext(i18nScript, context);
  assert.equal(events.includes('openclaw:native-window-chrome-available'), allowed);
  assert.equal(Boolean(window.__OPENCLAW_GATEWAY_NOTICE_INSTALLED__), allowed);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_CHROME__'), false);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_CATALOG__'), false);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_LOCALE__'), false);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_I18N_READY__'), false);
  assert.equal(fetchCount, 0);
}

async function checkLocaleOnly(url, topFrame, allowed) {
  const parsed = new URL(url);
  const location = {
    href: parsed.href,
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    pathname: parsed.pathname,
  };
  const events = [];
  const window = { addEventListener(name) { events.push(name); } };
  window.top = topFrame ? window : {};
  const document = {
    documentElement: {},
    addEventListener(name) { events.push(name); },
    querySelectorAll() { return []; },
  };
  let fetchCount = 0;
  const context = {
    window, location, document, Promise, URL,
    fetch() {
      fetchCount += 1;
      throw new Error('unexpected network request');
    },
  };
  vm.runInNewContext(localeOnlyScript, context);
  if (allowed) {
    installConsumerCatalog(window);
    vm.runInNewContext(i18nScript, context);
  }
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_LOCALE__'), allowed);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_CATALOG__'), allowed);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_CHROME__'), false);
  assert.equal(Object.hasOwn(window, '__OPENCLAW_TAURI_I18N_READY__'), allowed);
  assert.deepEqual(events, []);
  if (allowed) {
    const api = await window.__OPENCLAW_TAURI_I18N_READY__;
    assert.equal(api.locale, 'pt-PT');
    assert.equal(api.text('quickChat.messageAgent', {name: 'Ada'}, 'Message {name}'), 'Mensagem para Ada');
  }
  assert.equal(fetchCount, 0);
}

(async () => {
  for (const url of [
    'tauri://localhost/?mode=stopped',
    'http://tauri.localhost/index.html',
    'https://tauri.localhost/gateways.html',
  ]) {
    await check(url, true, true);
  }
  for (const url of [
    'tauri://localhost:12345/index.html',
    'http://tauri.localhost:12345/index.html',
    'https://tauri.localhost:12345/index.html',
    'https://tauri.localhost.example/index.html',
    'https://example.com/index.html',
    'tauri://localhost/settings',
    'tauri://user@localhost/index.html',
  ]) {
    await check(url, true, false);
  }
  await check('tauri://localhost/index.html', false, false);
  await check('tauri://localhost/quickchat.html', true, true, false);
  await check('tauri://localhost/index.html', true, true, true, 'en', englishChromeScript);
  await check('tauri://localhost/index.html', true, true, true, 'en', englishChromeScript, false);
  await checkConfiguredDashboard('https://tauri.localhost:12345/openclaw/', true, true);
  await checkConfiguredDashboard('https://tauri.localhost:12345/openclaw/subpage', true, true);
  await checkConfiguredDashboard('https://tauri.localhost:12345/other', true, false);
  await checkConfiguredDashboard('https://tauri.localhost:12346/openclaw/', true, false);
  await checkConfiguredDashboard('https://user@tauri.localhost:12345/openclaw/', true, false);
  await checkConfiguredDashboard('https://tauri.localhost:12345/openclaw/', false, false);
  await checkLocaleOnly('tauri://localhost/quickchat.html', true, true);
  await checkLocaleOnly('tauri://localhost/index.html', true, false);
  await checkLocaleOnly('tauri://localhost/quickchat.html', false, false);
})().catch(error => { console.error(error); process.exitCode = 1; });
"#;
        let dashboard_url = Url::parse("https://tauri.localhost:12345/openclaw/").unwrap();
        let dashboard_chrome = initialization_script(Some(&dashboard_url), false);
        let dashboard_config = serde_json::json!({
            "origin": dashboard_url.origin().ascii_serialization(),
            "base": dashboard_url.path().trim_end_matches('/'),
            "chrome": {},
        });
        let dashboard_config = serde_json::to_string(&dashboard_config).unwrap();
        let local_chrome_script = initialization_script(None, true);
        let host_locale = crate::shell_i18n::locale();
        let locale_field = format!("\"shellLocale\":\"{host_locale}\"");
        let portuguese_chrome_script =
            local_chrome_script.replace(&locale_field, "\"shellLocale\":\"pt-PT\"");
        let english_chrome_script =
            local_chrome_script.replace(&locale_field, "\"shellLocale\":\"en\"");
        assert!(portuguese_chrome_script.contains("\"shellLocale\":\"pt-PT\""));
        assert!(english_chrome_script.contains("\"shellLocale\":\"en\""));
        let locale_only_script =
            locale_initialization_script().replace(&locale_field, "\"shellLocale\":\"pt-PT\"");
        assert!(locale_only_script.contains("\"shellLocale\":\"pt-PT\""));
        let fixture_dir = std::env::temp_dir().join(format!(
            "openclaw-shell-boundary-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&fixture_dir).unwrap();
        let runner_path = fixture_dir.join("runner.cjs");
        let fixture_path = fixture_dir.join("fixture.json");
        let fixture = serde_json::json!({
            "chromeScript": portuguese_chrome_script,
            "englishChromeScript": english_chrome_script,
            "noticeScript": include_str!("../../ui/gateway-notice.js"),
            "catalog": {
                "version": 1,
                "sourceInventorySha256": "0".repeat(64),
                "messages": {
                    "quickChat.messageAgent": {
                        "en": "Message {name}",
                        "ptPT": "Mensagem para {name}",
                        "args": ["name"],
                    },
                },
            },
            "i18nScript": include_str!("../../ui/tauri-i18n.js"),
            "dashboardChromeScript": dashboard_chrome,
            "dashboardConfig": dashboard_config,
            "localeOnlyScript": locale_only_script,
        });
        std::fs::write(&runner_path, runner).unwrap();
        std::fs::write(&fixture_path, serde_json::to_vec(&fixture).unwrap()).unwrap();
        let output = Command::new("node")
            .arg(&runner_path)
            .arg(&fixture_path)
            .output();
        std::fs::remove_dir_all(&fixture_dir).unwrap();
        let output = output.expect("Node.js is required to exercise packaged shell boundaries");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(async)]
pub fn window_chrome_drag(app: AppHandle, webview: Webview) -> Result<(), String> {
    authorize(&app, &webview)?;
    webview
        .window()
        .start_dragging()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn window_chrome_request(
    app: AppHandle,
    webview: Webview,
    action: WindowAction,
) -> Result<WindowState, String> {
    authorize(&app, &webview)?;
    let window = webview.window();
    if matches!(action, WindowAction::State) {
        let (_, _, can_go_back, can_go_forward) =
            crate::native_browser_platform::navigation_state(&webview).await?;
        authorize(&app, &webview).map_err(|_| "The window document changed.")?;
        let mut current = state(&window)?;
        current.history = Some(HistoryState {
            can_go_back,
            can_go_forward,
        });
        return Ok(current);
    }
    match action {
        WindowAction::Ready | WindowAction::NativeFrame => {
            let unified = matches!(action, WindowAction::Ready);
            #[cfg(target_os = "macos")]
            {
                crate::window_chrome_macos::set_unified(&window, unified)
            }
            #[cfg(not(target_os = "macos"))]
            {
                window.set_decorations(!unified)
            }
        }
        WindowAction::Minimize => window.minimize(),
        WindowAction::ToggleMaximize => {
            if window.is_maximized().map_err(|error| error.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        WindowAction::Close => {
            let current = state(&window)?;
            window.close().map_err(|error| error.to_string())?;
            return Ok(current);
        }
        WindowAction::State => Ok(()),
    }
    .map_err(|error| error.to_string())?;
    state(&window)
}
