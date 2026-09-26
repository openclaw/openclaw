//! Shared sidebar row geometry; feature views supply content and behavior.
use crate::ui::theme::tokens::{InsetsExt, RowMetrics, TypographyExt, header, row, space, text};
use gpui_kit::{
    component::{
        Sizable, StyledExt,
        button::{Button, ButtonVariants},
    },
    *,
};

pub(crate) fn list_row(id: impl Into<ElementId>, metrics: RowMetrics) -> Stateful<Div> {
    div()
        .id(id)
        .h_flex()
        .relative()
        .min_h(metrics.min_height)
        .insets(metrics.padding)
        .gap(metrics.gap)
        .rounded(metrics.radius)
}

pub(crate) fn section_header(id: impl Into<ElementId>) -> Button {
    Button::new(id)
        .ghost()
        .small()
        .flex_1()
        .min_w_0()
        .h(header::SECTION_HEIGHT)
        .justify_start()
        .px(space::MD)
        .gap(row::NAV.gap)
}

pub(crate) fn empty_state(message: impl Into<SharedString>, color: Hsla) -> impl IntoElement {
    div()
        .p(space::XL)
        .typography(text::SMALL)
        .text_color(color)
        .child(message.into())
}
