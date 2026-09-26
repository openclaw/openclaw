use super::icons::icon;
use crate::ui::theme::{
    Palette,
    tokens::{IconButtonMetrics, radius, space},
};
use gpui_kit::{
    assets::IconName,
    component::button::{Button, ButtonVariants},
    *,
};

/// Stock Button behavior, with one measured glyph/target owner and explicit accessible copy.
pub(crate) fn icon_button(
    id: impl Into<ElementId>,
    name: IconName,
    label: impl Into<SharedString>,
    metrics: IconButtonMetrics,
    cx: &App,
) -> Button {
    Button::new(id)
        .ghost()
        .size(metrics.size)
        .p(space::NONE)
        .rounded(radius::PERSON)
        .text_color(Palette::sidebar(cx).muted)
        .child(icon(name, metrics.icon))
        .accessibility_label(label)
}
