use super::*;

impl AppView {
    pub(in crate::ui) fn drain_web_events(&mut self, window: &mut Window, cx: &mut Context<Self>) {
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
