use crate::gateway_ws::{CanvasSurfaceState, GatewayClient, GatewayGeneration};
use crate::quickchat::{position_quickchat, require_quickchat_webview, QuickChatState};
#[cfg(target_os = "linux")]
use gtk::prelude::*;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::webview::{NewWindowResponse, WebviewBuilder};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewUrl, Window,
};
use tokio::sync::Mutex as AsyncMutex;

const QUICKCHAT_WIDTH: f64 = 640.0;
const QUICKCHAT_COMPACT_WINDOW_HEIGHT: f64 = 92.0;
const QUICKCHAT_TEXT_WINDOW_HEIGHT: f64 = 360.0;
const QUICKCHAT_WIDGET_WINDOW_HEIGHT: f64 = 440.0;
const QUICKCHAT_WIDGET_HEIGHT: f64 = 160.0;
const QUICKCHAT_WIDGET_LABEL_PREFIX: &str = "quickchat-widget-";
const QUICKCHAT_WIDGET_MAX_COUNT: usize = 32;
const QUICKCHAT_WIDGET_MAX_URL_BYTES: usize = 4096;

#[cfg(target_os = "linux")]
mod compact_content {
    use gtk::glib;
    use gtk::subclass::prelude::*;

    #[derive(Default)]
    pub struct Content;

    #[glib::object_subclass]
    impl ObjectSubclass for Content {
        const NAME: &'static str = "OpenClawQuickChatContent";
        type Type = super::QuickChatContent;
        type ParentType = gtk::Box;
    }

    impl ObjectImpl for Content {}

    impl WidgetImpl for Content {
        fn request_mode(&self) -> gtk::SizeRequestMode {
            gtk::SizeRequestMode::ConstantSize
        }

        fn preferred_width(&self) -> (i32, i32) {
            let width = super::QUICKCHAT_WIDTH as i32;
            (width, width)
        }

        fn preferred_height(&self) -> (i32, i32) {
            let height = super::QUICKCHAT_COMPACT_WINDOW_HEIGHT as i32;
            (height, height)
        }
    }

    impl ContainerImpl for Content {}
    impl BoxImpl for Content {}
}

#[cfg(target_os = "linux")]
gtk::glib::wrapper! {
    pub struct QuickChatContent(ObjectSubclass<compact_content::Content>)
        @extends gtk::Box, gtk::Container, gtk::Widget,
        @implements gtk::Buildable, gtk::Orientable;
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickChatWidgetLayout {
    key: String,
    url: String,
    sandbox: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

struct RendererSession {
    id: String,
    epoch: u64,
    active_generation: u64,
    closed_generation: u64,
    hidden: bool,
}

#[derive(Clone, Default)]
pub struct QuickChatWidgetState {
    // Session arbitration and child changes share one lock so queued hide/reload cannot race a sync.
    inner: Arc<AsyncMutex<WidgetState>>,
}

#[derive(Default)]
struct WidgetState {
    views: HashSet<String>,
    active_session: Option<RendererSession>,
}

fn quickchat_window_height(has_widgets: bool, expanded: bool) -> f64 {
    if has_widgets {
        QUICKCHAT_WIDGET_WINDOW_HEIGHT
    } else if expanded {
        QUICKCHAT_TEXT_WINDOW_HEIGHT
    } else {
        QUICKCHAT_COMPACT_WINDOW_HEIGHT
    }
}

/// Returns whether the window was actually resized, so the caller can re-anchor
/// it only when its height really changed.
fn resize_window_if_needed(window: &Window, height: f64) -> Result<bool, String> {
    let scale = window
        .scale_factor()
        .map_err(|error| format!("Could not read Quick Chat scale: {error}"))?;
    let current = window
        .inner_size()
        .map_err(|error| format!("Could not read Quick Chat size: {error}"))?;
    let current_height = f64::from(current.height) / scale;
    if (current_height - height).abs() <= 0.5 {
        return Ok(false);
    }
    window
        .set_size(LogicalSize::new(QUICKCHAT_WIDTH, height))
        .map_err(|error| format!("Could not resize Quick Chat for widgets: {error}"))?;
    Ok(true)
}

async fn on_main_thread<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (reply, response) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = reply.send(action());
    })
    .map_err(|error| format!("Could not schedule Quick Chat widget update: {error}"))?;
    response
        .await
        .map_err(|_| "Quick Chat closed before its widget update.".to_string())?
}

#[cfg(target_os = "linux")]
async fn with_gtk_widget(
    webview: &Webview,
    update: impl FnOnce(gtk::Widget) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let (reply, response) = tokio::sync::oneshot::channel();
    webview
        .with_webview(move |platform| {
            let _ = reply.send(update(platform.inner().upcast()));
        })
        .map_err(|error| format!("Could not access the Quick Chat native view: {error}"))?;
    response
        .await
        .map_err(|_| "Quick Chat native view closed before layout completed.".to_string())?
}

#[cfg(target_os = "linux")]
async fn prepare_widget_surface(webview: &Webview) -> Result<(), String> {
    let app = webview.app_handle().clone();
    with_gtk_widget(webview, move |primary| {
        let parent = primary
            .parent()
            .ok_or_else(|| "Quick Chat native view has no layout container.".to_string())?;
        if parent.is::<QuickChatContent>() {
            return Ok(());
        }
        let vbox = parent
            .downcast::<gtk::Box>()
            .map_err(|_| "Quick Chat native layout container is unavailable.".to_string())?;
        let window = primary
            .toplevel()
            .and_then(|widget| widget.downcast::<gtk::Window>().ok())
            .ok_or_else(|| "Quick Chat native window is unavailable.".to_string())?;
        let overlay = gtk::Overlay::new();
        let fixed = gtk::Fixed::new();
        let content: QuickChatContent = gtk::glib::Object::new();
        vbox.remove(&primary);
        // The app owns preferred size; WebKit's natural size must not raise compact-window hints.
        content.set_orientation(gtk::Orientation::Vertical);
        content.pack_start(&primary, true, true, 0);
        overlay.add(&content);
        fixed.set_halign(gtk::Align::Fill);
        fixed.set_valign(gtk::Align::Fill);
        overlay.add_overlay(&fixed);
        // Only the overlay's wrapper passes input through; WebKit's own GdkWindows retain input.
        overlay.set_overlay_pass_through(&fixed, true);
        vbox.pack_start(&overlay, true, true, 0);
        content.show();
        fixed.show();
        overlay.show();
        let fixed = fixed.downgrade();
        // Give WebKit's IME and widget handlers first refusal; an unhandled key is replayed by WebKit.
        // Primary-view popovers keep their own Escape handling.
        window.connect_key_press_event(move |window, event| {
            if event.keyval() == gtk::gdk::keys::constants::Escape
                && fixed.upgrade().is_some_and(|fixed| {
                    window
                        .focused_widget()
                        .is_some_and(|focus| focus.is_ancestor(&fixed))
                })
            {
                if !window.propagate_key_event(event) {
                    crate::quickchat::request_hide(&app);
                }
                gtk::glib::Propagation::Stop
            } else {
                gtk::glib::Propagation::Proceed
            }
        });
        Ok(())
    })
    .await
}

async fn set_widget_bounds(
    webview: &Webview,
    position: LogicalPosition<f64>,
    size: LogicalSize<f64>,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return with_gtk_widget(webview, move |widget| {
        let parent = widget
            .parent()
            .ok_or_else(|| "Quick Chat widget has no layout container.".to_string())?;
        let fixed = match parent.downcast::<gtk::Fixed>() {
            Ok(fixed) => fixed,
            Err(parent) => {
                let vbox = parent.downcast::<gtk::Box>().map_err(|_| {
                    "Quick Chat widget layout container is unavailable.".to_string()
                })?;
                let overlay = vbox
                    .children()
                    .into_iter()
                    .find_map(|child| child.downcast::<gtk::Overlay>().ok())
                    .ok_or_else(|| "Quick Chat widget surface is unavailable.".to_string())?;
                let fixed = overlay
                    .children()
                    .into_iter()
                    .find_map(|child| child.downcast::<gtk::Fixed>().ok())
                    .ok_or_else(|| "Quick Chat widget layout is unavailable.".to_string())?;
                vbox.remove(&widget);
                fixed.put(&widget, 0, 0);
                fixed
            }
        };
        // Wry's GtkBox-created views ignore bounds even after reparenting; GTK owns this layout.
        let (x, y) = (position.x.round() as i32, position.y.round() as i32);
        let (width, height) = (size.width.round() as i32, size.height.round() as i32);
        widget.set_size_request(width, height);
        fixed.move_(&widget, x, y);
        widget.size_allocate(&gtk::Allocation::new(x, y, width, height));
        Ok(())
    })
    .await;
    #[cfg(not(target_os = "linux"))]
    {
        webview
            .set_position(position)
            .map_err(|error| format!("Could not position Quick Chat widget: {error}"))?;
        webview
            .set_size(size)
            .map_err(|error| format!("Could not resize Quick Chat widget: {error}"))
    }
}

impl QuickChatWidgetState {
    fn validate_session_id(session_id: &str) -> Result<(), String> {
        if session_id.trim().is_empty() || session_id.len() > 128 {
            Err("Quick Chat renderer session is invalid.".to_string())
        } else {
            Ok(())
        }
    }

    fn session_allows_sync(
        active: &RendererSession,
        session_id: &str,
        renderer_epoch: u64,
        generation: u64,
    ) -> bool {
        active.id == session_id
            && active.epoch == renderer_epoch
            && !active.hidden
            && generation > active.closed_generation
    }

    fn close_views(
        app: &AppHandle,
        labels: &mut HashSet<String>,
        parent_hidden: bool,
    ) -> Result<(), String> {
        let mut first_error = None;
        labels.retain(|label| {
            let Some(webview) = app.get_webview(label) else {
                return false;
            };
            if let Err(error) = webview.hide() {
                if !parent_hidden {
                    first_error.get_or_insert_with(|| {
                        format!("Could not hide stale Quick Chat widget {label}: {error}")
                    });
                }
                return true;
            }
            // A hidden child is safe to retain and retry later; only hide failure
            // can leave stale content visible and must abort the transition.
            webview.close().is_err()
        });
        first_error.map_or(Ok(()), Err)
    }

    pub async fn start_session(
        &self,
        webview: &Webview,
        session_id: &str,
        renderer_epoch: u64,
    ) -> Result<bool, String> {
        Self::validate_session_id(session_id)?;
        if renderer_epoch == 0 {
            return Err("Quick Chat renderer epoch is invalid.".to_string());
        }
        let mut state = self.inner.lock().await;
        if let Some(current) = state.active_session.as_ref() {
            if current.id == session_id && current.epoch == renderer_epoch {
                return Ok(true);
            }
            if current.epoch >= renderer_epoch {
                return Ok(false);
            }
        }
        let window = webview.window();
        if !state.views.is_empty() {
            window.hide().map_err(|error| {
                format!("Could not hide Quick Chat before renderer cleanup: {error}")
            })?;
        }
        Self::close_views(window.app_handle(), &mut state.views, true)?;
        #[cfg(target_os = "linux")]
        prepare_widget_surface(webview).await?;
        state.active_session = Some(RendererSession {
            id: session_id.to_string(),
            epoch: renderer_epoch,
            active_generation: 0,
            closed_generation: 0,
            hidden: true,
        });
        Ok(true)
    }

    pub async fn set_visible(
        &self,
        window: &Window,
        visible: bool,
        session_id: &str,
        renderer_epoch: u64,
        generation: u64,
        hide_requested: &AtomicBool,
    ) -> Result<bool, String> {
        Self::validate_session_id(session_id)?;
        let mut state = self.inner.lock().await;
        let WidgetState {
            views,
            active_session,
        } = &mut *state;
        let Some(active) = active_session.as_mut() else {
            return Ok(false);
        };
        if active.id != session_id
            || active.epoch != renderer_epoch
            || generation < active.active_generation
        {
            return Ok(false);
        }
        // Hide the parent before cleanup; revealing it must wait until stale children are hidden.
        if !visible {
            window
                .hide()
                .map_err(|error| format!("Could not hide Quick Chat: {error}"))?;
        }
        Self::close_views(window.app_handle(), views, !visible)?;
        if visible {
            window
                .show()
                .map_err(|error| format!("Could not show Quick Chat: {error}"))?;
        }
        active.active_generation = generation;
        active.hidden = !visible;
        if !visible {
            active.closed_generation = active.closed_generation.max(generation);
        }
        hide_requested.store(!visible, Ordering::SeqCst);
        if !visible {
            let _ = window.set_size(LogicalSize::new(
                QUICKCHAT_WIDTH,
                QUICKCHAT_COMPACT_WINDOW_HEIGHT,
            ));
        }
        Ok(true)
    }

    async fn sync(
        &self,
        webview: &Webview,
        app: &AppHandle,
        widgets: Vec<QuickChatWidgetLayout>,
        has_widgets: bool,
        expanded: bool,
        session_id: &str,
        renderer_epoch: u64,
        generation: u64,
        gateway: &GatewayClient,
        gateway_generation: GatewayGeneration,
        surface_url: Option<String>,
    ) -> Result<(), String> {
        Self::validate_session_id(session_id)?;
        let mut state = self.inner.lock().await;
        let Some(active) = state.active_session.as_ref() else {
            return Ok(());
        };
        if !Self::session_allows_sync(active, session_id, renderer_epoch, generation) {
            return Ok(());
        }
        let window = webview.window();
        if !has_widgets && !widgets.is_empty() {
            return Err("Quick Chat received widget layouts without widget content.".to_string());
        }
        if widgets.len() > QUICKCHAT_WIDGET_MAX_COUNT {
            return Err("Quick Chat received too many widgets.".to_string());
        }
        gateway.with_generation(gateway_generation, || Ok(()))?;
        let mut keys = HashSet::new();
        let mut visible_count = 0;
        let mut prepared = Vec::with_capacity(widgets.len());
        for widget in widgets {
            if !keys.insert(widget.key.clone()) {
                return Err("Quick Chat widget keys must be unique.".to_string());
            }
            visible_count += usize::from(widget.visible);
            let url = validate_widget_layout(&widget)?;
            let surface = surface_url
                .as_deref()
                .ok_or_else(|| "Quick Chat widget has no current Canvas capability.".to_string())?;
            if !widget_belongs_to_surface(&url, surface) {
                return Err(
                    "Quick Chat widget belongs to a different Canvas capability.".to_string(),
                );
            }
            let label = widget_view_label(&widget, gateway_generation);
            prepared.push((widget, label, url));
        }
        if visible_count > 1 {
            return Err("Quick Chat can show only one widget at a time.".to_string());
        }
        let current = &state.views;
        let mut desired = HashSet::new();
        for (_, label, _) in &prepared {
            if !desired.insert(label.clone()) {
                return Err("Quick Chat widget identities must be unique.".to_string());
            }
        }

        let mut created = HashSet::new();
        let result: Result<HashSet<String>, String> = async {
            let mut reconciled = Vec::with_capacity(prepared.len());
            for (widget, label, url) in prepared {
                let position = LogicalPosition::new(widget.x, widget.y);
                let size = LogicalSize::new(widget.width, widget.height);
                let existing = current
                    .contains(&label)
                    .then(|| app.get_webview(&label))
                    .flatten();
                let webview = match existing {
                    Some(webview) => webview,
                    None => {
                        if let Some(orphan) = app.get_webview(&label) {
                            let _ = orphan.close();
                        }
                        let allowed_url = url.clone();
                        // Widget labels intentionally match no Tauri capability. Linux cannot isolate
                        // iframe IPC, so agent-authored scripts must stay in separate child WebViews.
                        let mut builder =
                            WebviewBuilder::new(label.clone(), WebviewUrl::External(url))
                                .incognito(true)
                                .transparent(true)
                                .on_navigation(move |candidate| {
                                    same_widget_document(candidate, &allowed_url)
                                })
                                .on_new_window(|_, _| NewWindowResponse::Deny);
                        if widget.sandbox == "strict" {
                            builder = builder.disable_javascript();
                        }
                        let owner = gateway.clone();
                        let surface = surface_url.clone().expect("widget surface validated");
                        let child_window = window.clone();
                        let webview = on_main_thread(app, move || {
                            // Tauri/Wry dispatches inline on its event thread. Acquire authority
                            // there, not on a worker waiting for that thread to create the child.
                            owner.with_canvas_surface(gateway_generation, &surface, || {
                                child_window
                                    .add_child(builder, position, size)
                                    .map_err(|error| {
                                        format!("Could not create Quick Chat widget: {error}")
                                    })
                            })
                        })
                        .await?;
                        created.insert(label.clone());
                        webview
                    }
                };
                set_widget_bounds(&webview, position, size).await?;
                reconciled.push((widget.visible, webview));
            }

            let mut committed = desired.clone();
            for label in current.difference(&desired) {
                if let Some(webview) = app.get_webview(label) {
                    webview.hide().map_err(|error| {
                        format!("Could not hide obsolete Quick Chat widget: {error}")
                    })?;
                    if webview.close().is_err() {
                        committed.insert(label.clone());
                    }
                }
            }

            for (visible, webview) in reconciled {
                let owner = gateway.clone();
                let surface = surface_url.clone().expect("widget surface validated");
                on_main_thread(app, move || {
                    if visible {
                        owner.with_canvas_surface(gateway_generation, &surface, || {
                            webview.show().map_err(|error| {
                                format!("Could not show Quick Chat widget: {error}")
                            })
                        })
                    } else {
                        webview
                            .hide()
                            .map_err(|error| format!("Could not hide Quick Chat widget: {error}"))
                    }
                })
                .await?;
            }
            // Growing for widgets must re-anchor the window so its bottom edge stays in the work area.
            if resize_window_if_needed(&window, quickchat_window_height(has_widgets, expanded))? {
                position_quickchat(window.app_handle(), &window)?;
            }
            Ok(committed)
        }
        .await;
        if result.is_err() {
            // Only this sync's newly created children roll back; existing instances keep their state.
            for label in created {
                if let Some(webview) = app.get_webview(&label) {
                    let _ = webview.close();
                }
            }
        }
        state.views = result?;
        Ok(())
    }
}

#[tauri::command]
pub async fn quickchat_refresh_widget_surface(
    webview: Webview,
    gateway: State<'_, GatewayClient>,
    gateway_generation: GatewayGeneration,
    observed_url: String,
) -> Result<CanvasSurfaceState, String> {
    require_quickchat_webview(&webview)?;
    gateway
        .refresh_canvas_surface(gateway_generation, observed_url)
        .await
}

#[tauri::command]
pub async fn quickchat_sync_widgets(
    webview: Webview,
    app: AppHandle,
    state: State<'_, QuickChatState>,
    gateway: State<'_, GatewayClient>,
    widgets: Vec<QuickChatWidgetLayout>,
    has_widgets: bool,
    expanded: bool,
    session_id: String,
    renderer_epoch: u64,
    generation: u64,
    gateway_generation: GatewayGeneration,
    surface_url: Option<String>,
) -> Result<(), String> {
    require_quickchat_webview(&webview)?;
    state
        .widget_state()
        .sync(
            &webview,
            &app,
            widgets,
            has_widgets,
            expanded,
            &session_id,
            renderer_epoch,
            generation,
            gateway.inner(),
            gateway_generation,
            surface_url,
        )
        .await
}

fn widget_belongs_to_surface(url: &Url, surface: &str) -> bool {
    let Ok(surface) = Url::parse(surface) else {
        return false;
    };
    !has_url_userinfo(&surface)
        && surface.query().is_none()
        && surface.fragment().is_none()
        && url.origin() == surface.origin()
        && url.path().starts_with(&format!(
            "{}/__openclaw__/canvas/documents/",
            surface.path().trim_end_matches('/')
        ))
}

fn percent_decode_once(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'%' {
            decoded.push(bytes[index]);
            index += 1;
            continue;
        }
        if index + 2 >= bytes.len() {
            return None;
        }
        let byte = u8::from_str_radix(&raw[index + 1..index + 3], 16).ok()?;
        decoded.push(byte);
        index += 3;
    }
    String::from_utf8(decoded).ok()
}

fn percent_decode_repeatedly(raw: &str) -> Option<String> {
    let mut value = raw.to_string();
    for _ in 0..8 {
        let decoded = percent_decode_once(&value)?;
        if decoded == value {
            return Some(decoded);
        }
        value = decoded;
    }
    None
}

fn has_url_userinfo(url: &Url) -> bool {
    url.as_str()
        .split_once("://")
        .map(|(_, suffix)| {
            suffix
                .split(['/', '?', '#'])
                .next()
                .is_some_and(|authority| authority.contains('@'))
        })
        .unwrap_or(false)
}

fn has_secure_widget_transport(url: &Url) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    if url.scheme() != "http" {
        return false;
    }
    let Some(host) = url
        .host_str()
        .map(|host| host.trim_matches(['[', ']']).to_ascii_lowercase())
    else {
        return false;
    };
    host == "localhost"
        || host.ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

fn validate_widget_url(raw: &str) -> Result<Url, String> {
    if raw.len() > QUICKCHAT_WIDGET_MAX_URL_BYTES {
        return Err("Quick Chat widget URL is too long.".to_string());
    }
    let url =
        Url::parse(raw.trim()).map_err(|_| "Quick Chat widget URL is invalid.".to_string())?;
    if !has_secure_widget_transport(&url) || has_url_userinfo(&url) || url.host_str().is_none() {
        return Err("Quick Chat widget URL is not a secure HTTP capability URL.".to_string());
    }
    let encoded_segments = url
        .path()
        .split('/')
        .skip(1)
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    if encoded_segments.iter().any(|segment| segment.is_empty()) {
        return Err("Quick Chat widget URL has an invalid path.".to_string());
    }
    let segments = encoded_segments
        .iter()
        .map(|segment| {
            let decoded = percent_decode_repeatedly(segment)
                .ok_or_else(|| "Quick Chat widget URL has invalid encoding.".to_string())?;
            if decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\')
            {
                return Err("Quick Chat widget URL has an unsafe path.".to_string());
            }
            Ok(decoded)
        })
        .collect::<Result<Vec<_>, String>>()?;
    let Some(capability_index) = segments
        .windows(2)
        .rposition(|pair| pair == ["__openclaw__", "cap"])
    else {
        return Err("Quick Chat widget URL is missing its capability scope.".to_string());
    };
    let document_index = capability_index + 3;
    if segments
        .get(capability_index + 2)
        .is_none_or(String::is_empty)
        || segments.get(document_index).map(String::as_str) != Some("__openclaw__")
        || segments.get(document_index + 1).map(String::as_str) != Some("canvas")
        || segments.get(document_index + 2).map(String::as_str) != Some("documents")
        || segments.len() < document_index + 5
    {
        return Err("Quick Chat widget URL is outside the Canvas document scope.".to_string());
    }
    Ok(url)
}

fn validate_widget_layout(widget: &QuickChatWidgetLayout) -> Result<Url, String> {
    if widget.key.trim().is_empty() || widget.key.len() > 256 {
        return Err("Quick Chat widget key is invalid.".to_string());
    }
    if widget.sandbox != "scripts" && widget.sandbox != "strict" {
        return Err("Quick Chat widget sandbox is invalid.".to_string());
    }
    if !widget.x.is_finite()
        || !widget.y.is_finite()
        || !widget.width.is_finite()
        || !widget.height.is_finite()
        || widget.x < 0.0
        || widget.y < 0.0
        || widget.width < 1.0
        || (widget.height - QUICKCHAT_WIDGET_HEIGHT).abs() > 0.5
        || widget.x + widget.width > QUICKCHAT_WIDTH + 1.0
        || widget.y + widget.height > QUICKCHAT_WIDGET_WINDOW_HEIGHT + 1.0
    {
        return Err("Quick Chat widget bounds are invalid.".to_string());
    }
    validate_widget_url(&widget.url)
}

fn widget_view_label(widget: &QuickChatWidgetLayout, generation: GatewayGeneration) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&generation).expect("Gateway generation serializes"));
    hasher.update([0]);
    hasher.update(widget.key.as_bytes());
    hasher.update([0]);
    hasher.update(widget.url.as_bytes());
    hasher.update([0]);
    hasher.update(widget.sandbox.as_bytes());
    let digest = hasher.finalize();
    let suffix = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{QUICKCHAT_WIDGET_LABEL_PREFIX}{suffix}")
}

fn same_widget_document(candidate: &Url, allowed: &Url) -> bool {
    candidate.scheme() == allowed.scheme()
        && !has_url_userinfo(candidate)
        && candidate.host_str() == allowed.host_str()
        && candidate.port_or_known_default() == allowed.port_or_known_default()
        && candidate.path() == allowed.path()
        && candidate.query() == allowed.query()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn test_widget(key: &str, url: &str, sandbox: &str) -> QuickChatWidgetLayout {
        QuickChatWidgetLayout {
            key: key.to_string(),
            url: url.to_string(),
            sandbox: sandbox.to_string(),
            x: 52.0,
            y: 174.0,
            width: 540.0,
            height: QUICKCHAT_WIDGET_HEIGHT,
            visible: true,
        }
    }

    #[test]
    fn widget_sync_requires_current_visible_renderer_and_open_generation() {
        for (session_id, epoch, generation, hidden, allowed) in [
            ("renderer", 100, 8, false, true),
            ("renderer", 100, 6, false, true),
            ("renderer", 100, 5, false, false),
            ("renderer", 100, 4, false, false),
            ("renderer", 100, 8, true, false),
            ("previous", 100, 8, false, false),
            ("renderer", 99, 8, false, false),
        ] {
            let active = RendererSession {
                id: "renderer".to_string(),
                epoch: 100,
                active_generation: 8,
                closed_generation: 5,
                hidden,
            };
            assert_eq!(
                QuickChatWidgetState::session_allows_sync(&active, session_id, epoch, generation),
                allowed,
                "unexpected sync decision for {session_id}/{epoch}/{generation}, hidden={hidden}"
            );
        }
    }

    #[test]
    fn semantic_widget_state_owns_window_height() {
        assert_eq!(
            quickchat_window_height(false, false),
            QUICKCHAT_COMPACT_WINDOW_HEIGHT
        );
        assert_eq!(
            quickchat_window_height(false, true),
            QUICKCHAT_TEXT_WINDOW_HEIGHT
        );
        assert_eq!(
            quickchat_window_height(true, false),
            QUICKCHAT_WIDGET_WINDOW_HEIGHT
        );
        assert_eq!(
            quickchat_window_height(true, true),
            QUICKCHAT_WIDGET_WINDOW_HEIGHT
        );
    }

    #[test]
    fn layout_requires_a_scoped_canvas_document() {
        let valid = test_widget(
            "status",
            "https://gateway.example/base/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html",
            "scripts",
        );
        assert!(validate_widget_layout(&valid).is_ok());
        assert!(validate_widget_layout(&test_widget(
            "local",
            "http://127.0.0.1:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/local/index.html",
            "scripts",
        ))
        .is_ok());
        assert!(validate_widget_layout(&test_widget(
            "local-v6",
            "http://[::1]:18789/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/local-v6/index.html",
            "scripts",
        ))
        .is_ok());

        for url in [
            "https://evil.example/widget.html",
            "http://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html",
            "https://gateway.example/__openclaw__/canvas/documents/status/index.html",
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/%252e%252e/private-file",
        ] {
            assert!(validate_widget_layout(&test_widget("status", url, "scripts")).is_err());
        }
        let mut outside_window = valid.clone();
        outside_window.y = QUICKCHAT_WIDGET_WINDOW_HEIGHT;
        assert!(validate_widget_layout(&outside_window).is_err());
    }

    #[test]
    fn labels_preserve_existing_instances_when_siblings_append() {
        let first = test_widget(
            "first",
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/first/index.html",
            "scripts",
        );
        let second = test_widget(
            "second",
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/second/index.html",
            "scripts",
        );
        let generation = GatewayClient::new().generation();
        let first_label = widget_view_label(&first, generation);
        let desired_before = HashMap::from([(first.key.clone(), first_label.clone())]);
        let desired_after = HashMap::from([
            (first.key.clone(), widget_view_label(&first, generation)),
            (second.key.clone(), widget_view_label(&second, generation)),
        ]);

        assert_eq!(desired_after.get("first"), desired_before.get("first"));
        let mut navigated = first.clone();
        navigated.url.push_str("?revision=2");
        assert_ne!(widget_view_label(&navigated, generation), first_label);
    }

    #[test]
    fn navigation_stays_on_the_original_document() {
        let allowed = Url::parse(
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html?mode=compact",
        )
        .expect("allowed URL");
        let fragment = Url::parse(
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/status/index.html?mode=compact#details",
        )
        .expect("fragment URL");
        let other = Url::parse(
            "https://gateway.example/__openclaw__/cap/fixture-capability/__openclaw__/canvas/documents/other/index.html",
        )
        .expect("other URL");
        let mut userinfo_url = allowed.clone();
        userinfo_url
            .set_username("fixture-user")
            .expect("set fixture user");

        assert!(same_widget_document(&fragment, &allowed));
        assert!(!same_widget_document(&other, &allowed));
        assert!(!same_widget_document(&userinfo_url, &allowed));
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires an isolated native X11 display and session bus"]
    fn native_children_revalidate_gateway_before_create_and_show() {
        use crate::gateway_ws::tests::RpcFixture;
        use crate::quickchat::QUICKCHAT_LABEL;
        use futures_util::FutureExt;
        use std::time::Duration;
        use tokio::io::AsyncWriteExt;

        async fn pause_ui(app: &AppHandle) -> std::sync::mpsc::Sender<()> {
            let (entered, waiting) = tokio::sync::oneshot::channel();
            let (release, paused) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || {
                let _ = entered.send(());
                let _ = paused.recv_timeout(Duration::from_secs(5));
            })
            .unwrap();
            waiting.await.unwrap();
            release
        }

        async fn child_visible(app: &AppHandle, label: &str, hide: bool) -> bool {
            let visible = Arc::new(AtomicBool::new(false));
            let observed = visible.clone();
            with_gtk_widget(
                &app.get_webview(label).expect("native child"),
                move |widget| {
                    if hide {
                        widget.hide();
                    }
                    observed.store(widget.is_visible(), Ordering::SeqCst);
                    Ok(())
                },
            )
            .await
            .unwrap();
            visible.load(Ordering::SeqCst)
        }

        async fn exercise(app: AppHandle) {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let root = format!(
                "http://{}/__openclaw__/cap/fixture",
                listener.local_addr().unwrap()
            );
            let http = tokio::spawn(async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 13\r\nConnection: close\r\n\r\n<p>widget</p>").await;
                }
            });
            struct HttpTask(tokio::task::JoinHandle<()>);
            impl Drop for HttpTask {
                fn drop(&mut self) {
                    self.0.abort();
                }
            }
            let _http = HttpTask(http);
            let primary = app.get_webview(QUICKCHAT_LABEL).unwrap();
            for phase in ["current", "before-create", "before-show"] {
                let fixture = RpcFixture::new().await;
                fixture.set_surface(&root);
                let gateway = &fixture.client;
                let owner = gateway.generation();
                let state = QuickChatWidgetState::default();
                state.start_session(&primary, phase, 1).await.unwrap();
                state
                    .set_visible(&primary.window(), true, phase, 1, 1, &AtomicBool::new(true))
                    .await
                    .unwrap();
                let widget = test_widget(
                    phase,
                    &format!("{root}/__openclaw__/canvas/documents/{phase}/index.html"),
                    "strict",
                );
                let label = widget_view_label(&widget, owner);
                let mut sync = Box::pin(state.sync(
                    &primary,
                    &app,
                    vec![widget.clone()],
                    true,
                    true,
                    phase,
                    1,
                    1,
                    gateway,
                    owner,
                    Some(root.clone()),
                ));
                if phase == "current" {
                    sync.as_mut().await.unwrap();
                    assert!(child_visible(&app, &label, false).await);
                    drop(sync);
                    let rotated = format!("{root}-rotated");
                    fixture.set_surface(&rotated);
                    let mut refreshed = widget.clone();
                    refreshed.url = refreshed.url.replacen(&root, &rotated, 1);
                    state
                        .sync(
                            &primary,
                            &app,
                            vec![refreshed.clone()],
                            true,
                            true,
                            phase,
                            1,
                            1,
                            gateway,
                            owner,
                            Some(rotated.clone()),
                        )
                        .await
                        .unwrap();
                    assert!(
                        child_visible(&app, &widget_view_label(&refreshed, owner), false).await
                    );
                    assert!(app.get_webview(&label).is_none());
                    assert!(
                        state
                            .sync(
                                &primary,
                                &app,
                                vec![widget],
                                true,
                                true,
                                phase,
                                1,
                                1,
                                gateway,
                                owner,
                                Some(root.clone()),
                            )
                            .await
                            .is_err(),
                        "retired capability must not recreate a child"
                    );
                    state
                        .set_visible(
                            &primary.window(),
                            false,
                            phase,
                            1,
                            2,
                            &AtomicBool::new(false),
                        )
                        .await
                        .unwrap();
                } else {
                    if phase == "before-show" {
                        // Poll the real sync once per native stage. UI barriers complete child
                        // creation and GTK layout without polling the future into its show stage.
                        assert!(futures_util::poll!(sync.as_mut()).is_pending());
                        on_main_thread(&app, || Ok(())).await.unwrap();
                        assert!(futures_util::poll!(sync.as_mut()).is_pending());
                        on_main_thread(&app, || Ok(())).await.unwrap();
                        assert!(!child_visible(&app, &label, true).await);
                    }
                    let release = pause_ui(&app).await;
                    assert!(futures_util::poll!(sync.as_mut()).is_pending());
                    fixture.replace_route();
                    fixture.set_surface(&root); // Same URL/capability cannot restore the old owner.
                    release.send(()).unwrap();
                    on_main_thread(&app, || Ok(())).await.unwrap();
                    if phase == "before-show" {
                        assert!(
                            !child_visible(&app, &label, false).await,
                            "stale show reached GTK"
                        );
                    } else {
                        assert!(
                            app.get_webview(&label).is_none(),
                            "stale create reached GTK"
                        );
                    }
                    assert!(sync.await.is_err());
                    on_main_thread(&app, || Ok(())).await.unwrap();
                    assert!(app.get_webview(&label).is_none());
                }
                println!("F11_NATIVE {phase}: passed");
            }
        }

        let (finished, result) = std::sync::mpsc::channel();
        let app = tauri::Builder::default()
            .any_thread()
            .setup(move |app| {
                tauri::WebviewWindowBuilder::new(
                    app,
                    QUICKCHAT_LABEL,
                    WebviewUrl::External(Url::parse("about:blank").unwrap()),
                )
                .visible(false)
                .build()?;
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let outcome = std::panic::AssertUnwindSafe(tokio::time::timeout(
                        Duration::from_secs(25),
                        exercise(handle.clone()),
                    ))
                    .catch_unwind()
                    .await;
                    let _ = finished.send(outcome);
                    handle.exit(0);
                });
                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("native Quick Chat fixture");
        app.run_return(|_, _| {});
        match result
            .recv_timeout(Duration::from_secs(2))
            .expect("native result")
        {
            Ok(Ok(())) => {}
            Ok(Err(error)) => panic!("native widget proof timed out: {error}"),
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
}
