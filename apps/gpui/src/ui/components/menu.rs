use crate::ui::theme::{Palette, controls as t};
use gpui_kit::{
    component::{StyledExt, button::Button, popover::Popover},
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
pub(crate) fn control_popover(
    id: &'static str,
    open: bool,
    focus: &FocusHandle,
    trigger: Button,
    on_open_change: impl Fn(&bool, &mut Window, &mut App) + 'static,
) -> Popover {
    Popover::new(id)
        .anchor(Anchor::BottomRight)
        .bottom(px(t::POPOVER_OFFSET))
        .appearance(false)
        .open(open)
        .track_focus(focus)
        .trigger(menu_trigger(trigger))
        .on_open_change(on_open_change)
}

pub(crate) fn menu_trigger(button: Button) -> Button {
    // The listener advertises AXPress. GPUI forwards it as pointer events to the menu owner.
    button.on_click(|_, _, _| {})
}
