use crate::ui::theme::{Palette, controls as model, draft_tokens as draft};
use gpui_kit::{
    component::{
        Sizable,
        button::{Button, ButtonVariants},
    },
    prelude::FluentBuilder,
    *,
};

#[derive(Clone, Copy)]
pub(crate) enum ChipStyle {
    Model,
    Draft,
}

pub(crate) fn chip(
    id: impl Into<ElementId>,
    accessible_label: impl Into<SharedString>,
    style: ChipStyle,
    p: Palette,
) -> Button {
    let (height, padding, text, color) = match style {
        ChipStyle::Model => (
            model::CHIP_HEIGHT,
            model::SPACE_MD,
            model::TEXT_CHIP,
            p.controls().chip,
        ),
        ChipStyle::Draft => (
            draft::CHIP_HEIGHT,
            draft::CHIP_PADDING_X,
            draft::CHIP_TEXT_SIZE,
            p.muted,
        ),
    };
    Button::new(id)
        .accessibility_label(accessible_label)
        .ghost()
        .small()
        .h(px(height))
        .px(px(padding))
        .rounded_full()
        .text_size(px(text))
        .text_color(color)
        .when(matches!(style, ChipStyle::Model), |button| {
            button
                .gap(px(model::SPACE_SM))
                .font_weight(model::WEIGHT_BODY)
        })
}
