use super::theme::tokens::{icon, shell, space, text};
use super::{AppView, agent_browser::AgentBrowser, theme::Palette, web_state::ReadingTab};
use crate::model::panels::{LinkTarget, PanelSlot, classify_link, normalize_reading_url};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Selectable, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::Input,
        spinner::Spinner,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn open_transcript_link(&mut self, url: &str, cx: &mut Context<Self>) {
        match classify_link(url) {
            LinkTarget::Reading(url) => {
                let routed = self.panel_context().is_some_and(|context| {
                    let Some(dock) = self.web.sessions.get(&context) else {
                        return false;
                    };
                    if !dock
                        .available
                        .iter()
                        .any(|entry| entry.slot == "link-reader" && entry.available)
                    {
                        return false;
                    }
                    let Some(catalog) = &dock.catalog else {
                        return false;
                    };
                    let id = uuid::Uuid::new_v4().to_string();
                    if catalog
                        .request_link(&id, &context.agent, &context.session, &url)
                        .is_err()
                    {
                        return false;
                    }
                    self.web.pending_links.insert(id, (context, url.clone()));
                    true
                });
                if !routed {
                    self.open_reading_url(&url, cx);
                }
            }
            LinkTarget::External(url) => cx.open_url(&url),
            LinkTarget::Blocked
                if !url.contains(':') && !url.starts_with('#') && !url.trim().is_empty() =>
            {
                self.open_workspace_file(url, cx)
            }
            LinkTarget::Blocked => {
                self.web.error = Some("This link cannot be opened by the browser panel.".into())
            }
        }
        cx.notify();
    }

    pub(super) fn open_link_reader(&mut self, url: &str, cx: &mut Context<Self>) {
        let Some(context) = self.panel_context() else {
            return;
        };
        let dock = self.web.sessions.entry(context).or_default();
        dock.layout.open(PanelSlot::LinkReader);
        if let Some(panel) = dock
            .layout
            .panels
            .iter_mut()
            .find(|panel| panel.slot == PanelSlot::LinkReader)
        {
            panel.resource_url = Some(url.into());
        }
        dock.panels.remove(&PanelSlot::LinkReader);
        cx.notify();
    }

    pub(super) fn open_workspace_file(&mut self, path: &str, cx: &mut Context<Self>) {
        let Some(context) = self.panel_context() else {
            return;
        };
        let dock = self.web.sessions.entry(context).or_default();
        dock.layout.open(PanelSlot::Workspace);
        if let Some(panel) = dock
            .layout
            .panels
            .iter_mut()
            .find(|panel| panel.slot == PanelSlot::Workspace)
        {
            panel.file_path = Some(path.into());
        }
        dock.panels.remove(&PanelSlot::Workspace);
        cx.notify();
    }

    pub(super) fn open_reading_url(&mut self, url: &str, cx: &mut Context<Self>) {
        let Some(context) = self.panel_context() else {
            return;
        };
        let url = if url == "about:blank" {
            url.to_owned()
        } else if let Some(url) = normalize_reading_url(url) {
            url
        } else {
            self.web.error = Some("Enter an HTTP or HTTPS URL.".into());
            cx.notify();
            return;
        };
        match self.web.surface(url.clone(), false, false) {
            Ok(surface) => {
                self.web.next_tab += 1;
                let id = self.web.next_tab;
                let dock = self.web.sessions.entry(context).or_default();
                dock.layout.open(PanelSlot::Browser);
                dock.agent_mode = false;
                dock.tabs.push(ReadingTab {
                    id,
                    title: if url == "about:blank" {
                        "New tab".into()
                    } else {
                        url.clone()
                    },
                    url,
                    loading: false,
                    surface,
                    can_go_back: false,
                    can_go_forward: false,
                });
                dock.selected_tab = Some(id);
                self.web.address_dirty = true;
                self.web.settings_open = false;
                self.web.picker_open = false;
            }
            Err(error) => self.web.error = Some(error),
        }
        cx.notify();
    }

    pub(super) fn navigate_reading_tab(&mut self, cx: &mut Context<Self>) {
        let value = self.web.address.read(cx).value().to_string();
        let Some(url) = normalize_reading_url(&value) else {
            self.web.error = Some("Enter an HTTP or HTTPS URL.".into());
            cx.notify();
            return;
        };
        let tab = self
            .panel_context()
            .and_then(|context| self.web.sessions.get_mut(&context))
            .and_then(|dock| {
                dock.tabs
                    .iter_mut()
                    .find(|tab| Some(tab.id) == dock.selected_tab)
            });
        if let Some(tab) = tab {
            if let Err(error) = tab.surface.navigate(&url) {
                self.web.error = Some(error);
            } else {
                tab.url = url;
                tab.loading = true;
            }
            self.web.address_dirty = true;
        } else {
            self.open_reading_url(&url, cx);
        }
        cx.notify();
    }

    fn select_reading_tab(&mut self, id: u64, cx: &mut Context<Self>) {
        if let Some(dock) = self
            .panel_context()
            .and_then(|key| self.web.sessions.get_mut(&key))
        {
            dock.selected_tab = Some(id);
            self.web.address_dirty = true;
        }
        cx.notify();
    }

    fn close_reading_tab(&mut self, id: u64, cx: &mut Context<Self>) {
        if let Some(dock) = self
            .panel_context()
            .and_then(|key| self.web.sessions.get_mut(&key))
        {
            let index = dock
                .tabs
                .iter()
                .position(|tab| tab.id == id)
                .unwrap_or_default();
            dock.tabs.retain(|tab| tab.id != id);
            if dock.selected_tab == Some(id) {
                dock.selected_tab = dock
                    .tabs
                    .get(index.min(dock.tabs.len().saturating_sub(1)))
                    .map(|tab| tab.id);
            }
            self.web.address_dirty = true;
        }
        cx.notify();
    }

    fn browser_command(&mut self, command: &'static str, cx: &mut Context<Self>) {
        if let Some(tab) = self.current_dock().and_then(|dock| {
            dock.tabs
                .iter()
                .find(|tab| Some(tab.id) == dock.selected_tab)
        }) {
            match command {
                "back" => tab.surface.back(),
                "forward" => tab.surface.forward(),
                "reload" => tab.surface.reload(),
                "stop" => tab.surface.stop(),
                "external" if tab.url != "about:blank" => cx.open_url(&tab.url),
                _ => {}
            }
        }
    }

    pub(super) fn browser_panel(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let Some(context) = self.panel_context() else {
            return div().into_any_element();
        };
        let agent_mode = self.current_dock().is_some_and(|dock| dock.agent_mode);
        let agent_available = self.current_dock().is_some_and(|dock| {
            dock.available
                .iter()
                .any(|entry| entry.slot == "browser" && entry.available)
        });
        if agent_mode
            && self
                .current_dock()
                .is_some_and(|dock| dock.agent_browser.is_none())
            && let (Some(gateway), Some(auth)) = (self.session.clone(), self.web.auth.clone())
        {
            let runtime = self.runtime.clone();
            let session_key = context.session.clone();
            let agent = context.agent.clone();
            let access_token = auth.access_session.and_then(|session| {
                session
                    .authorization_header(&auth.gateway_url, crate::gateway::access::now())
                    .map(str::to_owned)
            });
            let browser = cx.new(|cx| {
                AgentBrowser::new(
                    runtime,
                    gateway,
                    auth.gateway_url,
                    access_token,
                    session_key,
                    Some(agent),
                    window,
                    cx,
                )
            });
            let target = self
                .current_dock()
                .and_then(|dock| dock.preferred_browser.clone());
            browser.update(cx, |browser, cx| {
                browser.set_target(target, cx);
                browser.set_presented(true, cx);
            });
            self.web
                .sessions
                .get_mut(&context)
                .expect("current dock")
                .agent_browser = Some(browser);
        }
        let modes = div()
            .h_flex()
            .h(shell::BROWSER_MODE_HEIGHT)
            .px(space::REM_SM)
            .gap(space::REM_XS)
            .border_b(space::HAIRLINE)
            .border_color(p.border)
            .child(
                Button::new("reading-mode")
                    .ghost()
                    .small()
                    .label("Reading tabs")
                    .selected(!agent_mode)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(dock) = this
                            .panel_context()
                            .and_then(|key| this.web.sessions.get_mut(&key))
                        {
                            dock.agent_mode = false;
                        }
                        cx.notify();
                    })),
            )
            .child(
                Button::new("agent-browser-mode")
                    .ghost()
                    .small()
                    .label("Agent browser")
                    .selected(agent_mode)
                    .disabled(!agent_available)
                    .on_click(cx.listener(|this, _, _, cx| {
                        if let Some(dock) = this
                            .panel_context()
                            .and_then(|key| this.web.sessions.get_mut(&key))
                        {
                            dock.agent_mode = true;
                        }
                        cx.notify();
                    })),
            );
        if agent_mode {
            return div()
                .v_flex()
                .size_full()
                .child(modes)
                .children(
                    self.current_dock()
                        .and_then(|dock| dock.agent_browser.clone()),
                )
                .into_any_element();
        }
        let dock = self.current_dock().expect("current dock");
        let selected = dock
            .tabs
            .iter()
            .find(|tab| Some(tab.id) == dock.selected_tab);
        let loading = selected.is_some_and(|tab| tab.loading);
        let can_back = selected.is_some_and(|tab| tab.can_go_back);
        let can_forward = selected.is_some_and(|tab| tab.can_go_forward);
        let content = selected
            .map(|tab| tab.surface.element())
            .unwrap_or_else(|| {
                div()
                    .v_flex()
                    .flex_1()
                    .items_center()
                    .justify_center()
                    .gap(space::REM_MD)
                    .text_color(p.muted)
                    .child(Icon::new(IconName::Globe).size(shell::BROWSER_EMPTY_ICON_SIZE))
                    .child("Open a link or enter a URL above.")
                    .into_any_element()
            });
        let mut tabs = div()
            .id("reading-tab-strip")
            .h_flex()
            .h(shell::BROWSER_TAB_HEIGHT)
            .min_w_0()
            .overflow_x_scroll()
            .border_b(space::HAIRLINE)
            .border_color(p.border);
        for tab in &dock.tabs {
            let id = tab.id;
            tabs = tabs.child(
                div()
                    .id(SharedString::from(format!("reading-tab-{id}")))
                    .h_flex()
                    .h_full()
                    .max_w(shell::BROWSER_TAB_MAX_WIDTH)
                    .min_w(shell::BROWSER_TAB_MIN_WIDTH)
                    .px(space::REM_SM)
                    .gap(space::REM_XS)
                    .when(Some(id) == dock.selected_tab, |el| el.bg(p.hover))
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .text_size(text::WIDGET_XS_SIZE)
                            .child(tab.title.clone()),
                    )
                    .child(
                        Button::new(SharedString::from(format!("close-reading-{id}")))
                            .ghost()
                            .xsmall()
                            .size(shell::TAB_CLOSE_SIZE)
                            .icon(Icon::new(IconName::X).size(icon::SMALL))
                            .accessibility_label("Close reading tab")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                this.close_reading_tab(id, cx);
                            })),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.select_reading_tab(id, cx))),
            );
        }
        tabs = tabs.child(
            Button::new("new-reading-tab")
                .ghost()
                .small()
                .size(shell::BROWSER_NEW_TAB_SIZE)
                .icon(Icon::new(IconName::Plus).size(icon::ACTION))
                .accessibility_label("New reading tab")
                .on_click(cx.listener(|this, _, window, cx| {
                    this.open_reading_url("about:blank", cx);
                    this.web
                        .address
                        .update(cx, |input, cx| input.focus(window, cx));
                })),
        );
        let toolbar = div()
            .h_flex()
            .h(shell::BROWSER_TOOLBAR_HEIGHT)
            .px(space::REM_XS)
            .gap(space::REM_XS)
            .border_b(space::HAIRLINE)
            .border_color(p.border)
            .child(browser_button(
                "back",
                IconName::ArrowLeft,
                "Back",
                !can_back,
                cx,
            ))
            .child(browser_button(
                "forward",
                IconName::ArrowRight,
                "Forward",
                !can_forward,
                cx,
            ))
            .child(browser_button(
                if loading { "stop" } else { "reload" },
                if loading {
                    IconName::X
                } else {
                    IconName::RotateCw
                },
                if loading { "Stop loading" } else { "Reload" },
                selected.is_none(),
                cx,
            ))
            .child(
                Input::new(&self.web.address)
                    .small()
                    .h(shell::CHROME_BUTTON_SIZE)
                    .flex_1()
                    .aria_label("Browser URL"),
            )
            .when(loading, |el| {
                el.child(Spinner::new().small().color(p.muted))
            })
            .child(browser_button(
                "external",
                IconName::ExternalLink,
                "Open in system browser",
                selected.is_none(),
                cx,
            ));
        div()
            .v_flex()
            .size_full()
            .min_w_0()
            .child(modes)
            .child(tabs)
            .child(toolbar)
            .child(div().flex_1().min_h_0().child(content))
            .into_any_element()
    }
}

fn browser_button(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    disabled: bool,
    cx: &mut Context<AppView>,
) -> Button {
    Button::new(id)
        .ghost()
        .small()
        .size(shell::CHROME_BUTTON_SIZE)
        .icon(Icon::new(icon).size(icon::ACTION))
        .accessibility_label(label)
        .disabled(disabled)
        .on_click(cx.listener(move |this, _, _, cx| this.browser_command(id, cx)))
}
