use crate::ui::theme::draft_tokens;
use gpui_kit::{component::Icon, *};

pub fn incognito(color: Hsla) -> Icon {
    Icon::empty()
        .data(include_bytes!("../../../assets/icons/incognito.svg"))
        .size(px(draft_tokens::INCOGNITO_ICON_SIZE))
        .text_color(color)
}
