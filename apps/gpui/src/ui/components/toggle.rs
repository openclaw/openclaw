use crate::ui::theme::tokens::space;
use crate::ui::theme::{Palette, controls as t};
use gpui_kit::{base::Switch, prelude::FluentBuilder as _, *};
/// The base switch owns activation and checked semantics; this supplies the measured Control UI skin.
pub(crate) fn toggle(
    id: &'static str,
    label: &'static str,
    active: bool,
    disabled: bool,
    p: Palette,
) -> Switch {
    Switch::new(id)
        .checked(active)
        .disabled(disabled)
        .accessibility_label(label)
        .flex()
        .items_center()
        .justify_center()
        .w(px(t::TOGGLE_WIDTH))
        .h(px(t::TOGGLE_HEIGHT))
        .flex_shrink_0()
        .rounded_full()
        .border(space::HAIRLINE)
        .border_color(if active { p.accent } else { p.border_strong })
        .bg(if active {
            p.controls().toggle_active
        } else {
            p.controls().toggle_inactive
        })
        .when(disabled, |control| control.opacity(t::DISABLED_OPACITY))
        .child(
            div()
                .relative()
                .w(px(t::TOGGLE_INNER_WIDTH))
                .h(px(t::TOGGLE_INNER_HEIGHT))
                .child(
                    div()
                        .absolute()
                        .top(px(t::TOGGLE_THUMB_INSET))
                        .left(px(if active {
                            t::TOGGLE_THUMB_ACTIVE
                        } else {
                            t::TOGGLE_THUMB_INSET
                        }))
                        .size(px(t::TOGGLE_THUMB_SIZE))
                        .rounded_full()
                        .bg(p.strong),
                ),
        )
}
