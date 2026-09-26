use crate::ui::theme::{Palette, controls as t};
use gpui_kit::{
    component::{
        Sizable,
        button::{Button, ButtonVariants},
    },
    *,
};
pub(crate) fn composer_chip(
    id: &'static str,
    accessible_label: impl Into<SharedString>,
    p: Palette,
) -> Button {
    Button::new(id)
        .accessibility_label(accessible_label)
        .ghost()
        .small()
        .h(px(t::CHIP_HEIGHT))
        .px(px(t::SPACE_MD))
        .gap(px(t::SPACE_SM))
        .rounded_full()
        .text_size(px(t::TEXT_CHIP))
        .font_weight(t::WEIGHT_BODY)
        .text_color(p.controls().chip)
}
