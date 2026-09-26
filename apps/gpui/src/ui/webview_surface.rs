//! Native webviews share their document store, while each surface owns its view lifetime.

use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    path::PathBuf,
    rc::Rc,
};

use crate::model::{
    web_presentation::WebPresentation,
    web_urls::{WebAuth, control_base_url},
};
use async_channel::Sender;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;

#[cfg(any(target_os = "macos", target_os = "windows"))]
#[path = "webview_surface_native.rs"]
mod native;

#[derive(Clone)]
pub struct WebViewSpec {
    pub url: String,
    pub auth: Option<WebAuth>,
    /// A metadata surface still paints once to create its view, but never becomes visible.
    pub background: bool,
}

#[derive(Clone, Debug)]
pub enum WebViewEvent {
    Title(String),
    Loading(bool),
    Url(String),
    NewWindow(String),
    External(String),
    Ipc(String),
    Escape,
    Shortcut {
        key: String,
        shift: bool,
        alt: bool,
    },
    History {
        can_go_back: bool,
        can_go_forward: bool,
    },
    Error(String),
}

pub(super) struct WebViewRetirement {
    #[cfg(target_os = "macos")]
    view: objc2::rc::Weak<wry::WryWebView>,
}

#[cfg(target_os = "macos")]
impl WebViewRetirement {
    pub fn is_complete(&self) -> bool {
        self.view.load().is_none()
    }
}

#[derive(Clone)]
pub struct WebViewStore(Rc<RefCell<Store>>);

struct Store {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    context: wry::WebContext,
    #[cfg(target_os = "macos")]
    identifier: Option<[u8; 16]>,
    #[cfg(target_os = "macos")]
    data_store: Option<objc2::rc::Retained<objc2_web_kit::WKWebsiteDataStore>>,
}

impl WebViewStore {
    fn new(directory: PathBuf, state_root: &std::path::Path, scope: &str) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        let identifier = if crate::web_data_store::supported() {
            Some(crate::gateway::identity::Identity::load_at(state_root)?.record_web_store(scope)?)
        } else {
            None
        };
        #[cfg(not(target_os = "macos"))]
        crate::gateway::identity::Identity::load_at(state_root)?.record_web_store(scope)?;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let _ = directory;
        Ok(Self(Rc::new(RefCell::new(Store {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            context: wry::WebContext::new(Some(directory)),
            #[cfg(target_os = "macos")]
            data_store: None,
            #[cfg(target_os = "macos")]
            identifier,
        }))))
    }
}

pub struct WebViewStores {
    state_root: PathBuf,
    profile: Option<(String, String)>,
    control: BTreeMap<String, WebViewStore>,
    reading: Option<WebViewStore>,
}

impl WebViewStores {
    pub fn new(state_directory: PathBuf, profile: Option<(String, String)>) -> Self {
        Self {
            reading: None,
            state_root: state_directory,
            profile,
            control: BTreeMap::new(),
        }
    }

    pub fn control(&mut self, gateway_url: &str) -> Result<WebViewStore, String> {
        let scope = self.control_scope(gateway_url)?;
        if let Some(store) = self.control.get(&scope) {
            return Ok(store.clone());
        }
        let directory = crate::web_data_store::directory(&self.state_root, &scope)?;
        let store = WebViewStore::new(directory, &self.state_root, &scope)?;
        self.control.insert(scope, store.clone());
        Ok(store)
    }

    pub fn control_scope(&self, gateway_url: &str) -> Result<String, String> {
        match &self.profile {
            Some((id, canonical_url)) => {
                crate::web_data_store::profile_control_scope(id, canonical_url)
            }
            None => crate::web_data_store::control_scope(gateway_url),
        }
    }

    pub fn reading(&mut self) -> Result<WebViewStore, String> {
        if self.reading.is_none() {
            let scope = crate::web_data_store::reading_scope(
                self.profile.as_ref().map(|(id, _)| id.as_str()),
            );
            self.reading = Some(WebViewStore::new(
                crate::web_data_store::directory(&self.state_root, &scope)?,
                &self.state_root,
                &scope,
            )?);
        }
        Ok(self
            .reading
            .as_ref()
            .expect("initialized reading store")
            .clone())
    }

    #[cfg(target_os = "macos")]
    pub fn retire_control(&mut self) {
        self.control.clear();
    }
}

#[derive(Clone)]
struct Events {
    queue: Rc<RefCell<Vec<WebViewEvent>>>,
    history_dirty: Rc<Cell<bool>>,
    wake: Sender<()>,
    ready: Rc<Cell<bool>>,
    opening: Rc<RefCell<Option<Opening>>>,
    presentation: Rc<RefCell<WebPresentation>>,
    document_committed: Rc<Cell<bool>>,
    document_requested: Rc<Cell<bool>>,
    presentation_requested: Rc<Cell<bool>>,
    viewport: Rc<Cell<(f64, f64)>>,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    mask: Rc<RefCell<native::PresentationMask>>,
}

struct Opening {
    started: std::time::Instant,
    warm: bool,
    surface: &'static str,
}

impl Events {
    fn set_ready(&self, ready: bool) {
        if self.ready.replace(ready) != ready {
            log::debug!("webview_pool ready={ready}");
            let _ = self.wake.try_send(());
        }
    }

    fn revealed(&self) {
        if let Some(opening) = self.opening.borrow_mut().take() {
            log::info!(
                "webview_open surface={} warm={} reveal_ms={:.2}",
                opening.surface,
                opening.warm,
                opening.started.elapsed().as_secs_f64() * 1000.0
            );
        }
    }

    fn mask(&self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Err(error) = self.mask.borrow().hide() {
            self.push(WebViewEvent::Error(error));
        }
        let _ = self.wake.try_send(());
    }

    fn document_navigation(&self, url: &str) {
        self.document_committed.set(false);
        self.presentation.borrow_mut().navigate_document(url);
        self.mask();
    }

    fn document_committed(&self, url: &str) {
        self.document_navigation(url);
        self.document_committed.set(true);
        self.document_requested.set(true);
    }

    fn viewport_matches(&self, width: f64, height: f64) -> bool {
        let expected = self.viewport.get();
        (expected.0 - width).abs() < 1.0 && (expected.1 - height).abs() < 1.0
    }

    fn presentation(&self, document: &str, generation: u64, url: &str, ready: bool) {
        if self
            .presentation
            .borrow_mut()
            .update(document, generation, url, ready)
        {
            if !ready {
                self.mask();
            }
            log::debug!("webview_presentation generation={generation} ready={ready}");
            let _ = self.wake.try_send(());
        }
    }

    fn push(&self, event: WebViewEvent) {
        self.queue.borrow_mut().push(event);
        let _ = self.wake.try_send(());
    }

    fn history_changed(&self) {
        self.history_dirty.set(true);
        let _ = self.wake.try_send(());
    }
}

struct SurfaceState {
    spec: WebViewSpec,
    store: WebViewStore,
    events: Events,
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    view: Option<wry::WebView>,
    bounds: Option<SurfaceBounds>,
    scale_factor: Option<f32>,
    overlays: Vec<SurfaceBounds>,
    present: bool,
    visible: bool,
    dark: Option<bool>,
    error: Option<String>,
    creating: bool,
    retired: bool,
}

impl Drop for SurfaceState {
    fn drop(&mut self) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(view) = &self.view {
            native::detach(view);
        }
    }
}

pub struct WebViewSurface(Rc<RefCell<SurfaceState>>);

impl WebViewSurface {
    pub fn new(spec: WebViewSpec, store: WebViewStore, wake: Sender<()>) -> Self {
        let measure = !spec.background;
        let surface = Self(Rc::new(RefCell::new(SurfaceState {
            spec,
            store,
            events: Events {
                queue: Rc::default(),
                history_dirty: Rc::default(),
                wake,
                ready: Rc::default(),
                opening: Rc::default(),
                presentation: Rc::default(),
                document_committed: Rc::default(),
                document_requested: Rc::default(),
                presentation_requested: Rc::default(),
                viewport: Rc::default(),
                #[cfg(any(target_os = "macos", target_os = "windows"))]
                mask: Rc::default(),
            },
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            view: None,
            bounds: None,
            scale_factor: None,
            overlays: Vec::new(),
            present: true,
            visible: false,
            dark: None,
            error: None,
            creating: false,
            retired: false,
        })));
        if measure {
            surface.begin_open(false);
        }
        surface
    }

    pub fn is_ready(&self) -> bool {
        let state = self.0.borrow();
        !state.retired
            && state.error.is_none()
            && state.events.ready.get()
            && state.events.presentation.borrow().ready
    }

    fn begin_open(&self, warm: bool) {
        let state = self.0.borrow();
        let surface = if state.spec.auth.is_none() {
            "reading"
        } else if state.spec.url.contains("/apps/panel") {
            "panel"
        } else {
            "settings"
        };
        *state.events.opening.borrow_mut() = Some(Opening {
            started: std::time::Instant::now(),
            warm,
            surface,
        });
        log::debug!("webview_open surface={surface} warm={warm} requested");
    }

    pub fn adopt(&self, url: &str, background: bool) -> Result<(), String> {
        let started = std::time::Instant::now();
        {
            let mut state = self.0.borrow_mut();
            state.events.queue.borrow_mut().clear();
            state.spec.background = background;
            state.present = true;
        }
        self.navigate(url)?;
        if !background {
            self.begin_open(true);
            if let Some(opening) = self.0.borrow().events.opening.borrow_mut().as_mut() {
                opening.started = started;
            }
        }
        Ok(())
    }

    /// The owner calls this for every retained surface before rendering its active selection.
    pub fn set_present(&self, present: bool) {
        let mut state = self.0.borrow_mut();
        state.present = present;
        if !present {
            state.set_visible(false);
        }
    }

    pub fn set_overlays(&self, overlays: Vec<Bounds<Pixels>>) {
        let mut state = self.0.borrow_mut();
        state.overlays = overlays.into_iter().map(SurfaceBounds::from).collect();
        if state.bounds.is_some_and(|bounds| {
            state
                .overlays
                .iter()
                .any(|overlay| bounds.intersects(*overlay))
        }) {
            state.set_visible(false);
        }
    }

    pub fn drain_events(&self) -> Vec<WebViewEvent> {
        let state = self.0.borrow();
        let mut events = std::mem::take(&mut *state.events.queue.borrow_mut());
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(view) = &state.view {
            if state.events.document_committed.get()
                && state.events.document_requested.replace(false)
            {
                let navigation = state.events.presentation.borrow().navigation;
                let _ = view.evaluate_script(&format!(
                    "window.__OPENCLAW_GPUI_DOCUMENT__?.({navigation});"
                ));
            }
            if state.events.presentation_requested.replace(false) {
                native::request_presentation(view);
            }
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if (state.events.history_dirty.replace(false)
            || events
                .iter()
                .any(|event| matches!(event, WebViewEvent::Loading(false))))
            && let Some(view) = &state.view
        {
            let (can_go_back, can_go_forward) = native::history(view);
            if let Some(auth) = &state.spec.auth {
                let script = format!(
                    "if (location.origin === {}) {{ window.__OPENCLAW_NATIVE_HISTORY__ = {{canGoBack:{can_go_back},canGoForward:{can_go_forward}}}; window.dispatchEvent(new CustomEvent('openclaw:native-history-state', {{detail:window.__OPENCLAW_NATIVE_HISTORY__}})); }}",
                    serde_json::json!(
                        control_base_url(&auth.gateway_url)
                            .map(|url| url.origin().ascii_serialization())
                            .unwrap_or_default()
                    )
                );
                let _ = view.evaluate_script(&script);
            }
            if let Ok(url) = view.url()
                && state
                    .spec
                    .auth
                    .as_ref()
                    .is_none_or(|auth| auth.trusts(&url))
            {
                events.push(WebViewEvent::Url(url));
            }
            events.push(WebViewEvent::History {
                can_go_back,
                can_go_forward,
            });
        }
        events
    }

    pub fn navigate(&self, url: &str) -> Result<(), String> {
        let mut state = self.0.borrow_mut();
        if !is_web_url(url) && !(url == "about:blank" && state.spec.auth.is_none()) {
            return Err("Use an HTTP or HTTPS address".into());
        }
        if state
            .spec
            .auth
            .as_ref()
            .is_some_and(|auth| !auth.trusts(url))
        {
            return Err("Embedded panels must stay on their Gateway".into());
        }
        state.spec.url = url.to_owned();
        state.error = None;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(view) = &state.view {
            if state.spec.auth.is_some() && state.events.ready.get() {
                {
                    let presentation = state.events.presentation.borrow();
                    if presentation.ready && presentation.url == url {
                        return Ok(());
                    }
                }
                state.events.presentation.borrow_mut().navigate_route(url);
                state.events.mask();
                native::navigate_control(view, &state.spec)?;
            } else if url != "about:blank"
                || !state.events.ready.get()
                || !view.url().is_ok_and(|current| current == "about:blank")
            {
                state.events.document_navigation(url);
                state.events.set_ready(false);
                native::navigate(view, &state.spec)?;
            }
        }
        Ok(())
    }

    pub fn request_link(
        &self,
        request_id: &str,
        agent: &str,
        session: &str,
        url: &str,
    ) -> Result<(), String> {
        let state = self.0.borrow();
        let auth = state
            .spec
            .auth
            .as_ref()
            .ok_or("Link routing needs the Control UI")?;
        let detail = serde_json::json!({"receiver":"picker", "requestId":request_id, "agentId":agent, "sessionKey":session, "url":url});
        let origin = serde_json::json!(
            control_base_url(&auth.gateway_url)?
                .origin()
                .ascii_serialization()
        );
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(view) = &state.view {
            return view.evaluate_script(&format!("if (location.origin === {origin}) window.dispatchEvent(new CustomEvent('openclaw:native-panel-link', {{detail:{detail}}}));")).map_err(|_|"Could not route this link".into());
        }
        let _ = (detail, origin);
        Err("The panel catalog is not ready".into())
    }

    pub fn back(&self) {
        self.command(Command::Back);
    }
    pub fn forward(&self) {
        self.command(Command::Forward);
    }
    pub fn reload(&self) {
        self.command(Command::Reload);
    }
    pub fn stop(&self) {
        self.command(Command::Stop);
    }
    pub fn focus_parent(&self) {
        self.command(Command::FocusParent);
    }

    pub fn retire(&self) -> Option<WebViewRetirement> {
        let mut state = self.0.borrow_mut();
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let visible = state.visible;
        state.present = false;
        state.retired = true;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        let view = state.view.take();
        drop(state);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            view.map(|view| native::retire(view, visible))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            None
        }
    }

    #[cfg(not(target_os = "macos"))]
    pub fn clear_data(&self) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        if let Some(view) = &self.0.borrow().view {
            view.clear_all_browsing_data()
                .map_err(|_| "Could not clear the webview session".to_owned())?;
        }
        Ok(())
    }

    pub fn set_dark(&self, dark: bool) {
        let mut state = self.0.borrow_mut();
        if state.dark == Some(dark) {
            return;
        }
        state.dark = Some(dark);
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(view) = &state.view {
            native::set_dark(view, dark);
        }
    }

    fn command(&self, command: Command) {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let state = self.0.borrow();
            let Some(view) = &state.view else {
                return;
            };
            if matches!(command, Command::Back | Command::Forward) {
                let (back, forward) = native::history(view);
                if matches!(command, Command::Back) && !back
                    || matches!(command, Command::Forward) && !forward
                {
                    return;
                }
            }
            if matches!(command, Command::Reload) {
                state.events.document_navigation(&state.spec.url);
            } else if matches!(command, Command::Back | Command::Forward)
                && state.spec.auth.is_some()
            {
                state.events.mask();
                state.events.presentation.borrow_mut().navigate_history();
            }
            if native::command(view, command).is_err() {
                state
                    .events
                    .push(WebViewEvent::Error("Could not control the webview".into()));
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        let _ = command;
    }

    pub fn element(&self) -> AnyElement {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            if let Some(error) = self.0.borrow().error.clone() {
                if self.0.borrow().spec.background {
                    return div().into_any_element();
                }
                return div().size_full().p_4().child(error).into_any_element();
            }
            use gpui_kit::component::{Sizable, StyledExt, spinner::Spinner};
            let palette = super::theme::Palette::for_dark(self.0.borrow().dark.unwrap_or(false));
            let background = self.0.borrow().spec.background;
            let blank = self.0.borrow().spec.auth.is_none()
                && self.0.borrow().events.presentation.borrow().url == "about:blank";
            // The native view can mask itself from an IPC callback before GPUI's
            // next render; this placeholder is always ready beneath its layer.
            let placeholder = div()
                .size_full()
                .v_flex()
                .items_center()
                .justify_center()
                .gap_3()
                .bg(palette.bg)
                .text_color(palette.muted)
                .when(!blank, |el| {
                    el.child(Spinner::new().small().color(palette.muted))
                })
                .child(if blank {
                    "Open a link or enter a URL above."
                } else {
                    "Loading…"
                });
            let state = self.0.clone();
            let surface = canvas(
                |_, _, _| (),
                move |bounds, _, window, cx| {
                    // Platform construction/cookie completion can pump the native
                    // event loop. Do not retain a borrow across a nested paint.
                    let create = {
                        let mut state = state.borrow_mut();
                        if state.view.is_none()
                            && state.error.is_none()
                            && !state.creating
                            && !state.retired
                        {
                            state.creating = true;
                            Some((
                                state.spec.clone(),
                                state.store.clone(),
                                state.events.clone(),
                            ))
                        } else {
                            None
                        }
                    };
                    if let Some((spec, store, events)) = create {
                        let result = native::build(&spec, &store, &events, bounds, window);
                        let mut state = state.borrow_mut();
                        state.creating = false;
                        match result {
                            Ok(view) if !state.retired => {
                                state.events.mask.borrow_mut().attach(&view);
                                if let Some(dark) = state.dark {
                                    native::set_dark(&view, dark);
                                }
                                // Nested platform paint may have updated desired visibility
                                // while construction was pumping the native event loop.
                                state.visible = false;
                                state.view = Some(view);
                                let _ = state.events.wake.try_send(());
                            }
                            Ok(view) => {
                                native::retire(view, false);
                            }
                            Err(error) => {
                                log::warn!("webview_create failed: {error}");
                                state.events.push(WebViewEvent::Error(error.clone()));
                                state.error = Some(error);
                            }
                        }
                    }
                    let mut state = state.borrow_mut();
                    let bounds = SurfaceBounds::from(bounds).pixel_aligned(window.scale_factor());
                    if state.bounds != Some(bounds)
                        || state.scale_factor != Some(window.scale_factor())
                    {
                        state.bounds = Some(bounds);
                        state.scale_factor = Some(window.scale_factor());
                        state.events.viewport.set((bounds.width, bounds.height));
                        state.events.presentation.borrow_mut().ready = false;
                        state.events.mask();
                        if let Some(view) = &state.view {
                            native::set_bounds(view, bounds);
                            native::request_presentation(view);
                        }
                    }
                    use gpui_kit::component::{GlobalState, Root, WindowExt};
                    let native_overlay = GlobalState::is_in_deferred_context(cx)
                        || window.has_active_dialog(cx)
                        || window.has_active_sheet(cx)
                        || !Root::read(window, cx)
                            .notification
                            .read(cx)
                            .notifications()
                            .is_empty();
                    let visible = !native_overlay
                        && surface_visible(
                            state.present,
                            background || state.spec.background,
                            bounds,
                            &state.overlays,
                        );
                    let presentation = state.events.presentation.borrow();
                    let ready = presentation.ready;
                    let revealable = presentation.revealable();
                    drop(presentation);
                    if let Some(view) = &state.view
                        && let Err(error) = native::present(
                            view,
                            visible || state.spec.background,
                            visible && revealable,
                        )
                    {
                        state.events.push(WebViewEvent::Error(error.clone()));
                        state.error = Some(error);
                        return;
                    }
                    state.visible = visible && revealable;
                    if visible && ready {
                        state.events.revealed();
                    }
                },
            )
            .size_full();
            if background {
                surface.into_any_element()
            } else {
                div()
                    .relative()
                    .size_full()
                    .child(placeholder)
                    .child(div().absolute().inset_0().size_full().child(surface))
                    .into_any_element()
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let url = self.0.borrow().spec.url.clone();
            div()
                .id("webview-linux-stub")
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .cursor_pointer()
                .child("Open in browser")
                .on_click(move |_, _, cx| cx.open_url(&url))
                .into_any_element()
        }
    }
}

impl SurfaceState {
    fn set_visible(&mut self, visible: bool) {
        if self.visible == visible {
            return;
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        if let Some(view) = &self.view
            && let Err(error) = native::present(
                view,
                visible,
                visible && self.events.presentation.borrow().revealable(),
            )
        {
            self.events.push(WebViewEvent::Error(error.clone()));
            self.error = Some(error);
        }
        self.visible = visible;
    }
}

#[derive(Clone, Copy)]
enum Command {
    Back,
    Forward,
    Reload,
    Stop,
    FocusParent,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SurfaceBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl From<Bounds<Pixels>> for SurfaceBounds {
    fn from(bounds: Bounds<Pixels>) -> Self {
        Self {
            x: f32::from(bounds.origin.x).into(),
            y: f32::from(bounds.origin.y).into(),
            width: f32::from(bounds.size.width).into(),
            height: f32::from(bounds.size.height).into(),
        }
    }
}

impl SurfaceBounds {
    fn pixel_aligned(self, scale: f32) -> Self {
        let scale = if scale.is_finite() && scale > 0.0 {
            f64::from(scale)
        } else {
            1.0
        };
        let align = |value: f64| (value * scale).round() / scale;
        Self {
            x: align(self.x),
            y: align(self.y),
            width: align(self.width).max(0.0),
            height: align(self.height).max(0.0),
        }
    }

    fn intersects(self, other: Self) -> bool {
        self.width > 0.0
            && self.height > 0.0
            && other.width > 0.0
            && other.height > 0.0
            && self.x < other.x + other.width
            && self.x + self.width > other.x
            && self.y < other.y + other.height
            && self.y + self.height > other.y
    }
}

fn surface_visible(
    present: bool,
    background: bool,
    bounds: SurfaceBounds,
    overlays: &[SurfaceBounds],
) -> bool {
    present
        && !background
        && bounds.width > 0.0
        && bounds.height > 0.0
        && !overlays.iter().any(|overlay| bounds.intersects(*overlay))
}

fn is_web_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::prelude::v1::test;

    #[test]
    fn saved_profile_web_identity_survives_tunnel_port_changes() {
        let first = WebViewStores::new(
            "/isolated/app".into(),
            Some(("ssh-a".into(), "ws://127.0.0.1:18789/".into())),
        );
        let scope = first.control_scope("ws://127.0.0.1:41401/").unwrap();
        assert_eq!(scope, "profile:ssh-a:control:http://127.0.0.1:18789");
        assert_eq!(scope, first.control_scope("ws://127.0.0.1:41402/").unwrap());
        let second = WebViewStores::new(
            "/isolated/app".into(),
            Some(("ssh-b".into(), "ws://127.0.0.1:18789/".into())),
        );
        assert_ne!(
            scope,
            second.control_scope("ws://127.0.0.1:41401/").unwrap()
        );
        let ad_hoc = WebViewStores::new("/isolated/app".into(), None);
        assert_eq!(
            ad_hoc.control_scope("wss://EXAMPLE.test:443/path").unwrap(),
            "control:https://example.test"
        );
    }

    #[test]
    fn retina_bounds_remain_logical_and_overlays_only_hide_intersections() {
        let bounds = SurfaceBounds {
            x: 80.24,
            y: 60.26,
            width: 400.24,
            height: 300.26,
        }
        .pixel_aligned(2.0);
        assert_eq!(
            bounds,
            SurfaceBounds {
                x: 80.0,
                y: 60.5,
                width: 400.0,
                height: 300.5
            }
        );
        let adjacent = SurfaceBounds {
            x: 480.0,
            y: 60.5,
            width: 80.0,
            height: 40.0,
        };
        assert!(surface_visible(true, false, bounds, &[adjacent]));
        assert!(!surface_visible(
            true,
            false,
            bounds,
            &[SurfaceBounds {
                x: 479.5,
                ..adjacent
            }]
        ));
        assert!(!surface_visible(false, false, bounds, &[]));
        assert!(!surface_visible(true, true, bounds, &[]));
        assert!(surface_visible(true, false, bounds, &[]));
    }
}
