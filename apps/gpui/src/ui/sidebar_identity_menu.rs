use super::AppView;
use crate::ui::{
    components::{
        icon_button::icon_button,
        icons::icon as ui_icon,
        identity_menu::{gateway_label, menu_label},
    },
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
    let current_id = app.profile.as_ref().map(|profile| profile.id.clone());
    let version = crate::model::build_info::footer_label(std::time::SystemTime::now());
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
                    .gap(menu::IDENTITY_AVATAR_GAP)
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
    menu = append_gateways(menu, current_id, view.clone(), cx);
    for (title, path, icon, hint) in [
        (
            "Settings",
            "/settings/appearance",
            IconName::Settings,
            Some("⌘⇧,"),
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
        .item({
            let view = view.clone();
            PopupMenuItem::element(|_, cx| {
                menu_label(
                    "System busyness",
                    IconName::Activity,
                    Some("⌘⇧D"),
                    Palette::get(cx),
                )
            })
            .on_click(move |_, window, cx| {
                let _ = view.update(cx, |this, cx| this.open_system_busyness(window, cx));
            })
        })
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

fn append_gateways(
    mut menu: PopupMenu,
    current_id: Option<String>,
    view: WeakEntity<AppView>,
    cx: &App,
) -> PopupMenu {
    let rows = crate::gateway_windows::snapshot(current_id.as_deref(), cx);
    menu = menu.label("GATEWAY");
    for row in rows.iter() {
        let id = row.id.clone();
        let display = row.clone();
        menu = menu.item(
            PopupMenuItem::element(move |_, cx| gateway_label(&display, Palette::get(cx)))
                .on_click(move |_, _, cx| crate::gateway_windows::open_id(&id, cx)),
        );
    }
    if let Some(current) = rows.iter().find(|row| row.checked && !row.primary) {
        let id = current.id.clone();
        menu = menu.item(
            PopupMenuItem::element(|_, cx| {
                menu_label("Set as primary…", IconName::Star, None, Palette::get(cx))
            })
            .on_click(move |_, _, cx| {
                if let Err(error) = crate::gateway_windows::set_primary(&id, cx) {
                    let _ = view.update(cx, |this, cx| {
                        this.mutation_error(error);
                        cx.notify();
                    });
                }
            }),
        );
    }
    menu.item(
        PopupMenuItem::element(|_, cx| {
            menu_label(
                "Gateway settings…",
                IconName::Server,
                None,
                Palette::get(cx),
            )
        })
        .on_click(|_, _, cx| crate::gateway_windows::manage(cx)),
    )
    .separator()
}
