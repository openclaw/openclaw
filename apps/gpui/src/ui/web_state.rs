use super::{
    AppView,
    agent_browser::AgentBrowser,
    webview_surface::{
        WebViewEvent, WebViewRetirement, WebViewSpec, WebViewStores, WebViewSurface,
    },
};
use crate::{
    gateway::{access, config::ConnectionConfig, identity::Identity},
    model::{
        panels::{DockLayout, PanelDefinition, PanelSlot},
        web_urls::{self, ControlUiTab, WebAuth},
        webview_pool::{WebViewKind, WebviewPool},
    },
};
use gpui_kit::{
    component::input::{InputEvent, InputState},
    *,
};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct PanelContext {
    pub agent: String,
    pub session: String,
}

pub(super) struct ReadingTab {
    pub id: u64,
    pub title: String,
    pub url: String,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub surface: WebViewSurface,
}

#[derive(Default)]
pub(super) struct SessionDock {
    pub layout: DockLayout,
    pub available: Vec<PanelDefinition>,
    pub catalog: Option<WebViewSurface>,
    pub catalog_dismissed: bool,
    pub panels: HashMap<PanelSlot, WebViewSurface>,
    pub tabs: Vec<ReadingTab>,
    pub selected_tab: Option<u64>,
    pub agent_mode: bool,
    pub agent_browser: Option<Entity<AgentBrowser>>,
    pub preferred_browser: Option<crate::gateway::browser_rpc::BrowserTarget>,
}

pub(super) struct WebUi {
    pub auth: Option<WebAuth>,
    pub stores: Option<WebViewStores>,
    pub pool: WebviewPool<WebViewSurface>,
    warm_pending: Option<u64>,
    profile: Option<(String, String)>,
    pub settings_open: bool,
    pub settings: Option<WebViewSurface>,
    pub page_path: String,
    pub page_label: String,
    pub control_tabs: Vec<ControlUiTab>,
    pub control_tabs_epoch: Option<u64>,
    pub control_tabs_request: u64,
    pub sessions: HashMap<PanelContext, SessionDock>,
    pub picker_open: bool,
    pub resizing: bool,
    pub error: Option<String>,
    pub address: Entity<InputState>,
    pub address_dirty: bool,
    pub next_tab: u64,
    pub pending_links: HashMap<String, (PanelContext, String)>,
    pub wake: async_channel::Sender<()>,
    _address_subscription: Subscription,
}

impl WebUi {
    pub fn new(
        wake: async_channel::Sender<()>,
        window: &mut Window,
        cx: &mut Context<AppView>,
    ) -> Self {
        let address = cx.new(|cx| InputState::new(window, cx).placeholder("Enter a URL…"));
        let subscription = cx.subscribe_in(&address, window, |this, _, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. }) {
                this.navigate_reading_tab(cx);
            }
        });
        Self {
            auth: None,
            stores: None,
            pool: WebviewPool::default(),
            warm_pending: None,
            profile: None,
            settings_open: false,
            settings: None,
            page_path: "/settings/appearance".into(),
            page_label: "Appearance".into(),
            control_tabs: Vec::new(),
            control_tabs_epoch: None,
            control_tabs_request: 0,
            sessions: HashMap::new(),
            picker_open: false,
            resizing: false,
            error: None,
            address,
            address_dirty: true,
            next_tab: 0,
            pending_links: HashMap::new(),
            wake,
            _address_subscription: subscription,
        }
    }

    pub fn reset(&mut self) {
        self.retire_spares();
        self.pending_links.clear();
        self.settings = None;
        self.sessions.clear();
        self.stores = None;
        self.auth = None;
        self.settings_open = false;
        self.page_path = "/settings/appearance".into();
        self.page_label = "Appearance".into();
        self.control_tabs.clear();
        self.control_tabs_epoch = None;
        self.control_tabs_request += 1;
        self.picker_open = false;
        self.error = None;
    }

    pub fn set_profile(&mut self, id: Option<String>, canonical_gateway_url: String) {
        let profile = id.map(|id| (id, canonical_gateway_url));
        if self.profile != profile {
            self.reset();
            self.profile = profile;
        }
    }

    pub fn control_scope(&self, gateway_url: &str) -> Result<String, String> {
        match &self.profile {
            Some((id, canonical_url)) => {
                crate::web_data_store::profile_control_scope(id, canonical_url)
            }
            None => crate::web_data_store::control_scope(gateway_url),
        }
    }

    pub fn retire_all(&mut self) -> Vec<WebViewRetirement> {
        let mut retired = self.retire_control();
        for dock in self.sessions.values() {
            for tab in &dock.tabs {
                retired.extend(tab.surface.retire());
            }
        }
        self.reset();
        retired
    }

    pub fn retire_control(&mut self) -> Vec<WebViewRetirement> {
        let mut retired = self.retire_spares();
        self.auth = None;
        if let Some(surface) = &self.settings {
            retired.extend(surface.retire());
        }
        self.settings = None;
        self.pending_links.clear();
        for dock in self.sessions.values_mut() {
            if let Some(surface) = &dock.catalog {
                retired.extend(surface.retire());
            }
            for surface in dock.panels.values() {
                retired.extend(surface.retire());
            }
            dock.catalog = None;
            dock.panels.clear();
            dock.agent_browser = None;
            dock.available.clear();
        }
        retired
    }

    pub fn connect(&mut self, config: &ConnectionConfig, access_session: Option<access::Session>) {
        if self
            .auth
            .as_ref()
            .is_some_and(|auth| auth.gateway_url != config.url)
        {
            self.retire_control();
        }
        self.auth = Some(WebAuth::from_config(config, access_session));
        for surface in self.pool.connect(&config.url) {
            surface.retire();
        }
    }

    fn retire_spares(&mut self) -> Vec<WebViewRetirement> {
        self.warm_pending = None;
        self.pool
            .clear()
            .into_iter()
            .filter_map(|surface| surface.retire())
            .collect()
    }

    pub fn surface(
        &mut self,
        url: String,
        background: bool,
        authenticated: bool,
    ) -> Result<WebViewSurface, String> {
        let kind = if authenticated {
            WebViewKind::Control
        } else {
            WebViewKind::Reading
        };
        // Metadata catalogs are active owners, not user opens. Leave the spare
        // for the next visible page instead of consuming it on session selection.
        if !background && let Some(surface) = self.pool.adopt(kind, WebViewSurface::is_ready) {
            surface.adopt(&url, background)?;
            return Ok(surface);
        }
        self.create_surface(url, background, authenticated)
    }

    fn create_surface(
        &mut self,
        url: String,
        background: bool,
        authenticated: bool,
    ) -> Result<WebViewSurface, String> {
        if self.stores.is_none() {
            self.stores = Some(WebViewStores::new(
                Identity::directory()?,
                self.profile.clone(),
            ));
        }
        let auth = self.auth.clone().ok_or("Connect to a Gateway first")?;
        let stores = self.stores.as_mut().expect("initialized web stores");
        let store = if authenticated {
            stores.control(&auth.gateway_url)?
        } else {
            stores.reading()?
        };
        Ok(WebViewSurface::new(
            WebViewSpec {
                url,
                auth: authenticated.then_some(auth),
                background,
            },
            store,
            self.wake.clone(),
        ))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelState {
    #[serde(rename = "type")]
    kind: String,
    agent_id: String,
    session_key: String,
    panels: Vec<PanelDefinition>,
    #[serde(default)]
    revealed_slots: Vec<String>,
    preferred_browser_tab: Option<PreferredBrowser>,
    #[serde(default)]
    open_panels: Vec<OpenPanel>,
    active_slot: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenPanel {
    slot: String,
    task_id: Option<String>,
    portal_id: Option<String>,
    environment_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PanelLinkReply {
    #[serde(rename = "type")]
    kind: String,
    agent_id: String,
    session_key: String,
    request_id: String,
    url: String,
    reader: bool,
}

#[derive(Deserialize)]
struct PreferredBrowser {
    tab: crate::gateway::browser_rpc::BrowserTarget,
}

impl AppView {
    pub(super) fn panel_context(&self) -> Option<PanelContext> {
        Some(PanelContext {
            agent: self.chat.selected_agent.clone().unwrap_or_else(|| {
                self.sidebar_state
                    .selected_agent
                    .clone()
                    .unwrap_or_else(|| "main".into())
            }),
            session: self.chat.selected_session.clone()?,
        })
    }

    pub(super) fn current_dock(&self) -> Option<&SessionDock> {
        self.web.sessions.get(&self.panel_context()?)
    }

    pub(super) fn sync_web_surfaces(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.sync_control_navigation();
        let result = self.prepare_web_surfaces();
        if let Err(error) = result {
            self.web.error = Some(error);
        }
        self.warm_web_surfaces(window, cx);
        if self.web.address_dirty {
            let value = self
                .current_dock()
                .and_then(|dock| {
                    dock.tabs
                        .iter()
                        .find(|tab| Some(tab.id) == dock.selected_tab)
                })
                .map(|tab| tab.url.clone())
                .unwrap_or_default();
            self.web
                .address
                .update(cx, |input, cx| input.set_value(value, window, cx));
            self.web.address_dirty = false;
        }
        let current = self.panel_context();
        let visible = !self.show_connect_form && self.session.is_some();
        if let Some(surface) = &self.web.settings {
            surface.set_present(visible && self.web.settings_open);
        }
        for (key, dock) in &self.web.sessions {
            let shown = visible
                && !self.web.settings_open
                && Some(key) == current.as_ref()
                && dock.layout.open;
            for (slot, surface) in &dock.panels {
                surface.set_present(shown && dock.layout.active.as_ref() == Some(slot));
            }
            for tab in &dock.tabs {
                tab.surface.set_present(
                    shown
                        && !dock.agent_mode
                        && dock.layout.active == Some(PanelSlot::Browser)
                        && dock.selected_tab == Some(tab.id),
                );
            }
            if let Some(browser) = &dock.agent_browser {
                browser.update(cx, |browser, cx| {
                    browser.set_presented(
                        shown && dock.agent_mode && dock.layout.active == Some(PanelSlot::Browser),
                        cx,
                    )
                });
            }
        }
        let dark = gpui_kit::component::Theme::global(cx).is_dark();
        for kind in [WebViewKind::Control, WebViewKind::Reading] {
            if let Some(surface) = self.web.pool.get(kind) {
                surface.set_dark(dark);
            }
        }
        if let Some(surface) = &self.web.settings {
            surface.set_dark(dark);
        }
        for dock in self.web.sessions.values() {
            for surface in dock.panels.values() {
                surface.set_dark(dark);
            }
            for tab in &dock.tabs {
                tab.surface.set_dark(dark);
            }
        }
        self.sync_web_overlays(window, cx);
    }

    fn warm_web_surfaces(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.session.is_none()
            || self.show_connect_form
            || self.web.auth.is_none()
            || self.web.warm_pending.is_some()
            || ![WebViewKind::Control, WebViewKind::Reading]
                .iter()
                .any(|kind| self.web.pool.needs(*kind))
        {
            return;
        }
        // The connected shell paints first. Creation then uses the same hidden,
        // unfocused native child path as metadata surfaces; it never activates a window.
        let generation = self.web.pool.generation();
        self.web.warm_pending = Some(generation);
        cx.on_next_frame(window, move |this, _, cx| {
            if this.web.pool.generation() != generation || this.web.warm_pending != Some(generation)
            {
                return;
            }
            this.web.warm_pending = None;
            if this.session.is_none() || this.show_connect_form {
                return;
            }
            for kind in [WebViewKind::Control, WebViewKind::Reading] {
                if !this.web.pool.needs(kind) {
                    continue;
                }
                let url = match kind {
                    WebViewKind::Control => this
                        .web
                        .auth
                        .as_ref()
                        .ok_or_else(|| "Connect to a Gateway first".to_owned())
                        .and_then(|auth| {
                            web_urls::control_page_url(&auth.gateway_url, "/settings/appearance")
                        }),
                    WebViewKind::Reading => Ok("about:blank".into()),
                };
                match url.and_then(|url| {
                    this.web
                        .create_surface(url, true, matches!(kind, WebViewKind::Control))
                }) {
                    Ok(surface) => {
                        let _ = this.web.pool.insert(generation, kind, surface);
                    }
                    Err(error) => {
                        log::warn!("Could not pre-warm webview: {error}");
                        // Do not reattempt on every paint. A new connection resets this fence.
                        this.web.warm_pending = Some(generation);
                        break;
                    }
                }
            }
            cx.notify();
        });
    }

    pub(super) fn warm_web_elements(&self) -> Vec<AnyElement> {
        [WebViewKind::Control, WebViewKind::Reading]
            .iter()
            .filter_map(|kind| {
                self.web.pool.get(*kind).map(|surface| {
                    div()
                        .absolute()
                        .inset_0()
                        .size_full()
                        .child(surface.element())
                        .into_any_element()
                })
            })
            .collect()
    }

    fn prepare_web_surfaces(&mut self) -> Result<(), String> {
        if self.web.auth.is_none() || self.session.is_none() || self.show_connect_form {
            return Ok(());
        }
        let gateway = self
            .web
            .auth
            .as_ref()
            .expect("checked auth")
            .gateway_url
            .clone();
        if self.web.settings_open && self.web.settings.is_none() {
            self.web.settings = Some(self.web.surface(
                web_urls::control_page_url(&gateway, &self.web.page_path)?,
                false,
                true,
            )?);
        }
        let Some(context) = self.panel_context() else {
            return Ok(());
        };
        let dock = self.web.sessions.entry(context.clone()).or_default();
        let dismissed = dock.layout.resource_auto_open_dismissed;
        let catalog_url = web_urls::panel_url(
            &gateway,
            &context.agent,
            &context.session,
            "picker",
            if dismissed {
                &[("resourceAutoOpenDismissed", "1")]
            } else {
                &[]
            },
        )?;
        if let Some(catalog) = &dock.catalog {
            if dock.catalog_dismissed != dismissed {
                catalog.navigate(&catalog_url)?;
            }
        } else {
            let surface = self.web.surface(catalog_url, true, true)?;
            self.web
                .sessions
                .get_mut(&context)
                .expect("current dock")
                .catalog = Some(surface);
        }
        let dock = self.web.sessions.get_mut(&context).expect("current dock");
        dock.catalog_dismissed = dismissed;
        let panel = dock
            .layout
            .panels
            .iter()
            .find(|panel| Some(&panel.slot) == dock.layout.active.as_ref())
            .cloned();
        if let Some(panel) = panel.filter(|panel| {
            panel.slot != PanelSlot::Browser && !dock.panels.contains_key(&panel.slot)
        }) {
            let mut extras = Vec::new();
            if let Some(id) = &panel.task_id {
                extras.push(("taskId", id.as_str()));
            }
            if let Some(id) = &panel.portal_id {
                extras.push(("portalId", id.as_str()));
            }
            if let Some(id) = &panel.environment_id {
                extras.push(("environmentId", id.as_str()));
            }
            if let Some(url) = &panel.resource_url {
                extras.push(("url", url));
            }
            if let Some(path) = &panel.file_path {
                extras.push(("path", path));
            }
            let url = web_urls::panel_url(
                &gateway,
                &context.agent,
                &context.session,
                panel.slot.as_str(),
                &extras,
            )?;
            let surface = self.web.surface(url, false, true)?;
            self.web
                .sessions
                .get_mut(&context)
                .expect("current dock")
                .panels
                .insert(panel.slot, surface);
        }
        Ok(())
    }

    pub(super) fn drain_web_events(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        for kind in [WebViewKind::Control, WebViewKind::Reading] {
            if let Some(surface) = self.web.pool.get(kind) {
                // Spares cannot issue navigation, shortcut or panel actions.
                surface.drain_events();
            }
        }
        let mut events = Vec::new();
        if let Some(surface) = &self.web.settings {
            events.extend(
                surface
                    .drain_events()
                    .into_iter()
                    .map(|event| (None, None, event)),
            );
        }
        for (context, dock) in &self.web.sessions {
            if let Some(surface) = &dock.catalog {
                events.extend(
                    surface
                        .drain_events()
                        .into_iter()
                        .map(|event| (Some(context.clone()), None, event)),
                );
            }
            for surface in dock.panels.values() {
                events.extend(
                    surface
                        .drain_events()
                        .into_iter()
                        .map(|event| (Some(context.clone()), None, event)),
                );
            }
            for tab in &dock.tabs {
                events.extend(
                    tab.surface
                        .drain_events()
                        .into_iter()
                        .map(|event| (Some(context.clone()), Some(tab.id), event)),
                );
            }
        }
        for (context, tab, event) in events {
            let current = context.is_none() || context == self.panel_context();
            match event {
                WebViewEvent::Title(title) => {
                    if let Some(tab) = self.reading_tab_mut(context.as_ref(), tab) {
                        tab.title = title;
                    }
                }
                WebViewEvent::Url(url) => {
                    if let Some(tab) = self.reading_tab_mut(context.as_ref(), tab) {
                        tab.url = url;
                        if current {
                            self.web.address_dirty = true;
                        }
                    } else if context.is_none() {
                        self.record_control_navigation(&url);
                    }
                }
                WebViewEvent::Loading(loading) => {
                    if let Some(tab) = self.reading_tab_mut(context.as_ref(), tab) {
                        tab.loading = loading;
                    }
                }
                WebViewEvent::History {
                    can_go_back,
                    can_go_forward,
                } => {
                    if let Some(tab) = self.reading_tab_mut(context.as_ref(), tab) {
                        tab.can_go_back = can_go_back;
                        tab.can_go_forward = can_go_forward;
                    }
                }
                WebViewEvent::NewWindow(url) if current => self.open_reading_url(&url, cx),
                WebViewEvent::External(url) if current => cx.open_url(&url),
                WebViewEvent::Escape if current => {
                    if self.web.settings_open {
                        self.close_settings(window, cx);
                    } else {
                        self.escape(window, cx);
                    }
                }
                WebViewEvent::Shortcut { key, shift, alt } if current => {
                    self.web_shortcut(&key, shift, alt, window, cx)
                }
                WebViewEvent::Ipc(message) if current => {
                    if let Ok(reply) = serde_json::from_str::<PanelLinkReply>(&message)
                        && reply.kind == "openclaw-panel-link"
                        && let Some((expected, url)) =
                            self.web.pending_links.remove(&reply.request_id)
                        && context.as_ref() == Some(&expected)
                        && expected.agent == reply.agent_id
                        && expected.session == reply.session_key
                        && reply.url == url
                    {
                        if reply.reader {
                            self.open_link_reader(&url, cx);
                        } else {
                            self.open_reading_url(&url, cx);
                        }
                        continue;
                    }
                    if let Ok(state) = serde_json::from_str::<PanelState>(&message) {
                        let key = PanelContext {
                            agent: state.agent_id,
                            session: state.session_key,
                        };
                        if state.kind == "openclaw-panel-state"
                            && context.as_ref() == Some(&key)
                            && let Some(dock) = self.web.sessions.get_mut(&key)
                        {
                            dock.available = state.panels;
                            for request in state.open_panels {
                                let Some(slot) = PanelSlot::parse(&request.slot) else {
                                    continue;
                                };
                                if !dock
                                    .available
                                    .iter()
                                    .any(|entry| entry.available && entry.slot == request.slot)
                                {
                                    continue;
                                }
                                let existing = dock
                                    .layout
                                    .panels
                                    .iter_mut()
                                    .find(|panel| panel.slot == slot);
                                if let Some(panel) = existing {
                                    if panel.task_id != request.task_id
                                        || panel.portal_id != request.portal_id
                                        || panel.environment_id != request.environment_id
                                    {
                                        panel.task_id = request.task_id;
                                        panel.portal_id = request.portal_id;
                                        panel.environment_id = request.environment_id;
                                        dock.panels.remove(&slot);
                                    }
                                } else {
                                    if matches!(slot, PanelSlot::Browser | PanelSlot::Desktop) {
                                        dock.layout.auto_reveal(slot.clone());
                                    } else {
                                        dock.layout.open(slot.clone());
                                    }
                                    if let Some(panel) = dock
                                        .layout
                                        .panels
                                        .iter_mut()
                                        .find(|panel| panel.slot == slot)
                                    {
                                        panel.task_id = request.task_id;
                                        panel.portal_id = request.portal_id;
                                        panel.environment_id = request.environment_id;
                                    }
                                }
                            }
                            if let Some(slot) =
                                state.active_slot.and_then(|slot| PanelSlot::parse(&slot))
                            {
                                dock.layout.activate(&slot);
                            }
                            let target = state.preferred_browser_tab.map(|preferred| preferred.tab);
                            if dock.preferred_browser != target {
                                dock.preferred_browser = target.clone();
                                if target.is_some() && !dock.layout.resource_auto_open_dismissed {
                                    dock.agent_mode = true;
                                }
                                if let Some(browser) = &dock.agent_browser {
                                    browser
                                        .update(cx, |browser, cx| browser.set_target(target, cx));
                                }
                            }
                            for slot in state
                                .revealed_slots
                                .iter()
                                .filter_map(|slot| PanelSlot::parse(slot))
                            {
                                dock.layout.auto_reveal(slot);
                            }
                        }
                    }
                }
                WebViewEvent::Error(error) if current => self.web.error = Some(error),
                _ => {}
            }
        }
        cx.notify();
    }

    fn reading_tab_mut(
        &mut self,
        context: Option<&PanelContext>,
        id: Option<u64>,
    ) -> Option<&mut ReadingTab> {
        self.web
            .sessions
            .get_mut(context?)?
            .tabs
            .iter_mut()
            .find(|tab| Some(tab.id) == id)
    }

    fn web_shortcut(
        &mut self,
        key: &str,
        shift: bool,
        alt: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        use crate::model::panels::PanelSlot;
        let slot = match (key, shift, alt) {
            ("b", true, false) => Some(PanelSlot::Workspace),
            ("s", true, false) => Some(PanelSlot::Companion),
            ("u", true, true) => Some(PanelSlot::Browser),
            ("k", true, true) => Some(PanelSlot::Tasks),
            ("d", true, true) => Some(PanelSlot::Desktop),
            ("j", true, true) => Some(PanelSlot::Discussion),
            ("g", true, true) => Some(PanelSlot::Dashboard),
            ("e", true, true) => Some(PanelSlot::Detail),
            _ => None,
        };
        if let Some(slot) = slot {
            self.toggle_panel(slot, cx);
            return;
        }
        match key {
            "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" if !shift && !alt => {
                let index = key.as_bytes()[0] as usize - b'1' as usize;
                cx.dispatch_action(&crate::gateway_windows::OpenGateway { index });
            }
            "," => self.open_settings(window, cx),
            "k" => self.open_palette(window, cx),
            "n" => self.new_chat(window, cx),
            "o" if shift && !alt => self.new_chat(window, cx),
            "b" => self.toggle_sidebar(cx),
            "r" => self.manual_refresh(cx),
            "[" => self.navigate_session(-1, window, cx),
            "]" => self.navigate_session(1, window, cx),
            "`" => self.toggle_panel(PanelSlot::Terminal, cx),
            "w" => window.remove_window(),
            _ => {}
        }
    }
}
