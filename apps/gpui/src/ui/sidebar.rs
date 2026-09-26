use super::{
    AppView,
    components::dropdown::Dropdown,
    sidebar_navigation::{append_agent_navigation, append_identity_navigation},
    theme::{self, Appearance, Palette},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        menu::{DropdownMenu, PopupMenuItem},
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let content = self.sidebar_session_sections(cx);
        div()
            .h_flex()
            .h_full()
            .flex_shrink_0()
            .bg(p.sidebar)
            .child(
                div()
                    .v_flex()
                    .w(px(self.sidebar_state.width - 4.))
                    .h_full()
                    .px(px(10.))
                    .child(self.sidebar_agent_picker(cx))
                    .child(
                        div()
                            .id("sidebar-scroll")
                            .track_focus(&self.sidebar_state.list_focus)
                            .key_context("SidebarList")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .when(!self.sidebar_state.preferences.all_agents, |el| {
                                el.child(self.sidebar_home(cx))
                            })
                            .child(self.sidebar_navigation(cx))
                            .child(self.people_section(cx))
                            .when(!self.sidebar_state.preferences.all_agents, |el| {
                                el.child(
                                    div()
                                        .h_flex()
                                        .gap(px(2.))
                                        .pt(px(14.))
                                        .pb(px(4.))
                                        .px(px(8.))
                                        .child(
                                            div()
                                                .flex_1()
                                                .text_size(px(11.))
                                                .font_weight(FontWeight::MEDIUM)
                                                .text_color(p.muted)
                                                .child("Threads"),
                                        )
                                        .when(self.sidebar_state.preferences.filtered(), |el| {
                                            el.child(self.sidebar_filter_summary(cx))
                                        })
                                        .child(self.sidebar_filter_button(cx))
                                        .child(
                                            Button::new("section-new")
                                                .ghost()
                                                .small()
                                                .size(px(26.))
                                                .icon(Icon::new(IconName::Plus).size(px(16.)))
                                                .accessibility_label("New conversation (⇧⌘O)")
                                                .disabled(self.session.is_none())
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.new_chat(window, cx)
                                                })),
                                        ),
                                )
                            })
                            .when(self.sidebar_state.preferences.all_agents, |el| {
                                el.child(
                                    div()
                                        .h_flex()
                                        .justify_end()
                                        .child(self.sidebar_filter_button(cx)),
                                )
                            })
                            .when(!self.sidebar_state.selection.keys.is_empty(), |el| {
                                el.child(self.render_batch_actions(cx))
                            })
                            .child(content)
                            .child(self.sidebar_catalog_sections(cx))
                            .when(self.sidebar_state.has_more, |el| {
                                el.child(
                                    Button::new("sessions-more")
                                        .ghost()
                                        .small()
                                        .w_full()
                                        .mt_2()
                                        .label(if self.roster_loading {
                                            "Loading…"
                                        } else {
                                            "Load more conversations"
                                        })
                                        .disabled(self.roster_loading)
                                        .on_click(
                                            cx.listener(|this, _, _, cx| this.more_sessions(cx)),
                                        ),
                                )
                            })
                            .when_some(self.roster_error.clone(), |el, error| {
                                el.child(div().p_2().text_xs().text_color(p.danger).child(error))
                            }),
                    )
                    .child(self.sidebar_identity(cx)),
            )
            .child(
                div()
                    .id("sidebar-resize")
                    .w(px(4.))
                    .h_full()
                    .cursor_col_resize()
                    .hover(|el| el.bg(p.border))
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| {
                            this.sidebar_state.resizing = true;
                            cx.notify();
                        }),
                    ),
            )
            .into_any_element()
    }

    fn sidebar_home(&self, cx: &mut Context<Self>) -> AnyElement {
        use crate::model::sidebar_activity::SidebarAttention;
        let p = Palette::get(cx);
        let key = self.agent_home();
        let related: Vec<_> = self
            .rows
            .iter()
            .filter(|row| row.key == key || row.navigation_parent(&key, None) == Some(key.as_str()))
            .collect();
        let attention = related
            .iter()
            .map(|row| self.sidebar_attention(row))
            .max_by_key(|attention| match attention {
                SidebarAttention::Question | SidebarAttention::Approval => 3,
                SidebarAttention::Agent => 2,
                SidebarAttention::Error => 1,
                SidebarAttention::None => 0,
            })
            .unwrap_or(SidebarAttention::None);
        let running = related
            .iter()
            .any(|row| !row.archived && row.display_running());
        let unread = related.iter().any(|row| !row.archived && row.unread);
        Button::new("sidebar-home")
            .ghost()
            .small()
            .h(px(30.))
            .w_full()
            .justify_start()
            .px(px(8.))
            .gap(px(8.))
            .icon(
                Icon::new(match attention {
                    SidebarAttention::Question | SidebarAttention::Approval => IconName::Hand,
                    SidebarAttention::Error => IconName::TriangleAlert,
                    _ if running => IconName::LoaderCircle,
                    _ => IconName::House,
                })
                .size(px(16.)),
            )
            .child(div().flex_1().child("Home"))
            .when(unread, |el| {
                el.child(div().size(px(6.)).rounded_full().bg(p.accent))
            })
            .when(
                !self.web.settings_open && self.chat.selected_session.as_ref() == Some(&key),
                |el| el.bg(p.hover),
            )
            .on_click(
                cx.listener(move |this, _, window, cx| {
                    this.select_session(key.clone(), window, cx)
                }),
            )
            .into_any_element()
    }

    fn sidebar_agent_picker(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let agents = self.sidebar_state.agents.clone();
        let selected = self.sidebar_state.selected_agent.clone();
        let roster = self.sidebar_state.preferences.all_agents;
        let view = cx.entity().downgrade();
        let other_unread = self
            .sidebar_state
            .agent_activity
            .iter()
            .chain(self.rows.iter())
            .any(|row| row.unread && !row.archived && row.agent() != selected.as_deref());
        let avatar = self
            .sidebar_state
            .agents
            .iter()
            .find(|agent| Some(&agent.id) == selected.as_ref())
            .map(|agent| self.render_agent_avatar(agent, 32., cx));
        Button::new("agent-picker")
            .ghost()
            .w_full()
            .h(px(48.))
            .px(px(8.))
            .justify_start()
            .gap(px(8.))
            .child(
                div()
                    .relative()
                    .size(px(32.))
                    .flex_shrink_0()
                    .child(if roster {
                        div()
                            .size_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_size(px(24.))
                            .child("🦞")
                            .into_any_element()
                    } else {
                        avatar.unwrap_or_else(|| div().child("◈").into_any_element())
                    })
                    .when(other_unread, |el| {
                        el.child(
                            div()
                                .absolute()
                                .right(px(0.))
                                .top(px(0.))
                                .size(px(7.))
                                .rounded_full()
                                .bg(p.accent),
                        )
                    }),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_size(px(15.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(if roster {
                        self.profile
                            .as_ref()
                            .map(|profile| profile.name.clone())
                            .unwrap_or_else(|| "OpenClaw".into())
                    } else {
                        self.selected_agent_name()
                    }),
            )
            .child(
                Icon::new(IconName::ChevronsUpDown)
                    .size(px(14.))
                    .text_color(p.muted),
            )
            .accessibility_label("Select agent")
            .dropdown_menu(move |mut menu, _, _| {
                let all_view = view.clone();
                menu = menu
                    .item(
                        PopupMenuItem::new("All Agents")
                            .icon(IconName::UsersRound)
                            .checked(roster)
                            .on_click(move |_, _, cx| {
                                let _ = all_view.update(cx, |this, cx| {
                                    this.change_sidebar_preferences(
                                        |prefs| prefs.all_agents = !roster,
                                        cx,
                                    )
                                });
                            }),
                    )
                    .separator();
                for agent in &agents {
                    let view = view.clone();
                    let avatar_view = view.clone();
                    let option = agent.clone();
                    let id = agent.id.clone();
                    menu = menu.item(
                        PopupMenuItem::element(move |_, cx| {
                            let avatar = avatar_view.upgrade().map(|entity| {
                                entity.read(cx).render_agent_avatar(&option, 24., cx)
                            });
                            div()
                                .h_flex()
                                .gap(px(8.))
                                .py(px(2.))
                                .when_some(avatar, |this, avatar| this.child(avatar))
                                .child(option.name().to_owned())
                        })
                        .checked(!roster && selected.as_ref() == Some(&id))
                        .on_click(move |_, window, cx| {
                            let _ = view.update(cx, |this, cx| {
                                this.sidebar_state.preferences.all_agents = false;
                                this.persist_sidebar_preferences(cx);
                                this.switch_agent(id.clone(), window, cx);
                            });
                        }),
                    );
                }
                append_agent_navigation(menu, view.clone())
            })
            .into_any_element()
    }

    fn sidebar_identity(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let view = cx.entity().downgrade();
        let appearance = theme::appearance(cx);
        let name = self
            .sidebar_state
            .people
            .self_user
            .as_ref()
            .and_then(|person| person.name.clone().or(person.email.clone()))
            .or_else(|| self.access_identity.clone())
            .unwrap_or_else(|| "Gateway user".into());
        let status = if self.session.is_some() {
            self.profile
                .as_ref()
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "Connected".into())
        } else if let Some(next) = self.sidebar_state.reconnect_at {
            format!(
                "Reconnecting in {}s",
                next.saturating_duration_since(std::time::Instant::now())
                    .as_secs()
                    + 1
            )
        } else if self.connecting {
            "Connecting…".into()
        } else {
            "Offline".into()
        };
        let avatar = self
            .sidebar_state
            .people
            .self_user
            .as_ref()
            .map(|person| self.render_person_avatar(person, 28., cx))
            .unwrap_or_else(|| {
                div()
                    .size(px(28.))
                    .rounded_full()
                    .bg(p.elevated)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(Icon::new(IconName::UserRound).size(px(16.)))
                    .into_any_element()
            });
        div()
            .h_flex()
            .h(px(57.))
            .gap(px(4.))
            .child(Dropdown::new(
                "identity-menu-dropdown",
                Anchor::TopLeft,
                Button::new("identity-menu")
                    .ghost()
                    .flex_1()
                    .min_w_0()
                    .h(px(48.))
                    .justify_start()
                    .px(px(6.))
                    .gap(px(8.))
                    .child(avatar)
                    .child(
                        div()
                            .v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(px(2.))
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(name.clone()),
                            )
                            .child(
                                div()
                                    .h_flex()
                                    .gap(px(5.))
                                    .child(div().size(px(5.)).rounded_full().bg(
                                        if self.session.is_some() {
                                            p.ok
                                        } else {
                                            p.danger
                                        },
                                    ))
                                    .child(
                                        div()
                                            .truncate()
                                            .text_size(px(11.))
                                            .text_color(p.muted)
                                            .child(status),
                                    ),
                            ),
                    )
                    .child(
                        Icon::new(IconName::ChevronsUpDown)
                            .size(px(13.))
                            .text_color(p.muted),
                    )
                    .accessibility_label("Profile and settings"),
                move |menu, window, cx| {
                    let mut menu =
                        append_identity_navigation(menu.label(name.clone()), view.clone());
                    menu = menu.separator().submenu(
                        "Appearance",
                        window,
                        cx,
                        move |mut menu, _, _| {
                            for (label, mode) in [
                                ("System", Appearance::System),
                                ("Light", Appearance::Light),
                                ("Dark", Appearance::Dark),
                            ] {
                                menu = menu.item(
                                    PopupMenuItem::new(label)
                                        .checked(mode == appearance)
                                        .on_click(move |_, window, cx| {
                                            theme::set_appearance(mode, window, cx)
                                        }),
                                );
                            }
                            menu
                        },
                    );
                    let retry = view.clone();
                    menu = menu.item(PopupMenuItem::new("Reconnect").on_click(
                        move |_, window, cx| {
                            let _ = retry.update(cx, |this, cx| this.retry(window, cx));
                        },
                    ));
                    let switch = view.clone();
                    menu = menu.item(PopupMenuItem::new("Switch Gateway…").on_click(
                        move |_, window, cx| {
                            let _ = switch.update(cx, |this, cx| this.switch_gateway(window, cx));
                        },
                    ));
                    let signout = view.clone();
                    menu.item(
                        PopupMenuItem::new("Sign out").on_click(move |_, window, cx| {
                            let _ = signout.update(cx, |this, cx| this.sign_out(window, cx));
                        }),
                    )
                },
            ))
            .child(self.gateway_menu(cx))
            .into_any_element()
    }
}
