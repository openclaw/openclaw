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
    return crate::window_chrome_macos::install_window(window);
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
    let config = serde_json::json!({
        "platform": std::env::consts::OS,
        "origin": url.map(|url| url.origin().ascii_serialization()),
        "base": url.map(|url| url.path().trim_end_matches('/')),
        "waitForDashboard": main && url.is_some(),
        "css": include_str!("../../ui/window-chrome.css"),
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

pub(super) fn authorized(app: &AppHandle, webview: &Webview) -> bool {
    webview
        .url()
        .is_ok_and(|url| authorized_source(app, webview.label(), &url))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command(async)]
pub fn window_chrome_drag(app: AppHandle, webview: Webview) -> Result<(), String> {
    if !authorized(&app, &webview) {
        return Err("Window controls are no longer available for this page.".into());
    }
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
    if !authorized(&app, &webview) {
        return Err("Window controls are no longer available for this page.".into());
    }
    let window = webview.window();
    if matches!(action, WindowAction::State) {
        let (_, _, can_go_back, can_go_forward) =
            crate::native_browser_platform::navigation_state(&webview).await?;
        if !authorized(&app, &webview) {
            return Err("The window document changed.".into());
        }
        let mut current = state(&window)?;
        current.history = Some(HistoryState {
            can_go_back,
            can_go_forward,
        });
        return Ok(current);
    }
    match action {
        WindowAction::Ready => {
            #[cfg(target_os = "macos")]
            crate::window_chrome_macos::set_unified(&window, true)
                .map_err(|error| error.to_string())?;
            #[cfg(not(target_os = "macos"))]
            window
                .set_decorations(false)
                .map_err(|error| error.to_string())?;
            Ok(())
        }
        WindowAction::NativeFrame => {
            #[cfg(target_os = "macos")]
            crate::window_chrome_macos::set_unified(&window, false)
                .map_err(|error| error.to_string())?;
            #[cfg(not(target_os = "macos"))]
            window
                .set_decorations(true)
                .map_err(|error| error.to_string())?;
            Ok(())
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
