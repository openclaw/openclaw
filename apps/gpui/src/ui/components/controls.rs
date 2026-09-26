use crate::ui::theme::{Palette, draft_tokens as t, menu_tokens as m};
use gpui_kit::{
    assets::IconName,
    component::{
        Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder,
    *,
};

pub fn chip(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    leading: AnyElement,
    cx: &App,
) -> Button {
    let label = label.into();
    Button::new(id.into())
        .ghost()
        .small()
        .h(px(t::CHIP_HEIGHT))
        .px(px(t::CHIP_PADDING_X))
        .rounded_full()
        .text_size(px(t::CHIP_TEXT_SIZE))
        .text_color(Palette::get(cx).muted)
        .accessibility_label(label.clone())
        .child(
            div()
                .h_flex()
                .items_center()
                .gap(px(t::CONTROL_GAP))
                .child(leading)
                .child(label),
        )
        .dropdown_caret(true)
}

pub fn identity_row(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    avatar: AnyElement,
    selected: bool,
    cx: &App,
) -> Button {
    let p = Palette::get(cx);
    let label = label.into();
    Button::new(id.into())
        .ghost()
        .small()
        .w_full()
        .h(px(t::IDENTITY_ROW_HEIGHT))
        .px(px(m::ROW_PADDING_X))
        .accessibility_label(label.clone())
        .when(selected, |el| el.bg(p.hover))
        .child(
            div()
                .h_flex()
                .w_full()
                .items_center()
                .gap(px(t::IDENTITY_ROW_GAP))
                .child(avatar)
                .child(
                    div()
                        .flex_1()
                        .text_left()
                        .text_size(px(t::BODY_TEXT_SIZE))
                        .child(label),
                )
                .child(div().w(px(t::IDENTITY_CHECK_WIDTH)).when(selected, |el| {
                    el.child(
                        Icon::new(IconName::Check)
                            .size(px(m::ICON_SIZE))
                            .text_color(p.accent),
                    )
                })),
        )
}
