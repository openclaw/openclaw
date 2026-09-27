use super::{avatar::Avatar, avatar_cache::AvatarCache};
use crate::{
    model::avatars::AvatarSpec,
    ui::theme::{
        Palette,
        tokens::{AvatarMetrics, avatar, facepile},
    },
};
use gpui_kit::{component::tooltip::Tooltip, prelude::FluentBuilder, *};

pub(in crate::ui) struct FacepileItem {
    pub key: String,
    pub label: String,
    pub avatar: AvatarSpec,
}

pub(in crate::ui) fn facepile(
    items: &[FacepileItem],
    cache: &AvatarCache,
    max_visible: usize,
    total_count: usize,
    surface: Hsla,
    cx: &App,
) -> AnyElement {
    let p = Palette::get(cx);
    let metrics: AvatarMetrics = avatar::SESSION;
    let mut pile = div().ml(facepile::LEADING_INSET).flex().items_center();
    for (index, item) in items.iter().take(max_visible).enumerate() {
        let label = item.label.clone();
        pile = pile.child(
            div()
                .id(SharedString::from(item.key.clone()))
                .when(index > 0, |this| this.ml(-facepile::OVERLAP))
                .child(Avatar::new(&item.avatar, cache, metrics).border_color(surface))
                .tooltip(move |window, cx| Tooltip::new(label.clone()).build(window, cx)),
        );
    }
    let visible = items.len().min(max_visible);
    let overflow = total_count.max(items.len()).saturating_sub(visible);
    if overflow > 0 {
        let names = if items.len().saturating_sub(visible) == overflow {
            items
                .iter()
                .skip(visible)
                .map(|item| item.label.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            format!("{overflow} more participants")
        };
        pile = pile.child(
            div()
                .id("facepile-overflow")
                .ml(-facepile::OVERLAP)
                .size(metrics.diameter)
                .rounded_full()
                .bg(p.elevated)
                .border(metrics.border)
                .border_color(surface)
                .flex()
                .items_center()
                .justify_center()
                .text_size(facepile::OVERFLOW_TEXT)
                .text_color(p.muted)
                .child(format!("+{overflow}"))
                .tooltip(move |window, cx| Tooltip::new(names.clone()).build(window, cx)),
        );
    }
    pile.into_any_element()
}
