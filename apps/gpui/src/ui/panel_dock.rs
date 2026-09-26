use super::{AppView, theme::Palette};
use crate::model::panels::{DIVIDER_WIDTH, PanelSlot};
use gpui_kit::{
    assets::IconName,
    component::{
        GlobalState, Icon, Root, Sizable, StyledExt, WindowExt,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn toggle_panel(&mut self, slot: PanelSlot, cx: &mut Context<Self>) {
        let Some(key) = self.panel_context() else {
            return;
        };
        let dock = self.web.sessions.entry(key).or_default();
        if slot != PanelSlot::Browser
            && !dock
                .available
                .iter()
                .any(|entry| entry.slot == slot.as_str() && entry.available)
        {
            self.web.error = Some(format!(
                "{} is not available for this conversation.",
                slot.label()
            ));
            cx.notify();
            return;
        }
        if dock.layout.open && dock.layout.active.as_ref() == Some(&slot) {
            dock.layout.close(&slot);
            dock.panels.remove(&slot);
            if slot == PanelSlot::Browser {
                dock.tabs.clear();
                dock.agent_browser = None;
                dock.selected_tab = None;
            }
        } else {
            dock.layout.open(slot);
        }
        self.web.picker_open = false;
        self.web.settings_open = false;
        cx.notify();
    }

    pub(super) fn toggle_dock(&mut self, cx: &mut Context<Self>) {
        let Some(key) = self.panel_context() else {
            return;
        };
        let dock = self.web.sessions.entry(key).or_default();
        if dock.layout.panels.is_empty() {
            self.web.picker_open = !self.web.picker_open;
        } else {
            dock.layout.toggle_open();
        }
        cx.notify();
    }

    pub(super) fn focus_gpui_chrome(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(surface) = &self.web.settings {
            surface.focus_parent();
        }
        if let Some(dock) = self.current_dock() {
            for surface in dock.panels.values() {
                surface.focus_parent();
            }
            for tab in &dock.tabs {
                tab.surface.focus_parent();
            }
        }
        if window.focused(cx).is_none() {
            self.focus_handle.focus(window, cx);
        }
    }

    pub(super) fn sync_web_overlays(&self, window: &mut Window, cx: &mut Context<Self>) {
        let popup = self.web.error.is_some()
            || self.new_session.picker.is_some()
            || self.composer_capabilities.plus_open
            || self.composer_capabilities.permission_open
            || self.web.picker_open
            || self.sidebar_state.palette_open
            || self.model_controls.model_open
            || self.model_controls.effort_open
            || self.composer_state.usage_open
            || (!self.composer_state.slash_dismissed
                && self.composer.read(cx).value().starts_with('/'));
        let foreign_focus =
            window.focused(cx).is_some() && !self.focus_handle.contains_focused(window, cx);
        let overlay = popup
            || foreign_focus
            || GlobalState::is_in_deferred_context(cx)
            || window.has_active_dialog(cx)
            || window.has_active_sheet(cx)
            || !Root::read(window, cx)
                .notification
                .read(cx)
                .notifications()
                .is_empty();
        let bounds = if overlay {
            vec![Bounds::new(point(px(0.), px(0.)), window.viewport_size())]
        } else {
            vec![]
        };
        if let Some(surface) = &self.web.settings {
            surface.set_overlays(bounds.clone());
        }
        for dock in self.web.sessions.values() {
            for surface in dock.panels.values() {
                surface.set_overlays(bounds.clone());
            }
            for tab in &dock.tabs {
                tab.surface.set_overlays(bounds.clone());
            }
        }
    }

    pub(super) fn settings_body(&self) -> AnyElement {
        div()
            .v_flex()
            .flex_1()
            .min_w_0()
            .h_full()
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .children(self.web.settings.as_ref().map(|surface| surface.element())),
            )
            .into_any_element()
    }

    pub(super) fn panel_dock(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let Some(key) = self.panel_context() else {
            return div().into_any_element();
        };
        let available = f32::from(window.viewport_size().width)
            - if self.sidebar_state.collapsed {
                0.
            } else {
                self.sidebar_state.width
            };
        if let Some(dock) = self.web.sessions.get_mut(&key)
            && dock.layout.active == Some(PanelSlot::Browser)
        {
            dock.layout
                .initialize_browser_width(available, (available - 480.).max(312.));
        }
        let Some(dock) = self.web.sessions.get(&key) else {
            return div().into_any_element();
        };
        if !dock.layout.open {
            return div().into_any_element();
        }
        let expanded = dock.layout.expanded;
        let width = if expanded {
            available
        } else {
            dock.layout.fit_width(available).unwrap_or(available)
        };
        let active = dock.layout.active.clone();
        let panels = dock.layout.panels.clone();
        let mut strip = div()
            .id("panel-tabs")
            .h_flex()
            .h(px(38.))
            .min_w_0()
            .overflow_x_scroll()
            .flex_1();
        for panel in panels {
            let slot = panel.slot.clone();
            let close_slot = slot.clone();
            let label = dock
                .available
                .iter()
                .find(|entry| entry.slot == slot.as_str())
                .map(|entry| entry.label.clone())
                .unwrap_or_else(|| slot.label().into());
            strip = strip.child(
                div()
                    .id(SharedString::from(format!("dock-tab-{}", slot.as_str())))
                    .h_flex()
                    .h_full()
                    .px_2()
                    .gap_1()
                    .border_b_2()
                    .border_color(if Some(&slot) == active.as_ref() {
                        p.accent
                    } else {
                        p.bg
                    })
                    .when(Some(&slot) == active.as_ref(), |el| el.bg(p.hover))
                    .child(div().text_xs().whitespace_nowrap().child(label))
                    .child(
                        Button::new(SharedString::from(format!("close-panel-{}", slot.as_str())))
                            .ghost()
                            .xsmall()
                            .size(px(20.))
                            .icon(Icon::new(IconName::X).size(px(12.)))
                            .accessibility_label("Close panel")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                if let Some(dock) = this
                                    .panel_context()
                                    .and_then(|key| this.web.sessions.get_mut(&key))
                                {
                                    dock.layout.close(&close_slot);
                                    dock.panels.remove(&close_slot);
                                    if close_slot == PanelSlot::Browser {
                                        dock.tabs.clear();
                                        dock.selected_tab = None;
                                        dock.agent_browser = None;
                                    }
                                }
                                cx.notify();
                            })),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(dock) = this
                            .panel_context()
                            .and_then(|key| this.web.sessions.get_mut(&key))
                        {
                            dock.layout.activate(&slot);
                        }
                        cx.notify();
                    })),
            );
        }
        let toolbar = div()
            .h_flex()
            .h(px(38.))
            .border_b_1()
            .border_color(p.border)
            .child(strip)
            .child(
                Button::new("dock-add-panel")
                    .ghost()
                    .small()
                    .size(px(28.))
                    .icon(Icon::new(IconName::Plus).size(px(14.)))
                    .accessibility_label("Add panel")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.web.picker_open = !this.web.picker_open;
                        cx.notify();
                    })),
            )
            .child(
                Button::new("dock-expand")
                    .ghost()
                    .small()
                    .size(px(28.))
                    .icon(
                        Icon::new(if expanded {
                            IconName::Minimize2
                        } else {
                            IconName::Maximize2
                        })
                        .size(px(14.)),
                    )
                    .accessibility_label(if expanded {
                        "Restore panel width"
                    } else {
                        "Expand panel"
                    })
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.focus_handle.focus(window, cx);
                        if let Some(dock) = this
                            .panel_context()
                            .and_then(|key| this.web.sessions.get_mut(&key))
                        {
                            dock.layout.toggle_expanded();
                        }
                        cx.notify();
                    })),
            )
            .child(
                Button::new("dock-collapse")
                    .ghost()
                    .small()
                    .size(px(28.))
                    .icon(Icon::new(IconName::PanelRight).size(px(14.)))
                    .accessibility_label("Collapse panels")
                    .on_click(cx.listener(|this, _, _, cx| this.toggle_dock(cx))),
            );
        let content = if active == Some(PanelSlot::Browser) {
            self.browser_panel(window, cx)
        } else {
            self.current_dock()
                .and_then(|dock| active.as_ref().and_then(|slot| dock.panels.get(slot)))
                .map(|surface| surface.element())
                .unwrap_or_else(|| {
                    div()
                        .p_4()
                        .text_color(p.muted)
                        .child("Loading panel…")
                        .into_any_element()
                })
        };
        div()
            .h_flex()
            .w(px(width))
            .h_full()
            .flex_shrink_0()
            .min_w_0()
            .when(!expanded, |el| {
                el.child(
                    div()
                        .id("dock-resizer")
                        .w(px(DIVIDER_WIDTH))
                        .h_full()
                        .bg(p.border)
                        .cursor_col_resize()
                        .hover(|el| el.bg(p.focus_ring))
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, _, _, cx| {
                                this.web.resizing = true;
                                cx.stop_propagation();
                                cx.notify();
                            }),
                        ),
                )
            })
            .child(
                div()
                    .v_flex()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .bg(p.bg)
                    .child(toolbar)
                    .child(div().flex_1().min_h_0().child(content)),
            )
            .into_any_element()
    }

    pub(super) fn panel_picker(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let mut entries = vec![(PanelSlot::Browser, "Browser".to_owned())];
        if let Some(dock) = self.current_dock() {
            for entry in &dock.available {
                if entry.available
                    && let Some(slot) = PanelSlot::parse(&entry.slot)
                    && slot != PanelSlot::Browser
                {
                    entries.push((slot, entry.label.clone()));
                }
            }
        }
        let mut list = div()
            .id("panel-picker-list")
            .v_flex()
            .max_h(px(540.))
            .overflow_y_scroll()
            .p_2()
            .gap_1();
        for (slot, label) in entries {
            list = list.child(
                Button::new(SharedString::from(format!("pick-panel-{}", slot.as_str())))
                    .ghost()
                    .small()
                    .w_full()
                    .justify_start()
                    .label(label)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(key) = this.panel_context() {
                            this.web
                                .sessions
                                .entry(key)
                                .or_default()
                                .layout
                                .open(slot.clone());
                        }
                        this.web.picker_open = false;
                        this.web.settings_open = false;
                        cx.notify();
                    })),
            );
        }
        div()
            .id("panel-picker-overlay")
            .absolute()
            .inset_0()
            .bg(p.bg.opacity(0.72))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.web.picker_open = false;
                    cx.notify();
                }),
            )
            .child(
                div()
                    .absolute()
                    .right(px(12.))
                    .top(px(48.))
                    .w(px(280.))
                    .bg(p.popover)
                    .border_1()
                    .border_color(p.border_strong)
                    .rounded_lg()
                    .shadow_lg()
                    .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
                    .child(
                        div()
                            .px_3()
                            .py_2()
                            .text_sm()
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Add a panel"),
                    )
                    .child(list),
            )
            .into_any_element()
    }
}
