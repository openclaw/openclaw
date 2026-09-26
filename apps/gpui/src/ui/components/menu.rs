use crate::ui::theme::{Palette, controls as t};
use gpui_kit::{
    component::{StyledExt, popover::Popover},
    *,
};
pub(crate) fn menu_surface(p: Palette) -> Div {
    div()
        .v_flex()
        .bg(p.controls().menu)
        .border_1()
        .border_color(p.controls().menu_border)
        .rounded(px(t::MENU_RADIUS))
        .shadow_lg()
        .overflow_hidden()
}
pub(crate) fn control_popover(id: &'static str, open: bool, focus: &FocusHandle) -> Popover {
    Popover::new(id)
        .anchor(Anchor::BottomRight)
        .bottom(px(t::POPOVER_OFFSET))
        .appearance(false)
        .open(open)
        .track_focus(focus)
}
