mod events;

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
        crate::web_data_store::control_scope(gateway_url, self.profile.as_ref())
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
}
