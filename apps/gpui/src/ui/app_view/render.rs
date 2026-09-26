use super::*;

impl Render for AppView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_model_controls();
        if window.focused(cx).is_none() {
            self.focus_handle.focus(window, cx);
        }
        let now = crate::model::chat::now_ms();
        self.sidebar_state.status_expiry = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .filter_map(|row| row.agent_status.as_ref())
            .map(|status| status.expires_at)
            .filter(|expiry| *expiry > now)
            .min();
        self.apply_sidebar_pending(window, cx);
        if let Some(key) = self.new_session.pending_open.take() {
            self.composer
                .update(cx, |input, cx| input.set_value("", window, cx));
            self.select_session(key, window, cx);
        }
        if self.new_session.inputs_dirty {
            self.sync_draft_inputs(window, cx);
        }
        self.composer_restore_if_pending(window, cx);
        self.sync_web_surfaces(window, cx);
        self.sync_viewer_presence(cx);
        let p = Palette::get(cx);
        let body = if self.show_connect_form
            || (self.session.is_none() && self.chat.selected_session.is_none())
        {
            self.connect_screen(cx).into_any_element()
        } else if self.web.settings_open {
            self.settings_body()
        } else if self.new_session.active {
            self.new_session_view(window, cx)
        } else {
            let attention = self.attention_dock(window, cx);
            div()
                .v_flex()
                .flex_1()
                .min_w_0()
                .h_full()
                .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                    this.attach_paths(paths.paths().to_vec(), cx)
                }))
                .child(self.transcript(cx))
                .child(attention)
                .child(self.composer_view(window, cx))
                .into_any_element()
        };
        div()
            .id("openclaw-app")
            .role(Role::Group)
            .aria_label("OpenClaw")
            .track_focus(&self.focus_handle)
            .size_full()
            .v_flex()
            .relative()
            .bg(p.bg)
            .child(crate::ui::components::transcript_background::transcript_background(cx))
            .text_color(p.text)
            .text_size(text::BODY.size)
            .on_action(cx.listener(|this, _: &crate::Refresh, _, cx| this.manual_refresh(cx)))
            .on_action(cx.listener(|this, _: &crate::FocusComposer, window, cx| {
                this.composer
                    .update(cx, |state, cx| state.focus(window, cx))
            }))
            .on_action(
                cx.listener(|this, _: &crate::NewChat, window, cx| this.new_chat(window, cx)),
            )
            .on_action(cx.listener(|this, _: &crate::SearchSessions, window, cx| {
                this.open_palette(window, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::ToggleSidebar, _, cx| this.toggle_sidebar(cx)))
            .on_action(cx.listener(|this, _: &crate::PreviousSession, window, cx| {
                this.navigate_session(-1, window, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::NextSession, window, cx| {
                this.navigate_session(1, window, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::Escape, window, cx| this.escape(window, cx)))
            .on_action(cx.listener(|this, _: &crate::OpenSettings, window, cx| {
                this.open_settings(window, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::TogglePanels, _, cx| this.toggle_dock(cx)))
            .on_action(cx.listener(|this, _: &crate::PanelBrowser, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Browser, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelTerminal, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Terminal, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelWorkspace, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Workspace, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelCompanion, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Companion, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelTasks, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Tasks, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelDesktop, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Desktop, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelDiscussion, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Discussion, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelDashboard, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Dashboard, cx)
            }))
            .on_action(cx.listener(|this, _: &crate::PanelDetail, _, cx| {
                this.toggle_panel(crate::model::panels::PanelSlot::Detail, cx)
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, _, window, cx| this.focus_gpui_chrome(window, cx)),
            )
            .on_action(cx.listener(|_, _: &crate::CloseWindow, window, _| window.remove_window()))
            .on_action(
                cx.listener(|_, _: &crate::MinimizeWindow, window, _| window.minimize_window()),
            )
            .on_mouse_move(cx.listener(|this, event: &MouseMoveEvent, window, cx| {
                if this.sidebar_state.resizing {
                    this.sidebar_state.width = f32::from(event.position.x).clamp(
                        f32::from(theme::tokens::sidebar::MIN_WIDTH),
                        f32::from(theme::tokens::sidebar::MAX_WIDTH),
                    );
                    cx.notify();
                }
                if this.web.resizing {
                    let width = f32::from(window.viewport_size().width - event.position.x);
                    if let Some(dock) = this
                        .panel_context()
                        .and_then(|key| this.web.sessions.get_mut(&key))
                    {
                        dock.layout.resize(width);
                    }
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _, _, cx| {
                    this.sidebar_state.resizing = false;
                    this.web.resizing = false;
                    cx.notify();
                }),
            )
            .child(
                TitleBar::new()
                    .h(theme::tokens::header::WINDOW_HEIGHT)
                    .bg(p.sidebar)
                    .border_b_0()
                    .child(if self.show_connect_form {
                        div().w(shell::TITLEBAR_RESERVED_WIDTH).into_any_element()
                    } else {
                        div()
                            .h_flex()
                            .h_full()
                            .w(if self.sidebar_state.collapsed {
                                shell::TITLEBAR_COLLAPSED_WIDTH
                            } else {
                                px(self.sidebar_state.width) - shell::TITLEBAR_RESERVED_WIDTH
                            })
                            .flex_shrink_0()
                            .justify_end()
                            .pr(space::LG)
                            .bg(p.sidebar)
                            .child(
                                Button::new("title-sidebar-toggle")
                                    .ghost()
                                    .small()
                                    .size(shell::CHROME_BUTTON_SIZE)
                                    .icon(Icon::new(IconName::PanelLeft).size(icon::NORMAL))
                                    .accessibility_label("Toggle sidebar")
                                    .on_click(
                                        cx.listener(|this, _, _, cx| this.toggle_sidebar(cx)),
                                    ),
                            )
                            .child(
                                Button::new("title-search")
                                    .ghost()
                                    .small()
                                    .size(shell::CHROME_BUTTON_SIZE)
                                    .icon(Icon::new(IconName::Search).size(icon::NORMAL))
                                    .accessibility_label("Search conversations (⌘K)")
                                    .on_click(cx.listener(|this, _, window, cx| {
                                        this.open_palette(window, cx)
                                    })),
                            )
                            .child(
                                Button::new("title-new-chat")
                                    .ghost()
                                    .small()
                                    .size(shell::CHROME_BUTTON_SIZE)
                                    .icon(Icon::new(IconName::Plus).size(icon::NORMAL))
                                    .accessibility_label("New chat (⌘N)")
                                    .disabled(self.session.is_none())
                                    .on_click(
                                        cx.listener(|this, _, window, cx| {
                                            this.new_chat(window, cx)
                                        }),
                                    ),
                            )
                            .into_any_element()
                    })
                    .child(if self.show_connect_form {
                        div()
                            .text_size(text::WIDGET_SM_SIZE)
                            .text_color(p.muted)
                            .child(
                                self.profile
                                    .as_ref()
                                    .map_or("OpenClaw", |p| p.name.as_str())
                                    .to_owned(),
                            )
                            .into_any_element()
                    } else {
                        self.chat_header(cx)
                    }),
            )
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .when(
                        !self.show_connect_form && !self.sidebar_state.collapsed,
                        |d| d.child(self.sidebar(window, cx)),
                    )
                    .when(
                        !self
                            .current_dock()
                            .is_some_and(|dock| dock.layout.open && dock.layout.expanded)
                            || self.web.settings_open
                            || self.new_session.active
                            || self.show_connect_form,
                        |el| el.child(body),
                    )
                    .when(
                        !self.web.settings_open
                            && !self.show_connect_form
                            && !self.new_session.active,
                        |el| el.child(self.panel_dock(window, cx)),
                    ),
            )
            .when(!self.show_connect_form, |el| {
                el.children(self.warm_web_elements()).children(
                    self.current_dock()
                        .and_then(|dock| dock.catalog.as_ref())
                        .map(|surface| {
                            div()
                                .absolute()
                                .left(px(0.))
                                .top(px(0.))
                                .size(space::HAIRLINE)
                                .child(surface.element())
                        }),
                )
            })
            .when(self.web.picker_open, |el| el.child(self.panel_picker(cx)))
            .when_some(self.web.error.clone(), |el, error| {
                el.child(
                    div()
                        .absolute()
                        .bottom(space::XL)
                        .right(space::XL)
                        .max_w(shell::TOAST_MAX_WIDTH)
                        .p(space::REM_MD)
                        .rounded(radius::WIDGET_MD)
                        .bg(p.card)
                        .border(space::HAIRLINE)
                        .border_color(p.danger)
                        .text_color(p.danger)
                        .child(error)
                        .child(
                            Button::new("dismiss-web-error")
                                .ghost()
                                .small()
                                .label("Dismiss")
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.web.error = None;
                                    cx.notify();
                                })),
                        ),
                )
            })
            .when(self.sidebar_state.palette_open, |d| {
                d.child(self.palette_overlay(cx))
            })
            .children(Root::render_dialog_layer(window, cx))
            .children(Root::render_notification_layer(window, cx))
    }
}
