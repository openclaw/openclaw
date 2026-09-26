use crate::{
    model::gateway_menu::{GatewayStatus, MenuRow},
    ui::{
        components::icons::icon as ui_icon,
        theme::{
            Palette,
            tokens::{TypographyExt, icon, menu, space, text},
        },
    },
};
use gpui_kit::{assets::IconName, component::StyledExt, prelude::FluentBuilder, *};

fn row(title: &str, leading: AnyElement, leading_width: Pixels, p: Palette) -> Div {
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
                .w(leading_width)
                .h(icon::LEADING)
                .flex_shrink_0()
                .flex()
                .items_center()
                .justify_center()
                .child(leading),
        )
        .child(div().flex_1().truncate().child(title.to_owned()))
}

pub(crate) fn menu_label(
    title: &str,
    icon: IconName,
    hint: Option<&str>,
    p: Palette,
) -> AnyElement {
    row(
        title,
        ui_icon(icon, icon::MENU)
            .text_color(p.muted)
            .into_any_element(),
        icon::LEADING,
        p,
    )
    .when_some(hint, |el, hint| el.child(detail(hint, p)))
    .into_any_element()
}

pub(crate) fn gateway_label(gateway: &MenuRow, p: Palette) -> AnyElement {
    row(
        &gateway.name,
        div()
            .size(menu::GATEWAY_STATUS_SIZE)
            .rounded_full()
            .bg(if gateway.status == GatewayStatus::Connected {
                p.ok
            } else {
                p.muted
            })
            .into_any_element(),
        menu::GATEWAY_STATUS_SIZE,
        p,
    )
    .when(gateway.primary, |el| el.child(detail("primary", p)))
    .when_some(gateway.number.filter(|_| !gateway.checked), |el, number| {
        el.child(detail(&format!("⌘{number}"), p))
    })
    .when(gateway.checked, |el| {
        el.child(ui_icon(IconName::Check, menu::GATEWAY_CHECK_SIZE))
    })
    .into_any_element()
}

fn detail(label: &str, p: Palette) -> Div {
    div()
        .typography(text::BUILD)
        .text_color(p.muted)
        .child(label.to_owned())
}
