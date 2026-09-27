use super::super::theme::{Palette, tokens::transcript::TranscriptSurfaceTokens as T};
use gpui_kit::{component::Icon, *};
use std::time::Duration;

// Same filled pincer paths as Control UI's icons.claw.
const CLAW: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M8.2 10 A5.2 5.2 0 1 0 8.2 20.4 A5.2 5.2 0 0 0 8.2 10 Z M10.2 20 C14.5 20.8 19 18.6 22.3 13.2 C21 12.9 19.7 12.7 18.4 12.8 L17.5 14.6 L16 12.9 L14.3 14.5 L13.5 13 L11.5 14.2 Z"/><path d="M5.6 12.2 C5.2 5.6 10.4 1.4 15.6 2 C19.4 2.6 21.8 5.2 22.6 8.2 C20.9 7.7 19.2 7.6 17.6 7.9 L16.9 6.3 L15.2 8.5 C13.6 9.4 12.2 10.9 11.6 12.4 L6.8 13 Z"/></svg>"#;

pub(in crate::ui) fn activity_mark(active: bool, color: Hsla, size: Pixels) -> AnyElement {
    let mark = Icon::default().data(CLAW).size(size).text_color(color);
    if active {
        mark.with_animation(
            "activity-claw",
            Animation::new(Duration::from_millis(2400)).repeat(),
            |icon, progress| icon.rotate(Radians((progress * std::f32::consts::TAU).sin() * 0.08)),
        )
        .into_any_element()
    } else {
        mark.rotate(Radians(0.14)).into_any_element()
    }
}

const COMPACTION_CHECK: &[u8] = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>"#;

pub(in crate::ui) fn compaction_mark(active: bool, cx: &App) -> AnyElement {
    let p = Palette::get(cx);
    let mark = div().relative().size(px(T::GLYPH_SIZE)).flex_shrink_0();
    if !active {
        return mark
            .child(
                Icon::default()
                    .data(COMPACTION_CHECK)
                    .size(px(T::GLYPH_ICON))
                    .absolute()
                    .top(px(T::COMPACTION_CHECK_INSET))
                    .left(px(T::COMPACTION_CHECK_INSET))
                    .text_color(p.muted),
            )
            .into_any_element();
    }
    mark.children(T::COMPACTION_LINES.into_iter().enumerate().map(
        |(index, (top, width, fold_y, fold_scale, fold_opacity))| {
            let ease = gpui_kit::base::animation::cubic_bezier(0.4, 0., 0.2, 1.);
            div()
                .absolute()
                .h(px(T::COMPACTION_LINE_HEIGHT))
                .rounded(px(T::COMPACTION_LINE_HEIGHT))
                .bg(p.accent)
                .with_animation(
                    ("compaction-line", index),
                    Animation::new(Duration::from_millis(T::COMPACTION_CYCLE_MS)).repeat(),
                    move |line, progress| {
                        let [start, folded, unfold, end] = T::COMPACTION_PHASES;
                        let fold = if progress < start || progress >= end {
                            0.
                        } else if progress < folded {
                            ease((progress - start) / (folded - start))
                        } else if progress < unfold {
                            1.
                        } else {
                            1. - ease((progress - unfold) / (end - unfold))
                        };
                        let scaled_width = width * (1. + (fold_scale - 1.) * fold);
                        line.left(px(T::COMPACTION_LINE_LEFT
                            + T::COMPACTION_FOLD_X * fold
                            + (width - scaled_width) / 2.))
                            .top(px(top + fold_y * fold))
                            .w(px(scaled_width))
                            .opacity(
                                T::COMPACTION_OPEN_OPACITY
                                    + (fold_opacity - T::COMPACTION_OPEN_OPACITY) * fold,
                            )
                    },
                )
        },
    ))
    .into_any_element()
}
