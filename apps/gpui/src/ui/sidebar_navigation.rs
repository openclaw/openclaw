use super::{
    AppView,
    components::{
        icon_button::icon_button,
        icons::icon as ui_icon,
        menu_surface::{MenuSurfaceSpec, menu_surface},
    },
    theme::{
        Palette,
        tokens::{
            IconButtonMetrics, InsetsExt, TypographyExt, colors, icon, icon_button as buttons,
            menu, opacity, row, sidebar, space, text,
        },
    },
    web_state::WebUi,
};
use crate::model::web_urls::{self, ControlUiTab, SIDEBAR_ROUTES};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Selectable, StyledExt, Theme,
        button::{Button, ButtonCustomVariant, ButtonVariants},
        menu::PopupMenuItem,
    },
    prelude::FluentBuilder,
    *,
};
use serde::Deserialize;
use serde_json::json;

#[path = "sidebar_identity_menu.rs"]
mod identity_menu;
pub(super) use identity_menu::append_identity_navigation;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ControlTabs {
    #[serde(default)]
    control_ui_tabs: Vec<ControlUiTab>,
}

impl WebUi {
    pub fn page_title(&self) -> &str {
        &self.page_label
    }
}

impl AppView {
    pub(super) fn sync_control_navigation(&mut self) {
        if self.web.control_tabs_epoch == Some(self.epoch) {
            return;
        }
        let Some(session) = &self.session else {
            return;
        };
        self.web.control_tabs = serde_json::from_value::<ControlTabs>(session.hello().clone())
            .map(|snapshot| snapshot.control_ui_tabs)
            .unwrap_or_default();
        self.web.control_tabs_epoch = Some(self.epoch);
        self.web.control_tabs_request += 1;
    }

    pub(super) fn refresh_control_tabs(&mut self, cx: &mut Context<Self>) {
        self.sync_control_navigation();
        self.web.control_tabs_request += 1;
        let request = self.web.control_tabs_request;
        self.request(
            "plugins.uiDescriptors",
            json!({}),
            cx,
            move |this, result, _| {
                if this.web.control_tabs_request != request {
                    return;
                }
                match result.and_then(|value| {
                    serde_json::from_value::<ControlTabs>(value).map_err(|error| error.to_string())
                }) {
                    Ok(snapshot) => this.web.control_tabs = snapshot.control_ui_tabs,
                    Err(error) => {
                        this.web.error =
                            Some(format!("Could not refresh plugin navigation: {error}"))
                    }
                }
            },
        );
    }

    pub(super) fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open_control_page("/settings/appearance", "Appearance", window, cx);
    }

    pub(super) fn open_control_page(
        &mut self,
        path: &str,
        title: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.session.is_none() {
            self.web.error = Some("Reconnect to open the Gateway's Control UI.".into());
            cx.notify();
            return;
        }
        let Some(auth) = &self.web.auth else {
            self.web.error =
                Some("The Gateway's web connection is not ready. Reconnect and try again.".into());
            cx.notify();
            return;
        };
        let result = web_urls::control_page_url(&auth.gateway_url, path).and_then(|url| {
            if let Some(surface) = &self.web.settings {
                surface.navigate(&url)?;
            }
            Ok(())
        });
        if let Err(error) = result {
            self.web.error = Some(error);
            cx.notify();
            return;
        }
        self.web.page_path = path.into();
        self.web.page_label = title.into();
        self.web.settings_open = true;
        self.web.picker_open = false;
        self.composer_state.close_popups();
        self.focus_handle.focus(window, cx);
        cx.notify();
    }

    pub(super) fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.web.settings_open = false;
        if let Some(surface) = &self.web.settings {
            surface.set_present(false);
            surface.focus_parent();
        }
        self.composer
            .update(cx, |input, cx| input.focus(window, cx));
        cx.notify();
    }

    pub(super) fn record_control_navigation(&mut self, url: &str) {
        let Some(path) = self
            .web
            .auth
            .as_ref()
            .and_then(|auth| web_urls::control_page_path(&auth.gateway_url, url))
        else {
            return;
        };
        if let Some(tab) = self
            .web
            .control_tabs
            .iter()
            .find(|tab| tab.is_active(&path))
        {
            self.web.page_label = tab.label.clone();
        } else if let Some(route) = web_urls::sidebar_route_for_path(&path) {
            self.web.page_label = route.title.into();
        } else if let Some(title) = settings_title(&path) {
            self.web.page_label = title.into();
        }
        self.web.page_path = path;
    }

    pub(super) fn sidebar_navigation(&self, cx: &mut Context<Self>) -> AnyElement {
        let entries = &self.sidebar_state.preferences.sidebar_entries;
        let active = self
            .web
            .settings_open
            .then(|| web_urls::sidebar_route_for_path(&self.web.page_path).map(|route| route.id))
            .flatten();
        let mut content = div().id("sidebar-navigation").v_flex().gap(row::GAP);
        for entry in entries {
            let Some(route) = SIDEBAR_ROUTES
                .iter()
                .find(|route| entry == &format!("route:{}", route.id))
            else {
                continue;
            };
            let route = *route;
            content = content.child(
                div()
                    .h_flex()
                    .child(
                        self.navigation_row(
                            route.id,
                            route.title,
                            route_icon(route.id),
                            active == Some(route.id),
                            cx,
                        )
                        .on_click(cx.listener(
                            move |this, _, window, cx| {
                                this.open_control_page(route.path, route.title, window, cx);
                            },
                        )),
                    )
                    .child(div().w(sidebar::REORDER_WIDTH).flex_shrink_0()),
            );
        }
        for group in ["chat", "control", "agent", "settings"] {
            for tab in self.web.control_tabs.iter().filter(|tab| {
                tab.group.as_deref().unwrap_or("control") == group
                    && !tab
                        .placement
                        .as_ref()
                        .is_some_and(|placement| entries.contains(placement))
            }) {
                let path = tab.path();
                let title = tab.label.clone();
                content = content.child(
                    div()
                        .h_flex()
                        .child(
                            self.navigation_row(
                                &format!("plugin:{}", tab.key()),
                                &tab.label,
                                plugin_icon(tab.icon.as_deref()),
                                self.web.settings_open && tab.is_active(&self.web.page_path),
                                cx,
                            )
                            .on_click(cx.listener(
                                move |this, _, window, cx| {
                                    this.open_control_page(&path, &title, window, cx);
                                },
                            )),
                        )
                        .child(div().w(sidebar::REORDER_WIDTH).flex_shrink_0()),
                );
            }
        }
        content.into_any_element()
    }

    pub(super) fn sidebar_more_button(
        &self,
        pages_focused: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let entries = &self.sidebar_state.preferences.sidebar_entries;
        let active = self
            .web
            .settings_open
            .then(|| web_urls::sidebar_route_for_path(&self.web.page_path).map(|route| route.id))
            .flatten();
        let entries = entries.clone();
        let view = cx.entity().downgrade();
        let trigger = icon_button(
            "sidebar-more",
            IconName::PenLine,
            "Edit pinned items",
            IconButtonMetrics {
                icon: icon::COMPACT,
                ..buttons::COMPACT
            },
            cx,
        )
        .disabled(self.session.is_none());
        let trigger = menu_surface(
            "sidebar-more-popup",
            trigger,
            MenuSurfaceSpec::below(menu::STANDARD),
            move |mut menu, window, cx| {
                for route in SIDEBAR_ROUTES {
                    if !entries.contains(&format!("route:{}", route.id)) {
                        menu = menu.item(navigation_menu_item(
                            route.title,
                            route.path,
                            route_icon(route.id),
                            active == Some(route.id),
                            view.clone(),
                        ));
                    }
                }
                let entries = entries.clone();
                let customize_view = view.clone();
                menu.separator()
                    .submenu("Edit pinned items", window, cx, move |mut menu, _, _| {
                        menu = menu
                            .min_w(menu::STANDARD.width)
                            .max_w(menu::MAX_STANDARD_WIDTH)
                            .max_h(menu::STANDARD.max_height)
                            .scrollable(true);
                        for route in SIDEBAR_ROUTES {
                            let entry = format!("route:{}", route.id);
                            let checked = entries.contains(&entry);
                            let view = customize_view.clone();
                            menu = menu.item(
                                PopupMenuItem::new(route.title).checked(checked).on_click(
                                    move |_, _, cx| {
                                        let _ = view.update(cx, |this, cx| {
                                            this.change_sidebar_preferences(
                                                |prefs| {
                                                    if prefs.sidebar_entries.contains(&entry) {
                                                        prefs.sidebar_entries.retain(|candidate| {
                                                            candidate != &entry
                                                        });
                                                    } else {
                                                        prefs.sidebar_entries.push(entry.clone());
                                                    }
                                                },
                                                cx,
                                            );
                                        });
                                    },
                                ),
                            );
                        }
                        let view = customize_view.clone();
                        menu.separator()
                            .item(PopupMenuItem::new("Reset to default").on_click(
                                move |_, _, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        this.change_sidebar_preferences(
                                            |prefs| {
                                                let sessions: Vec<_> = prefs
                                                    .sidebar_entries
                                                    .iter()
                                                    .filter(|entry| entry.starts_with("session:"))
                                                    .cloned()
                                                    .collect();
                                                prefs.sidebar_entries =
                                                crate::model::sidebar::SidebarPreferences::default(
                                                )
                                                .sidebar_entries;
                                                prefs.sidebar_entries.extend(sessions);
                                            },
                                            cx,
                                        );
                                    });
                                },
                            ))
                    })
            },
        );
        div()
            .absolute()
            .top(sidebar::MORE_TOP)
            .right(sidebar::MORE_RIGHT)
            .size(buttons::COMPACT.size)
            .opacity(if pages_focused {
                opacity::VISIBLE
            } else {
                opacity::HIDDEN
            })
            .group_hover("sidebar-pages", |style| style.opacity(opacity::VISIBLE))
            .child(trigger)
            .into_any_element()
    }

    fn navigation_row(
        &self,
        id: &str,
        title: &str,
        icon: IconName,
        active: bool,
        cx: &Context<Self>,
    ) -> Button {
        let p = Palette::sidebar(cx);
        let group = SharedString::from(format!("nav-hover:{id}"));
        Button::new(SharedString::from(format!("nav-{id}")))
            .custom(
                ButtonCustomVariant::new(cx)
                    .foreground(p.muted)
                    .hover(colors::navigation_hover(p))
                    .active(colors::navigation_hover(p)),
            )
            .group(group.clone())
            .flex_1()
            .min_w_0()
            .h(row::NAV.min_height)
            .insets(row::NAV.padding)
            .border(space::HAIRLINE)
            .border_color(transparent_black())
            .rounded(row::NAV.radius)
            .child(
                div()
                    .w_full()
                    .h_flex()
                    .gap(row::NAV.gap)
                    .typography(text::NAV)
                    .text_color(if active { p.strong } else { p.muted })
                    .when(!active, |el| {
                        el.group_hover(group.clone(), |style| style.text_color(p.text))
                    })
                    .child(
                        div()
                            .w(row::NAV.leading_width)
                            .h(icon::NORMAL)
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .opacity(if active {
                                opacity::VISIBLE
                            } else {
                                opacity::NAV_ICON
                            })
                            .text_color(if active { p.accent } else { p.muted })
                            .group_hover(group.clone(), |style| style.opacity(opacity::VISIBLE))
                            .when(!active, |el| {
                                el.group_hover(group, |style| {
                                    style.opacity(opacity::VISIBLE).text_color(p.text)
                                })
                            })
                            .child(ui_icon(icon, icon::NORMAL)),
                    )
                    .child(div().flex_1().min_w_0().truncate().child(title.to_owned())),
            )
            .accessibility_label(format!(
                "{title}{}",
                if active { ", current page" } else { "" }
            ))
            .disabled(self.session.is_none())
            .selected(active)
            .when(active, |button| {
                button
                    .bg(colors::navigation_active(p, Theme::global(cx).is_dark()))
                    .border_color(colors::selected_border(p))
            })
    }
}

fn settings_title(path: &str) -> Option<&'static str> {
    match path.split(['?', '#']).next()? {
        "/settings" => Some("Settings"),
        "/settings/profile" => Some("Profile"),
        "/settings/appearance" => Some("Appearance"),
        "/settings/devices" => Some("Devices"),
        "/settings/about" => Some("About OpenClaw"),
        "/debug" => Some("Debug"),
        "/custodian" => Some("Ask OpenClaw"),
        value if value.starts_with("/settings/agents") => Some("Agent settings"),
        value if value.starts_with("/settings/") => Some("Settings"),
        _ => None,
    }
}

fn route_icon(id: &str) -> IconName {
    match id {
        "agents-home" => IconName::Bot,
        "dashboards" => IconName::LayoutDashboard,
        "systems" | "portals" => IconName::Monitor,
        "cron" => IconName::CalendarClock,
        "plugins" => IconName::Plug,
        "usage" => IconName::Coins,
        "tasks" => IconName::ListChecks,
        "sessions" => IconName::FileText,
        "activity" => IconName::Activity,
        "meetings" => IconName::Book,
        "apps" => IconName::LayoutGrid,
        _ => IconName::Folder,
    }
}

fn plugin_icon(name: Option<&str>) -> IconName {
    match name {
        Some("kanban") => IconName::Kanban,
        Some("notebook" | "book") => IconName::Book,
        Some("layoutGrid") => IconName::LayoutGrid,
        Some("folder") => IconName::Folder,
        Some("bot") => IconName::Bot,
        Some("activity") => IconName::Activity,
        Some("terminal") => IconName::Terminal,
        Some("monitor") => IconName::Monitor,
        _ => IconName::Plug,
    }
}

fn navigation_menu_item(
    title: &str,
    path: &str,
    icon: IconName,
    active: bool,
    view: WeakEntity<AppView>,
) -> PopupMenuItem {
    let title = title.to_owned();
    let path = path.to_owned();
    let label = title.clone();
    PopupMenuItem::element(move |_, cx| {
        let p = Palette::sidebar(cx);
        div()
            .h_flex()
            .w_full()
            .h(menu::ROW_HEIGHT - menu::NATIVE_ROW_GAP)
            .gap(row::NAV.gap)
            .typography(text::MENU)
            .text_color(if active { p.strong } else { p.text })
            .child(
                div()
                    .w(menu::ICON_COLUMN)
                    .h(icon::NORMAL)
                    .flex_shrink_0()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(ui_icon(icon, icon::NORMAL).text_color(if active {
                        p.accent
                    } else {
                        p.text
                    })),
            )
            .child(div().flex_1().truncate().child(label.clone()))
    })
    .on_click(move |_, window, cx| {
        let _ = view.update(cx, |this, cx| {
            this.open_control_page(&path, &title, window, cx)
        });
    })
}
