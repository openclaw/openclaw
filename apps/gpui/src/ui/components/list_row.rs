use crate::ui::theme::{Palette, controls as t};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder as _,
    *,
};
pub(crate) fn picker_row_action(selected: bool, shortcut: Option<usize>, p: Palette) -> AnyElement {
    if selected {
        Icon::new(IconName::Check)
            .size(px(t::ICON))
            .text_color(p.accent)
            .into_any_element()
    } else if let Some(shortcut) = shortcut {
        div()
            .min_w(px(t::ICON_PROVIDER))
            .h(px(t::ROW_ICON_SLOT))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(t::TEXT_SECTION))
            .font_weight(t::WEIGHT_BODY)
            .text_color(p.muted)
            .child(shortcut.to_string())
            .into_any_element()
    } else {
        div().into_any_element()
    }
}

#[derive(Clone, Copy)]
pub(crate) struct MenuRowStyle {
    pub selected: bool,
    pub highlighted: bool,
    pub disabled: bool,
    pub emphasized: bool,
}

pub(crate) fn menu_row(id: impl Into<ElementId>, style: MenuRowStyle, p: Palette) -> Button {
    Button::new(id)
        .ghost()
        .small()
        .w_full()
        .min_h(px(t::ROW_MIN_HEIGHT))
        .h_auto()
        .px(px(t::SPACE_ROW))
        .py(px(t::SPACE_SM))
        .gap(px(t::SPACE_MD))
        .rounded(px(t::ROW_RADIUS))
        .justify_start()
        .text_size(px(t::TEXT_ROW))
        .font_weight(if style.emphasized {
            t::WEIGHT_LABEL
        } else {
            t::WEIGHT_BODY
        })
        .text_color(p.text)
        .disabled(style.disabled)
        .when(style.selected && style.emphasized, |row| {
            row.bg(p.controls().selected)
        })
        .when(style.highlighted, |row| row.bg(p.hover))
}
