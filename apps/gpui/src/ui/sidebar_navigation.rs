use super::{AppView, theme::Palette, web_state::WebUi};
use crate::model::web_urls::{self, ControlUiTab, SIDEBAR_ROUTES};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        menu::{DropdownMenu, PopupMenu, PopupMenuItem},
    },
    prelude::FluentBuilder,
    *,
};
use serde::Deserialize;
use serde_json::json;

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
        let p = Palette::get(cx);
        let entries = &self.sidebar_state.preferences.sidebar_entries;
        let active = self
            .web
            .settings_open
            .then(|| web_urls::sidebar_route_for_path(&self.web.page_path).map(|route| route.id))
            .flatten();
        let mut content = div().id("sidebar-navigation").v_flex().gap(px(1.));
        for entry in entries {
            let Some(route) = SIDEBAR_ROUTES
                .iter()
                .find(|route| entry == &format!("route:{}", route.id))
            else {
                continue;
            };
            let route = *route;
            content = content.child(
                self.navigation_row(
                    route.id,
                    route.title,
                    route_icon(route.id),
                    active == Some(route.id),
                    cx,
                )
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.open_control_page(route.path, route.title, window, cx);
                })),
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
                    self.navigation_row(
                        &format!("plugin:{}", tab.key()),
                        &tab.label,
                        plugin_icon(tab.icon.as_deref()),
                        self.web.settings_open && tab.is_active(&self.web.page_path),
                        cx,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.open_control_page(&path, &title, window, cx);
                    })),
                );
            }
        }
        let more_active = active.is_some_and(|id| !entries.contains(&format!("route:{id}")));
        let entries = entries.clone();
        let view = cx.entity().downgrade();
        content.child(
            Button::new("sidebar-more")
                .ghost()
                .small()
                .w_full()
                .h(px(30.))
                .justify_start()
                .px(px(8.))
                .gap(px(8.))
                .child(div().w_full().h_flex().gap(px(8.))
                    .child(Icon::new(IconName::Ellipsis).size(px(16.)).text_color(p.muted))
                    .child(div().flex_1().min_w_0().truncate().child("More")))
                .accessibility_label("More navigation")
                .disabled(self.session.is_none())
                .when(more_active, |button| button.bg(p.hover))
                .dropdown_menu(move |mut menu, window, cx| {
                    for route in SIDEBAR_ROUTES {
                        if !entries.contains(&format!("route:{}", route.id)) {
                            menu = menu.item(control_page_item(route.title, route.path, view.clone())
                                .icon(route_icon(route.id))
                                .checked(active == Some(route.id)));
                        }
                    }
                    let entries = entries.clone();
                    let customize_view = view.clone();
                    menu.separator().submenu("Edit pinned items", window, cx, move |mut menu, _, _| {
                        for route in SIDEBAR_ROUTES {
                            let entry = format!("route:{}", route.id);
                            let checked = entries.contains(&entry);
                            let view = customize_view.clone();
                            menu = menu.item(PopupMenuItem::new(route.title)
                                .checked(checked)
                                .on_click(move |_, _, cx| {
                                    let _ = view.update(cx, |this, cx| {
                                        this.change_sidebar_preferences(|prefs| {
                                            if prefs.sidebar_entries.contains(&entry) {
                                                prefs.sidebar_entries.retain(|candidate| candidate != &entry);
                                            } else {
                                                prefs.sidebar_entries.push(entry.clone());
                                            }
                                        }, cx);
                                    });
                                }));
                        }
                        let view = customize_view.clone();
                        menu.separator().item(PopupMenuItem::new("Reset to default").on_click(move |_, _, cx| {
                            let _ = view.update(cx, |this, cx| {
                                this.change_sidebar_preferences(|prefs| {
                                    let sessions: Vec<_> = prefs.sidebar_entries.iter()
                                        .filter(|entry| entry.starts_with("session:"))
                                        .cloned().collect();
                                    prefs.sidebar_entries = crate::model::sidebar::SidebarPreferences::default().sidebar_entries;
                                    prefs.sidebar_entries.extend(sessions);
                                }, cx);
                            });
                        }))
                    })
                }),
        ).into_any_element()
    }

    fn navigation_row(
        &self,
        id: &str,
        title: &str,
        icon: IconName,
        active: bool,
        cx: &Context<Self>,
    ) -> Button {
        let p = Palette::get(cx);
        Button::new(SharedString::from(format!("nav-{id}")))
            .ghost()
            .small()
            .w_full()
            .h(px(30.))
            .justify_start()
            .px(px(8.))
            .gap(px(8.))
            .child(
                div()
                    .w_full()
                    .h_flex()
                    .gap(px(8.))
                    .child(Icon::new(icon).size(px(16.)).text_color(p.muted))
                    .child(div().flex_1().min_w_0().truncate().child(title.to_owned())),
            )
            .accessibility_label(format!(
                "{title}{}",
                if active { ", current page" } else { "" }
            ))
            .disabled(self.session.is_none())
            .when(active, |button| button.bg(p.hover))
    }
}

pub(super) fn append_identity_navigation(
    mut menu: PopupMenu,
    view: WeakEntity<AppView>,
) -> PopupMenu {
    for (title, path) in [
        ("Profile", "/settings/profile#settings-profile-identity"),
        ("Settings", "/settings/appearance"),
        ("Usage", "/usage"),
    ] {
        menu = menu.item(control_page_item(title, path, view.clone()));
    }
    menu = menu.separator();
    for (title, path) in [
        ("Pair mobile", "/settings/devices"),
        ("Get apps", "/apps"),
        ("Debug", "/debug"),
        ("About OpenClaw", "/settings/about"),
    ] {
        menu = menu.item(control_page_item(title, path, view.clone()));
    }
    menu.separator()
        .label("Help")
        .link("Documentation", "https://docs.openclaw.ai")
        .link("Get help", "https://docs.openclaw.ai/help")
        .link("Discord", "https://discord.gg/clawd")
        .link("Changelog", "https://docs.openclaw.ai/releases")
}

pub(super) fn append_agent_navigation(mut menu: PopupMenu, view: WeakEntity<AppView>) -> PopupMenu {
    menu = menu
        .separator()
        .item(control_page_item(
            "Browse all agents",
            "/agents",
            view.clone(),
        ))
        .item(control_page_item(
            "New agent",
            "/custodian?intent=new-agent",
            view.clone(),
        ));
    let capabilities_view = view.clone();
    menu = menu.item(PopupMenuItem::new("What can this agent do?").on_click(
        move |_, window, cx| {
            let _ = capabilities_view.update(cx, |this, cx| {
                if this.session.is_none() {
                    return;
                }
                this.select_session(this.agent_home(), window, cx);
                this.composer.update(cx, |input, cx| {
                    input.set_value("What can you do?", window, cx);
                    input.focus(window, cx);
                });
            });
        },
    ));
    menu.item(
        PopupMenuItem::new("Agent settings").on_click(move |_, window, cx| {
            let _ = view.update(cx, |this, cx| {
                let agent = this
                    .sidebar_state
                    .selected_agent
                    .as_deref()
                    .unwrap_or("main");
                if let Some(path) = web_urls::agent_settings_path(agent) {
                    this.open_control_page(&path, "Agent settings", window, cx);
                }
            });
        }),
    )
}

fn control_page_item(title: &str, path: &str, view: WeakEntity<AppView>) -> PopupMenuItem {
    let title = title.to_owned();
    let path = path.to_owned();
    PopupMenuItem::new(title.clone()).on_click(move |_, window, cx| {
        let _ = view.update(cx, |this, cx| {
            this.open_control_page(&path, &title, window, cx)
        });
    })
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
