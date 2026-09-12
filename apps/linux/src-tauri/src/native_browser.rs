use crate::native_browser_platform as platform;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, Webview, WebviewUrl};
use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub struct NativeBrowserState {
    inner: Arc<Mutex<BrowserHost>>,
}

#[derive(Default)]
struct BrowserHost {
    revision: u64,
    order: u64,
    tabs: Vec<Tab>,
    presentations: HashMap<String, Presentation>,
    downloads: HashSet<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Tab {
    id: String,
    session_key: String,
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    opened_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    opener_tab_id: Option<String>,
    #[serde(skip)]
    label: String,
    #[serde(skip)]
    initial_alias: Option<String>,
    #[serde(skip)]
    initial_finished: bool,
    #[serde(skip)]
    failed: bool,
}

impl Tab {
    fn navigation_failed(&mut self) {
        // Neither the requested alias nor an engine's error-page URL is a reusable page.
        self.initial_alias = None;
        self.initial_finished = true;
        self.failed = true;
        self.loading = false;
    }
}

#[derive(Clone, Copy, Deserialize)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width >= 0.0
            && self.height >= 0.0
    }

    fn clipped(self, width: f64, height: f64) -> Option<Self> {
        let left = self.x.max(0.0).min(width);
        let top = self.y.max(0.0).min(height);
        let right = (self.x + self.width).max(0.0).min(width);
        let bottom = (self.y + self.height).max(0.0).min(height);
        (right > left && bottom > top).then_some(Self {
            x: left,
            y: top,
            width: right - left,
            height: bottom - top,
        })
    }
}

struct Presentation {
    tab_id: String,
    rect: Rect,
    order: u64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
enum Request {
    #[serde(rename_all = "camelCase")]
    Open {
        tab_id: String,
        url: String,
        session_key: String,
    },
    #[serde(rename_all = "camelCase")]
    Navigate {
        tab_id: String,
        url: String,
    },
    #[serde(rename_all = "camelCase")]
    Back {
        tab_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Forward {
        tab_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Reload {
        tab_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Stop {
        tab_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Close {
        tab_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Snapshot {
        tab_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Inspect {
        tab_id: String,
        x: f64,
        y: f64,
    },
    #[serde(rename_all = "camelCase")]
    Download {
        tab_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Present {
        scope: String,
        tab_id: Option<String>,
        rect: Option<Rect>,
        visible: bool,
    },
    ReleaseScope {
        scope: String,
    },
}

fn identifier(value: &str) -> Result<(), String> {
    if value.is_empty() || value.trim() != value || value.len() > 4096 {
        return Err("Invalid browser identifier.".into());
    }
    Ok(())
}

fn browser_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Enter a valid browser URL.".to_string())?;
    if url.as_str() == "about:blank" || (matches!(url.scheme(), "http" | "https") && url.has_host())
    {
        Ok(url)
    } else {
        Err("The inline browser supports HTTP and HTTPS pages.".into())
    }
}

impl BrowserHost {
    fn tab(&self, id: &str) -> Result<&Tab, String> {
        identifier(id)?;
        self.tabs
            .iter()
            .find(|tab| tab.id == id)
            .ok_or_else(|| "This browser tab has closed.".into())
    }

    fn view(&self, app: &AppHandle, id: &str) -> Result<Webview, String> {
        app.get_webview(&self.tab(id)?.label)
            .ok_or_else(|| "This browser tab is unavailable.".into())
    }

    fn existing(&self, session: &str, url: &str) -> Option<&Tab> {
        if url == "about:blank" {
            return None;
        }
        self.tabs
            .iter()
            .find(|tab| !tab.failed && tab.session_key == session && tab.url == url)
            .or_else(|| {
                self.tabs.iter().find(|tab| {
                    !tab.failed
                        && tab.session_key == session
                        && tab.initial_alias.as_deref() == Some(url)
                })
            })
    }

    fn publish(&mut self, app: &AppHandle) {
        self.revision += 1;
        let state = json!({ "revision": self.revision, "tabs": self.tabs });
        if let (Some(view), Some(script)) = (
            app.get_webview("main"),
            crate::native_browser_bridge::publication_script(app, &state.to_string()),
        ) {
            let _ = view.eval(script);
        }
    }

    fn presentation(&self, id: &str) -> Option<&Presentation> {
        self.presentations
            .values()
            .filter(|item| item.tab_id == id)
            .max_by_key(|item| item.order)
    }

    async fn layout(&self, app: &AppHandle) -> Result<(), String> {
        let window = app
            .get_window("main")
            .ok_or_else(|| "The dashboard window is unavailable.".to_string())?;
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let size = window.inner_size().map_err(|error| error.to_string())?;
        for tab in &self.tabs {
            let Some(view) = app.get_webview(&tab.label) else {
                continue;
            };
            let rect = self.presentation(&tab.id).and_then(|item| {
                item.rect.clipped(
                    f64::from(size.width) / scale,
                    f64::from(size.height) / scale,
                )
            });
            if let Some(rect) = rect {
                platform::set_bounds(
                    &view,
                    LogicalPosition::new(rect.x, rect.y),
                    LogicalSize::new(rect.width, rect.height),
                )
                .await?;
                if app.get_webview("main").is_some_and(|dashboard| {
                    crate::native_browser_bridge::dashboard_is_current(app, &dashboard)
                }) {
                    view.show().map_err(|error| error.to_string())?;
                } else {
                    view.hide().map_err(|error| error.to_string())?;
                }
            } else {
                view.hide().map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}

impl NativeBrowserState {
    pub async fn publish(&self, app: &AppHandle) {
        self.inner.lock().await.publish(app);
    }

    pub async fn release_all_scopes(&self, app: &AppHandle) {
        let mut host = self.inner.lock().await;
        host.presentations.clear();
        let _ = host.layout(app).await;
    }

    pub async fn reset(&self, app: &AppHandle) {
        let mut host = self.inner.lock().await;
        host.presentations.clear();
        for tab in host.tabs.drain(..) {
            if let Some(view) = app.get_webview(&tab.label) {
                let _ = platform::release(&view).await;
                let _ = view.close();
            }
        }
        host.downloads.clear();
        host.publish(app);
    }

    pub async fn resize(&self, app: &AppHandle) {
        let _ = self.inner.lock().await.layout(app).await;
    }

    fn create<'a>(
        &'a self,
        app: &'a AppHandle,
        host: &'a mut BrowserHost,
        id: String,
        url: Url,
        session_key: String,
        opener_tab_id: Option<String>,
        generation: Option<u64>,
    ) -> Pin<Box<dyn Future<Output = Result<String, String>> + Send + 'a>> {
        Box::pin(async move {
            identifier(&id)?;
            if !session_key.is_empty() {
                identifier(&session_key)?;
            }
            if host.tabs.iter().any(|tab| tab.id == id) {
                return Err("This browser tab already exists.".into());
            }
            let window = app
                .get_window("main")
                .ok_or_else(|| "The dashboard window is unavailable.".to_string())?;
            let dashboard = app
                .get_webview("main")
                .ok_or_else(|| "The dashboard is unavailable.".to_string())?;
            platform::prepare_surface(&dashboard).await?;
            if generation.is_some_and(|generation| {
                !crate::native_browser_bridge::request_is_current(app, generation)
            }) {
                return Err("The native browser document changed.".into());
            }
            // WebView labels are generated by the host, never controlled by page input.
            // These views match no IPC capability and receive no dashboard auth scripts.
            let label = format!("inline-browser-{}", uuid::Uuid::new_v4());
            let navigation_owner = self.clone();
            let navigation_app = app.clone();
            let navigation_label = label.clone();
            let load_owner = self.clone();
            let load_clock = Arc::new(AtomicU64::new(0));
            let title_owner = self.clone();
            let popup_owner = self.clone();
            let popup_app = app.clone();
            let popup_label = label.clone();
            // Install native observers before requesting the page: a refused local
            // connection can fail before add_child returns to this async owner.
            let bootstrap = Arc::new(AtomicBool::new(true));
            let navigation_bootstrap = bootstrap.clone();
            let load_bootstrap = bootstrap.clone();
            let title_bootstrap = bootstrap.clone();
            let navigation_epoch = Arc::new(AtomicU64::new(0));
            let navigation_clock = navigation_epoch.clone();
            let failed_epoch = Arc::new(AtomicU64::new(u64::MAX));
            let navigation_failure = failed_epoch.clone();
            let builder = WebviewBuilder::new(
                &label,
                WebviewUrl::External(Url::parse("about:blank").expect("valid blank URL")),
            )
            .on_navigation(move |url| {
                if navigation_bootstrap.load(Ordering::SeqCst) {
                    return url.as_str() == "about:blank";
                }
                if browser_url(url.as_str()).is_err() {
                    return false;
                }
                let clock = navigation_clock.clone();
                let event = clock.fetch_add(1, Ordering::SeqCst) + 1;
                let failure = navigation_failure.clone();
                let owner = navigation_owner.clone();
                let app = navigation_app.clone();
                let label = navigation_label.clone();
                let url = url.to_string();
                tauri::async_runtime::spawn(async move {
                    let mut host = owner.inner.lock().await;
                    if clock.load(Ordering::SeqCst) != event {
                        return;
                    }
                    if let Some(tab) = host.tabs.iter_mut().find(|tab| tab.label == label) {
                        if tab.initial_finished && tab.url != url {
                            tab.initial_alias = None;
                        }
                        tab.loading = url != "about:blank";
                        tab.failed = false;
                        tab.url = url;
                        if failure.load(Ordering::SeqCst) == event {
                            tab.navigation_failed();
                        }
                        host.publish(&app);
                    }
                });
                true
            })
            .on_page_load(move |view, payload| {
                if load_bootstrap.load(Ordering::SeqCst) {
                    return;
                }
                let owner = load_owner.clone();
                let view = view.clone();
                let url = payload.url().to_string();
                let finished = matches!(payload.event(), PageLoadEvent::Finished);
                let clock = load_clock.clone();
                let event = clock.fetch_add(1, Ordering::SeqCst) + 1;
                tauri::async_runtime::spawn(async move {
                    let mut host = owner.inner.lock().await;
                    if clock.load(Ordering::SeqCst) != event {
                        return;
                    }
                    if let Some(tab) = host.tabs.iter_mut().find(|tab| tab.label == view.label()) {
                        // An engine can finish its initial empty document after
                        // the requested page has already begun navigating.
                        if url == "about:blank" && tab.url != "about:blank" {
                            return;
                        }
                        if !finished && tab.initial_finished {
                            tab.initial_alias = None;
                        }
                        tab.url = view.url().map(|url| url.to_string()).unwrap_or(url);
                        tab.loading = !finished && tab.url != "about:blank";
                        tab.initial_finished |= finished;
                        host.publish(view.app_handle());
                    }
                });
            })
            .on_document_title_changed(move |view, title| {
                if title_bootstrap.load(Ordering::SeqCst) {
                    return;
                }
                let owner = title_owner.clone();
                tauri::async_runtime::spawn(async move {
                    let mut host = owner.inner.lock().await;
                    if let Some(tab) = host.tabs.iter_mut().find(|tab| tab.label == view.label()) {
                        tab.title = title;
                        host.publish(view.app_handle());
                    }
                });
            })
            .on_new_window(move |url, _| {
                let owner = popup_owner.clone();
                let app = popup_app.clone();
                let label = popup_label.clone();
                // A native popup stays in its opener's conversation. It never gains
                // the dashboard's command authority or replaces the dashboard itself.
                tauri::async_runtime::spawn(async move {
                    let _ = owner.open_popup(&app, &label, url).await;
                });
                NewWindowResponse::Deny
            });
            let sibling = host
                .tabs
                .first()
                .and_then(|tab| app.get_webview(&tab.label));
            let builder = platform::configure_browser(builder, sibling.as_ref()).await?;
            if generation.is_some_and(|generation| {
                !crate::native_browser_bridge::request_is_current(app, generation)
            }) {
                return Err("The native browser document changed.".into());
            }
            let view = window
                .add_child(
                    builder,
                    LogicalPosition::new(-10000.0, -10000.0),
                    LogicalSize::new(1.0, 1.0),
                )
                .map_err(|error| format!("Could not open the browser tab: {error}"))?;
            if generation.is_some_and(|generation| {
                !crate::native_browser_bridge::request_is_current(app, generation)
            }) {
                let _ = view.close();
                return Err("The native browser document changed.".into());
            }
            if let Err(error) = view.hide() {
                let _ = view.close();
                return Err(format!("Could not prepare the browser tab: {error}"));
            }
            host.tabs.push(Tab {
                id: id.clone(),
                session_key,
                url: url.to_string(),
                initial_alias: Some(url.to_string()),
                initial_finished: url.as_str() == "about:blank",
                failed: false,
                title: String::new(),
                loading: url.as_str() != "about:blank",
                can_go_back: false,
                can_go_forward: false,
                opened_by: if opener_tab_id.is_some() {
                    "native"
                } else {
                    "web"
                }
                .into(),
                opener_tab_id,
                label,
            });
            let observer_owner = self.clone();
            let observer_app = app.clone();
            let observer_label = view.label().to_string();
            let refresh_clock = Arc::new(AtomicU64::new(0));
            if let Err(error) = platform::observe_navigation(&view, move || {
                let owner = observer_owner.clone();
                let app = observer_app.clone();
                let label = observer_label.clone();
                let clock = refresh_clock.clone();
                let event = clock.fetch_add(1, Ordering::SeqCst) + 1;
                tauri::async_runtime::spawn(async move {
                    owner.refresh(&app, &label, clock, event).await;
                });
            })
            .await
            {
                host.tabs.retain(|tab| tab.id != id);
                let _ = platform::release(&view).await;
                let _ = view.close();
                return Err(error);
            }
            let failure_owner = self.clone();
            let failure_app = app.clone();
            let failure_label = view.label().to_string();
            if let Err(error) = platform::observe_navigation_failure(&view, move || {
                let event = navigation_epoch.load(Ordering::SeqCst);
                failed_epoch.store(event, Ordering::SeqCst);
                let clock = navigation_epoch.clone();
                let owner = failure_owner.clone();
                let app = failure_app.clone();
                let label = failure_label.clone();
                tauri::async_runtime::spawn(async move {
                    let mut host = owner.inner.lock().await;
                    if clock.load(Ordering::SeqCst) != event {
                        return;
                    }
                    if let Some(tab) = host.tabs.iter_mut().find(|tab| tab.label == label) {
                        tab.navigation_failed();
                        host.publish(&app);
                    }
                });
            })
            .await
            {
                host.tabs.retain(|tab| tab.id != id);
                let _ = platform::release(&view).await;
                let _ = view.close();
                return Err(error);
            }
            if generation.is_some_and(|generation| {
                !crate::native_browser_bridge::request_is_current(app, generation)
            }) {
                host.tabs.retain(|tab| tab.id != id);
                let _ = platform::release(&view).await;
                let _ = view.close();
                return Err("The native browser document changed.".into());
            }
            bootstrap.store(false, Ordering::SeqCst);
            if let Err(error) = view.navigate(url) {
                host.tabs.retain(|tab| tab.id != id);
                let _ = platform::release(&view).await;
                let _ = view.close();
                return Err(format!("Could not load the browser page: {error}"));
            }
            host.publish(app);
            Ok(id)
        })
    }

    async fn refresh(&self, app: &AppHandle, label: &str, clock: Arc<AtomicU64>, event: u64) {
        let Some(view) = app.get_webview(label) else {
            return;
        };
        let Ok((url, title, back, forward)) = platform::navigation_state(&view).await else {
            return;
        };
        if clock.load(Ordering::SeqCst) != event {
            return;
        }
        let mut host = self.inner.lock().await;
        if clock.load(Ordering::SeqCst) != event {
            return;
        }
        if let Some(tab) = host.tabs.iter_mut().find(|tab| tab.label == label) {
            if browser_url(&url).is_ok() {
                if tab.initial_finished && tab.url != url.as_str() {
                    tab.initial_alias = None;
                }
                tab.url = url;
            }
            tab.title = title;
            tab.can_go_back = back;
            tab.can_go_forward = forward;
            host.publish(app);
        }
    }

    async fn open_popup(&self, app: &AppHandle, label: &str, url: Url) -> Result<(), String> {
        let url = browser_url(url.as_str())?;
        let mut host = self.inner.lock().await;
        let opener = host
            .tabs
            .iter()
            .find(|tab| tab.label == label)
            .cloned()
            .ok_or_else(|| "The opening browser tab has closed.".to_string())?;
        self.create(
            app,
            &mut host,
            format!("tauri-{}", uuid::Uuid::new_v4()),
            url,
            opener.session_key,
            Some(opener.id),
            None,
        )
        .await?;
        Ok(())
    }

    pub async fn handle(
        &self,
        app: &AppHandle,
        message: Value,
        generation: u64,
    ) -> Result<Value, String> {
        let request: Request = serde_json::from_value(message)
            .map_err(|_| "Invalid native browser request.".to_string())?;
        let mut host = self.inner.lock().await;
        if !crate::native_browser_bridge::request_is_current(app, generation) {
            return Err("The native browser document changed.".into());
        }
        match request {
            Request::Open {
                tab_id,
                url,
                session_key,
            } => {
                identifier(&tab_id)?;
                let url = browser_url(&url)?;
                if let Some(tab) = host.existing(&session_key, url.as_str()) {
                    return Ok(json!({ "ok": true, "tabId": tab.id }));
                }
                let id = self
                    .create(
                        app,
                        &mut host,
                        tab_id,
                        url,
                        session_key,
                        None,
                        Some(generation),
                    )
                    .await?;
                return Ok(json!({ "ok": true, "tabId": id }));
            }
            Request::Present {
                scope,
                tab_id,
                rect,
                visible,
            } => {
                identifier(&scope)?;
                if rect.is_some_and(|rect| !rect.valid()) {
                    return Err("Invalid browser panel bounds.".into());
                }
                if let (true, Some(tab_id), Some(rect)) = (visible, tab_id, rect) {
                    host.tab(&tab_id)?;
                    host.order += 1;
                    let order = host.order;
                    host.presentations.insert(
                        scope,
                        Presentation {
                            tab_id,
                            rect,
                            order,
                        },
                    );
                } else {
                    host.presentations.remove(&scope);
                }
                host.layout(app).await?;
            }
            Request::ReleaseScope { scope } => {
                identifier(&scope)?;
                host.presentations.remove(&scope);
                host.layout(app).await?;
            }
            Request::Close { tab_id } => {
                let view = host.view(app, &tab_id)?;
                platform::release(&view).await?;
                view.close().map_err(|error| error.to_string())?;
                host.downloads.remove(view.label());
                host.tabs.retain(|tab| tab.id != tab_id);
                host.presentations.retain(|_, item| item.tab_id != tab_id);
                host.layout(app).await?;
                host.publish(app);
            }
            Request::Navigate { tab_id, url } => {
                let url = browser_url(&url)?;
                host.view(app, &tab_id)?
                    .navigate(url)
                    .map_err(|error| error.to_string())?;
                if let Some(tab) = host.tabs.iter_mut().find(|tab| tab.id == tab_id) {
                    tab.initial_alias = None;
                }
            }
            Request::Back { tab_id } => platform::go_back(&host.view(app, &tab_id)?).await?,
            Request::Forward { tab_id } => platform::go_forward(&host.view(app, &tab_id)?).await?,
            Request::Reload { tab_id } => host
                .view(app, &tab_id)?
                .reload()
                .map_err(|error| error.to_string())?,
            Request::Stop { tab_id } => {
                platform::stop(&host.view(app, &tab_id)?).await?;
                if let Some(tab) = host.tabs.iter_mut().find(|tab| tab.id == tab_id) {
                    tab.loading = false;
                    tab.initial_alias = None;
                }
                host.publish(app);
            }
            operation @ (Request::Snapshot { .. }
            | Request::Download { .. }
            | Request::Inspect { .. }) => {
                // Native dialogs and image capture may outlive a tab. Do not block
                // close/switch while awaiting them, and discard results from a closed view.
                let tab_id = match &operation {
                    Request::Snapshot { tab_id }
                    | Request::Download { tab_id }
                    | Request::Inspect { tab_id, .. } => tab_id.clone(),
                    _ => unreachable!(),
                };
                let view = host.view(app, &tab_id)?;
                let downloading = matches!(operation, Request::Download { .. });
                if downloading && !host.downloads.insert(view.label().to_string()) {
                    return Err("This browser tab already has a download in progress.".into());
                }
                drop(host);
                let result = match operation {
                    Request::Snapshot { .. } => platform::snapshot(&view).await,
                    Request::Download { .. } => platform::download(&view, generation).await,
                    Request::Inspect { x, y, .. }
                        if x.is_finite() && y.is_finite() && x >= 0.0 && y >= 0.0 =>
                    {
                        platform::inspect(&view, x, y).await
                    }
                    _ => Err("Invalid browser inspection coordinates.".into()),
                };
                let mut host = self.inner.lock().await;
                if downloading {
                    host.downloads.remove(view.label());
                }
                if host.tab(&tab_id)?.label != view.label() {
                    return Err("This browser tab has changed.".into());
                }
                return result;
            }
        }
        Ok(json!({ "ok": true }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str, session: &str, url: &str, alias: Option<&str>) -> Tab {
        Tab {
            id: id.into(),
            session_key: session.into(),
            url: url.into(),
            title: String::new(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            opened_by: "web".into(),
            opener_tab_id: None,
            label: format!("inline-browser-{id}"),
            initial_alias: alias.map(String::from),
            initial_finished: true,
            failed: false,
        }
    }

    #[test]
    fn failed_pages_retire_both_current_url_and_initial_redirect_alias() {
        let mut host = BrowserHost {
            tabs: vec![tab(
                "failed",
                "chat",
                "http://127.0.0.1:9/",
                Some("https://example.com/start"),
            )],
            ..Default::default()
        };
        host.tabs[0].navigation_failed();
        assert!(host.existing("chat", "http://127.0.0.1:9/").is_none());
        assert!(host.existing("chat", "https://example.com/start").is_none());
        assert!(!host.tabs[0].loading);
        assert!(host.tabs[0].initial_alias.is_none());
    }

    #[test]
    fn opening_a_link_reuses_current_page_before_redirect_alias_within_its_session() {
        let host = BrowserHost {
            tabs: vec![
                tab(
                    "redirect",
                    "chat-a",
                    "https://example.com/final",
                    Some("https://example.com/start"),
                ),
                tab("current", "chat-a", "https://example.com/start", None),
                tab("other", "chat-b", "https://example.com/start", None),
                tab("blank", "chat-a", "about:blank", Some("about:blank")),
            ],
            ..Default::default()
        };
        assert_eq!(
            host.existing("chat-a", "https://example.com/start")
                .unwrap()
                .id,
            "current"
        );
        assert_eq!(
            host.existing("chat-b", "https://example.com/start")
                .unwrap()
                .id,
            "other"
        );
        assert!(host
            .existing("chat-c", "https://example.com/start")
            .is_none());
        assert!(host.existing("chat-a", "about:blank").is_none());
        let mut redirected = host;
        redirected.tabs.remove(1);
        assert_eq!(
            redirected
                .existing("chat-a", "https://example.com/start")
                .unwrap()
                .id,
            "redirect"
        );
        redirected.tabs[0].initial_alias = None;
        assert!(redirected
            .existing("chat-a", "https://example.com/start")
            .is_none());
    }

    #[test]
    fn releasing_the_newest_scope_restores_the_previous_panel_without_closing_tabs() {
        let mut host = BrowserHost {
            tabs: vec![tab("one", "chat", "about:blank", None)],
            ..Default::default()
        };
        let rect = Rect {
            x: 20.0,
            y: 40.0,
            width: 400.0,
            height: 300.0,
        };
        host.presentations.insert(
            "dock".into(),
            Presentation {
                tab_id: "one".into(),
                rect,
                order: 1,
            },
        );
        host.presentations.insert(
            "chat".into(),
            Presentation {
                tab_id: "one".into(),
                rect: Rect { x: 80.0, ..rect },
                order: 2,
            },
        );
        assert_eq!(host.presentation("one").unwrap().rect.x, 80.0);
        host.presentations.remove("chat");
        assert_eq!(host.presentation("one").unwrap().rect.x, 20.0);
        host.presentations.clear();
        assert!(host.presentation("one").is_none());
        assert_eq!(host.tabs.len(), 1);
    }

    #[test]
    fn browser_panel_bounds_clip_to_the_dashboard_and_reject_invalid_geometry() {
        let rect = Rect {
            x: -20.0,
            y: 50.0,
            width: 150.0,
            height: 200.0,
        };
        let clipped = rect.clipped(100.0, 100.0).unwrap();
        assert_eq!(
            (clipped.x, clipped.y, clipped.width, clipped.height),
            (0.0, 50.0, 100.0, 50.0)
        );
        assert!(
            Rect {
                width: -1.0,
                ..rect
            }
            .valid()
                == false
        );
        assert!(!Rect {
            x: f64::NAN,
            ..rect
        }
        .valid());
        assert!(Rect { x: 110.0, ..rect }.clipped(100.0, 100.0).is_none());
    }

    #[test]
    fn requests_accept_the_control_ui_contract_and_reject_non_web_urls() {
        for value in [
            json!({"type":"open","tabId":"mac-fixture","url":"https://example.com/","sessionKey":"chat","activate":true}),
            json!({"type":"present","scope":"chat","tabId":"mac-fixture","rect":{"x":1,"y":2,"width":300,"height":200},"visible":true}),
            json!({"type":"release-scope","scope":"chat"}),
            json!({"type":"inspect","tabId":"mac-fixture","x":0,"y":0}),
        ] {
            assert!(serde_json::from_value::<Request>(value).is_ok());
        }
        for url in [
            "file:///C:/secret",
            "javascript:alert(1)",
            "data:text/html,hello",
            "openclaw://dashboard",
        ] {
            assert!(browser_url(url).is_err());
        }
        assert!(browser_url("about:blank").is_ok());
        assert!(browser_url("http://127.0.0.1:18789/fixture").is_ok());
        assert!(browser_url("https://fixture-user:fixture-password@example.com/").is_ok());
    }
}
