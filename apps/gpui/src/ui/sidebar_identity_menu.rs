use super::AppView;
use crate::ui::{
    components::{icon_button::icon_button, icons::icon as ui_icon},
    theme::{
        self, Appearance, Palette,
        tokens::{TypographyExt, avatar, icon, icon_button as buttons, menu, space, text},
    },
};
use gpui_kit::{
    assets::IconName,
    component::{
        StyledExt,
        button::{Button, ButtonCustomVariant, ButtonVariants},
        menu::{PopupMenu, PopupMenuItem},
    },
    prelude::FluentBuilder,
    *,
};
use serde_json::Value;

#[derive(Clone, Copy)]
enum ConnectionAction {
    Reconnect,
    Switch,
    SignOut,
}

pub(in crate::ui) fn append_identity_navigation(
    mut menu: PopupMenu,
    view: WeakEntity<AppView>,
    window: &mut Window,
    cx: &mut Context<PopupMenu>,
) -> PopupMenu {
    let Some(entity) = view.upgrade() else {
        return menu;
    };
    let app = entity.read(cx);
    let profile = app.sidebar_state.people.self_user.clone();
    let name = profile
        .as_ref()
        .and_then(|person| person.name.as_deref().or(person.email.as_deref()))
        .unwrap_or("Owner")
        .to_owned();
    let email = profile
        .as_ref()
        .and_then(|person| person.email.clone())
        .filter(|email| email != &name);
    let can_pair = app.session.as_ref().is_some_and(|session| {
        session
            .hello()
            .pointer("/auth/scopes")
            .and_then(Value::as_array)
            .is_some_and(|scopes| {
                scopes.iter().any(|scope| {
                    matches!(scope.as_str(), Some("operator.admin" | "operator.pairing"))
                })
            })
    });
    let connection_epoch = app.epoch;
    let can_sign_out = app.session.is_some() || app.access_identity.is_some();
    let version = app
        .session
        .as_ref()
        .and_then(|session| {
            session
                .hello()
                .pointer("/server/version")
                .and_then(Value::as_str)
        })
        .unwrap_or("OpenClaw")
        .to_owned();
    let header_view = view.clone();
    let profile_view = view.clone();
    menu = menu
        .item(
            PopupMenuItem::element(move |_, cx| {
                let p = Palette::get(cx);
                let avatar = header_view
                    .upgrade()
                    .map(|entity| {
                        let app = entity.read(cx);
                        profile
                            .as_ref()
                            .map(|person| {
                                app.render_person_avatar(person, avatar::IDENTITY_MENU, cx)
                            })
                            .unwrap_or_else(|| {
                                div()
                                    .size(avatar::IDENTITY_MENU.diameter)
                                    .rounded_full()
                                    .bg(p.elevated)
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(ui_icon(IconName::UserRound, icon::MENU))
                                    .into_any_element()
                            })
                    })
                    .unwrap_or_else(|| {
                        div()
                            .size(avatar::IDENTITY_MENU.diameter)
                            .into_any_element()
                    });
                div()
                    .h_flex()
                    .w_full()
                    .h(menu::IDENTITY_HEADER_HEIGHT)
                    .gap(space::MD)
                    .ml(menu::IDENTITY_LABEL_INSET)
                    .child(avatar)
                    .child(
                        div()
                            .v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(space::HAIRLINE)
                            .child(
                                div()
                                    .truncate()
                                    .typography(text::IDENTITY_MENU_NAME)
                                    .text_color(p.text)
                                    .child(name.clone()),
                            )
                            .when_some(email.clone(), |el, email| {
                                el.child(
                                    div()
                                        .truncate()
                                        .typography(text::IDENTITY_MENU_EMAIL)
                                        .text_color(p.muted)
                                        .child(email),
                                )
                            }),
                    )
            })
            .on_click(move |_, window, cx| {
                let _ = profile_view.update(cx, |this, cx| {
                    this.open_control_page(
                        "/settings/profile#settings-profile-identity",
                        "Profile",
                        window,
                        cx,
                    )
                });
            }),
        )
        .separator();
    for (title, path, icon, hint) in [
        (
            "Settings",
            "/settings/appearance",
            IconName::Settings,
            Some("⌘,"),
        ),
        ("Usage", "/usage", IconName::Coins, None),
    ] {
        menu = menu.item(identity_page_item(title, path, icon, hint, view.clone()));
    }
    menu = menu
        .separator()
        .item(
            identity_page_item(
                "Pair device",
                "/settings/devices",
                IconName::Smartphone,
                None,
                view.clone(),
            )
            .disabled(!can_pair),
        )
        .item(identity_page_item(
            "Get the apps",
            "/apps",
            IconName::LayoutGrid,
            None,
            view.clone(),
        ))
        .item(identity_page_item(
            "System busyness",
            "/debug",
            IconName::Activity,
            None,
            view.clone(),
        ))
        .separator();
    menu = menu.submenu_with_icon(
        Some(ui_icon(IconName::CircleQuestionMark, icon::MENU)),
        "Help",
        window,
        cx,
        |mut menu, _, _| {
            menu = menu
                .min_w(menu::IDENTITY_HELP_MIN_WIDTH)
                .max_w(menu::IDENTITY_HELP_MAX_WIDTH);
            for (title, url, icon) in [
                (
                    "Documentation",
                    "https://docs.openclaw.ai",
                    IconName::BookOpen,
                ),
                (
                    "Get help",
                    "https://docs.openclaw.ai/help",
                    IconName::MessageCircle,
                ),
                ("Discord", "https://discord.gg/clawd", IconName::Users),
                (
                    "Changelog",
                    "https://docs.openclaw.ai/releases",
                    IconName::ScrollText,
                ),
            ] {
                menu = menu.item(
                    PopupMenuItem::element(move |_, cx| {
                        menu_label(title, icon, None, Palette::get(cx))
                    })
                    .on_click(move |_, _, cx| cx.open_url(url)),
                );
            }
            menu
        },
    );
    let connection_view = view.clone();
    menu = menu.separator().submenu("Gateways", window, cx, move |mut menu, _, _| {
        menu = menu.item(PopupMenuItem::new("Manage Gateways…").on_click(|_, _, cx| {
            crate::gateway_windows::manage(cx);
        }));
        for (label, action) in [("Reconnect", ConnectionAction::Reconnect), ("Switch Gateway…", ConnectionAction::Switch), ("Sign out", ConnectionAction::SignOut)] {
            let view = connection_view.clone();
            menu = menu.item(PopupMenuItem::new(label).disabled(matches!(action, ConnectionAction::SignOut) && !can_sign_out).on_click(move |_, window, cx| {
                let _ = view.update(cx, |this, cx| {
                    if this.epoch != connection_epoch {
                        this.mutation_error("Connection changed. Reopen the account menu before changing it.".into());
                        return;
                    }
                    match action {
                        ConnectionAction::Reconnect => this.retry(window, cx),
                        ConnectionAction::Switch => this.switch_gateway(window, cx),
                        ConnectionAction::SignOut => this.sign_out(window, cx),
                    }
                });
            }));
        }
        menu
    });
    let about_view = view.clone();
    let menu_view = cx.entity().downgrade();
    menu.separator().item(PopupMenuItem::element(move |_, cx| {
        let p = Palette::get(cx);
        let appearance = theme::appearance(cx);
        let (label, icon, next) = match appearance {
            Appearance::System => ("System", IconName::Monitor, Appearance::Light),
            Appearance::Light => ("Light", IconName::Sun, Appearance::Dark),
            Appearance::Dark => ("Dark", IconName::Moon, Appearance::System),
        };
        let about_view = about_view.clone();
        let menu_view = menu_view.clone();
        div()
            .h_flex()
            .w_full()
            .h(menu::IDENTITY_FOOTER_HEIGHT)
            .gap(space::MD)
            .child(
                Button::new("identity-build")
                    .custom(ButtonCustomVariant::new(cx).foreground(p.muted))
                    .flex_1()
                    .min_w_0()
                    .h(buttons::IDENTITY.size)
                    .p(space::NONE)
                    .child(
                        div()
                            .w_full()
                            .truncate()
                            .font_family(text::MONO_FAMILY)
                            .typography(text::BUILD)
                            .child(version.clone()),
                    )
                    .accessibility_label("About OpenClaw")
                    .on_click(move |_, window, cx| {
                        cx.stop_propagation();
                        let _ = about_view.update(cx, |this, cx| {
                            this.open_control_page("/settings/about", "About OpenClaw", window, cx)
                        });
                        let _ = menu_view.update(cx, |_, cx| cx.emit(DismissEvent));
                    }),
            )
            .child(
                icon_button(
                    "identity-theme-mode",
                    icon,
                    format!("Color mode: {label}"),
                    buttons::IDENTITY,
                    cx,
                )
                .tooltip(format!("Color mode: {label}"))
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    theme::set_appearance(next, window, cx);
                }),
            )
    }))
}

fn identity_page_item(
    title: &str,
    path: &str,
    icon: IconName,
    hint: Option<&str>,
    view: WeakEntity<AppView>,
) -> PopupMenuItem {
    let title = title.to_owned();
    let path = path.to_owned();
    let label = title.clone();
    let hint = hint.map(str::to_owned);
    PopupMenuItem::element(move |_, cx| menu_label(&label, icon, hint.as_deref(), Palette::get(cx)))
        .on_click(move |_, window, cx| {
            let _ = view.update(cx, |this, cx| {
                this.open_control_page(&path, &title, window, cx)
            });
        })
}

fn menu_label(title: &str, icon: IconName, hint: Option<&str>, p: Palette) -> AnyElement {
    div()
        .h_flex()
        .w_full()
        .h(menu::IDENTITY_ROW_HEIGHT)
        .gap(space::MD)
        .ml(menu::IDENTITY_LABEL_INSET)
        .typography(text::MENU)
        .text_color(p.text)
        .child(
            div()
                .w(icon::LEADING)
                .h(icon::LEADING)
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .child(ui_icon(icon, icon::MENU).text_color(p.muted)),
        )
        .child(div().flex_1().truncate().child(title.to_owned()))
        .when_some(hint, |el, hint| {
            el.child(
                div()
                    .typography(text::BUILD)
                    .text_color(p.muted)
                    .child(hint.to_owned()),
            )
        })
        .into_any_element()
}
