use super::icons::filled_zap;
use crate::ui::theme::tokens::space;
use crate::ui::theme::{Palette, controls as t};
use gpui_kit::{
    assets::IconName,
    component::{Icon, StyledExt},
    *,
};
pub(crate) fn setting_row(icon: IconName, title: &str, description: &str, p: Palette) -> Div {
    div()
        .h_flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(t::SPACE_MD))
        .px(px(t::SPACE_LG))
        .py(px(t::SPACE_SECTION_Y))
        .border_t(space::HAIRLINE)
        .border_color(p.controls().section_border)
        .child(if matches!(icon, IconName::Zap) {
            filled_zap(t::ICON_PROVIDER, p.accent)
        } else {
            Icon::new(icon)
                .size(px(t::ICON_PROVIDER))
                .text_color(p.accent)
                .into_any_element()
        })
        .child(
            div()
                .v_flex()
                .gap(px(t::SPACE_HAIRLINE))
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(t::TEXT_LABEL))
                        .font_weight(t::WEIGHT_LABEL)
                        .child(title.to_owned()),
                )
                .child(
                    div()
                        .text_size(px(t::TEXT_META))
                        .line_height(px(t::META_LINE_HEIGHT))
                        .text_color(p.muted)
                        .truncate()
                        .child(description.to_owned()),
                ),
        )
}
