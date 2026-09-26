use super::{
    AppView,
    components::{
        icon_button::icon_button,
        icons::icon as ui_icon,
        menu_surface::{MenuSurfaceSpec, menu_surface},
    },
    sidebar_navigation::append_identity_navigation,
    theme::{
        Palette,
        tokens::{
            TypographyExt, avatar, colors, header, icon, icon_button as controls, menu, opacity,
            radius, sidebar as layout, space, text,
        },
    },
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Selectable, Sizable, StyledExt, Theme,
        button::{Button, ButtonCustomVariant, ButtonVariants},
        menu::{DropdownMenu, PopupMenuItem},
        spinner::Spinner,
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn sidebar(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::sidebar(cx);
        let pages_focus = window
            .use_keyed_state("sidebar-pages-focus", cx, |_, cx| cx.focus_handle())
            .read(cx)
            .clone();
        let pages_focused = pages_focus.contains_focused(window, cx);
        let content = self.sidebar_session_sections(cx);
        div()
            .h_flex()
            .h_full()
            .flex_shrink_0()
            .bg(p.sidebar)
            .child(
                div()
                    .v_flex()
                    .w(px(self.sidebar_state.width) - layout::DIVIDER)
                    .h_full()
                    .px(layout::PADDING)
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .child(self.sidebar_agent_picker(window, cx))
                            .when(self.sidebar_state.preferences.all_agents, |el| {
                                el.child(div().flex_1())
                                    .child(self.sidebar_filter_button(cx))
                            }),
                    )
                    .child(
                        div()
                            .id("sidebar-scroll")
                            .track_focus(&self.sidebar_state.list_focus)
                            .key_context("SidebarList")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .child(
                                div()
                                    .relative()
                                    .group("sidebar-pages")
                                    .mx(space::XXS)
                                    .track_focus(&pages_focus)
                                    .v_flex()
                                    .gap(space::XXS)
                                    .when(!self.sidebar_state.preferences.all_agents, |el| {
                                        el.child(self.sidebar_home(cx))
                                    })
                                    .child(self.sidebar_navigation(cx))
                                    .child(self.sidebar_pinned_navigation(cx))
                                    .child(self.sidebar_more_button(pages_focused, cx)),
                            )
                            .child(self.people_section(cx))
                            .when(!self.sidebar_state.preferences.all_agents, |el| {
                                el.child(
                                    div()
                                        .h_flex()
                                        .gap(space::XXS)
                                        .mt(icon::NORMAL)
                                        .min_h(header::SECTION_HEIGHT)
                                        .pl(layout::THREADS_INDENT)
                                        .pr(space::LG)
                                        .child(
                                            div()
                                                .flex_1()
                                                .typography(text::CATEGORY)
                                                .text_color(p.muted)
                                                .child("SESSIONS"),
                                        )
                                        .when(self.sidebar_state.preferences.filtered(), |el| {
                                            el.child(self.sidebar_filter_summary(cx))
                                        })
                                        .child(self.sidebar_filter_button(cx))
                                        .child(
                                            Button::new("section-new")
                                                .ghost()
                                                .small()
                                                .size(icon::RUN_RING)
                                                .icon(Icon::new(IconName::Plus).size(icon::ACTION))
                                                .accessibility_label("New conversation (⇧⌘O)")
                                                .disabled(self.session.is_none())
                                                .on_click(cx.listener(|this, _, window, cx| {
                                                    this.new_chat(window, cx)
                                                })),
                                        ),
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
                    .relative()
                    .w(space::HAIRLINE)
                    .child(
                        div()
                            .absolute()
                            .left(layout::RESIZE_HIT_OFFSET)
                            .w(layout::RESIZE_HIT_WIDTH)
                            .h_full(),
                    )
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
        let p = Palette::sidebar(cx);
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
        let active = !self.web.settings_open && self.chat.selected_session.as_ref() == Some(&key);
        let unread = !active && related.iter().any(|row| !row.archived && row.unread);
        let icon = match attention {
            SidebarAttention::Question | SidebarAttention::Approval => IconName::Hand,
            SidebarAttention::Error => IconName::TriangleAlert,
            _ => IconName::House,
        };
        Button::new("sidebar-home")
            .custom(
                ButtonCustomVariant::new(cx)
                    .foreground(p.muted)
                    .hover(colors::navigation_hover(p))
                    .active(colors::navigation_hover(p)),
            )
            .group("nav-home")
            .h(controls::FOOTER.size)
            .w_full()
            .px(space::MD)
            .py_0()
            .border_1()
            .border_color(transparent_black())
            .rounded(radius::ROW)
            .child(
                div()
                    .h_flex()
                    .w_full()
                    .gap(space::MD)
                    .typography(text::NAV)
                    .text_color(if active { p.strong } else { p.muted })
                    .when(!active, |el| {
                        el.group_hover("nav-home", |style| style.text_color(p.text))
                    })
                    .child(
                        div()
                            .relative()
                            .w(icon::LEADING)
                            .h(icon::RUN_RING)
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(
                                div()
                                    .opacity(if active {
                                        opacity::VISIBLE
                                    } else {
                                        opacity::NAV_ICON
                                    })
                                    .group_hover("nav-home", |style| {
                                        style.opacity(opacity::VISIBLE)
                                    })
                                    .child(ui_icon(icon, icon::NORMAL).text_color(if active {
                                        p.accent
                                    } else {
                                        p.muted
                                    })),
                            )
                            .when(running, |el| {
                                el.child(
                                    div().absolute().left(-space::HAIRLINE).top_0().child(
                                        Spinner::new()
                                            .icon(IconName::LoaderCircle)
                                            .with_size(icon::RUN_RING)
                                            .color(p.muted),
                                    ),
                                )
                            })
                            .when(unread && !running, |el| {
                                el.child(
                                    div()
                                        .absolute()
                                        .right(-space::HAIRLINE)
                                        .top_0()
                                        .size(space::SM)
                                        .rounded_full()
                                        .bg(p.accent),
                                )
                            }),
                    )
                    .child(div().flex_1().min_w_0().truncate().child("Home")),
            )
            .accessibility_label("Home")
            .selected(active)
            .when(active, |el| {
                el.bg(colors::navigation_active(p, Theme::global(cx).is_dark()))
                    .border_color(colors::selected_border(p))
            })
            .on_click(
                cx.listener(move |this, _, window, cx| {
                    this.select_session(key.clone(), window, cx)
                }),
            )
            .into_any_element()
    }

    fn sidebar_identity(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::sidebar(cx);
        let view = cx.entity().downgrade();
        let name = self
            .sidebar_state
            .people
            .self_user
            .as_ref()
            .and_then(|person| person.name.clone().or(person.email.clone()))
            .or_else(|| self.access_identity.clone())
            .unwrap_or_else(|| "Owner".into());
        let status = if self.session.is_some() {
            self.profile.as_ref().map(|profile| profile.name.clone())
        } else {
            Some(if self.connecting {
                "Connecting…".into()
            } else {
                "Offline".into()
            })
        };
        let avatar = self
            .sidebar_state
            .people
            .self_user
            .as_ref()
            .map(|person| self.render_person_avatar(person, avatar::IDENTITY, cx))
            .unwrap_or_else(|| {
                div()
                    .size(avatar::IDENTITY.diameter)
                    .rounded_full()
                    .bg(p.elevated)
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(Icon::new(IconName::UserRound).size(icon::NORMAL))
                    .into_any_element()
            });
        let pending: Vec<_> = self
            .rows
            .iter()
            .filter(|row| {
                matches!(
                    self.sidebar_attention(row),
                    crate::model::sidebar_activity::SidebarAttention::Question
                        | crate::model::sidebar_activity::SidebarAttention::Approval
                        | crate::model::sidebar_activity::SidebarAttention::Agent
                )
            })
            .cloned()
            .collect();
        let attention_view = view.clone();
        let trigger = Button::new("identity-menu")
            .ghost()
            .flex_1()
            .min_w_0()
            .h(layout::IDENTITY_TRIGGER_HEIGHT)
            .rounded(radius::PERSON)
            .px(space::SM)
            .child(
                div().w_full().h_flex().gap(space::MD).child(avatar).child(
                    div()
                        .v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .truncate()
                                .typography(text::IDENTITY)
                                .text_color(p.strong)
                                .child(name),
                        )
                        .when_some(status, |el, status| {
                            el.child(
                                div()
                                    .typography(text::FOOTER_STATUS)
                                    .text_color(p.muted)
                                    .child(status),
                            )
                        }),
                ),
            )
            .accessibility_label("Profile and settings");
        let identity_menu = menu_surface(
            "sidebar-identity-popup",
            trigger,
            MenuSurfaceSpec::above(menu::IDENTITY)
                .horizontal_offset(menu::IDENTITY_HORIZONTAL_OFFSET)
                .outer_ring(),
            move |menu, window, cx| append_identity_navigation(menu, view.clone(), window, cx),
        );
        div()
            .h_flex()
            .h(layout::FOOTER_HEIGHT)
            .mb(space::XS)
            .pl(space::MD)
            .gap(space::XS)
            .child(identity_menu)
            .child(
                icon_button("footer-home", IconName::House, "Home", controls::FOOTER, cx).on_click(
                    cx.listener(|this, _, window, cx| {
                        this.select_session(this.agent_home(), window, cx)
                    }),
                ),
            )
            .child(
                icon_button(
                    "footer-attention",
                    IconName::Inbox,
                    "Attention",
                    controls::FOOTER,
                    cx,
                )
                .dropdown_menu(move |mut menu, _, _| {
                    if pending.is_empty() {
                        return menu.label("You're all caught up");
                    }
                    for row in &pending {
                        let row = row.clone();
                        let view = attention_view.clone();
                        menu = menu.item(PopupMenuItem::new(row.title()).on_click(
                            move |_, window, cx| {
                                let _ = view.update(cx, |this, cx| {
                                    this.select_session(row.key.clone(), window, cx)
                                });
                            },
                        ));
                    }
                    menu
                }),
            )
            .into_any_element()
    }
}
