use super::{super::Palette, avatar};
use gpui_kit::*;

pub const TRANSPARENT: Hsla = hsla(0., 0., 0., 0.);

pub fn navigation_hover(p: Palette) -> Hsla {
    p.hover.opacity(0.84)
}
pub fn navigation_active(p: Palette, dark: bool) -> Hsla {
    let accent_alpha = if dark { 26. / 255. } else { 20. / 255. };
    let alpha = accent_alpha * 0.88 + 0.12;
    p.elevated
        .blend(p.accent.opacity(accent_alpha * 0.88 / alpha))
        .opacity(alpha)
}
pub fn selected_border(p: Palette) -> Hsla {
    p.accent.opacity(0.16)
}
pub fn session_hover(p: Palette) -> Hsla {
    p.hover.opacity(0.78)
}
pub fn session_selected(p: Palette) -> Hsla {
    p.text.opacity(0.1)
}
pub fn multi_selected(p: Palette) -> Hsla {
    p.accent.opacity(0.14)
}
pub fn category_tint(color: Hsla) -> Hsla {
    color.opacity(0.08)
}
pub fn attention_text(p: Palette) -> Hsla {
    p.text.blend(p.warn.opacity(0.82))
}
pub fn error_text(p: Palette) -> Hsla {
    p.text.blend(p.danger.opacity(0.86))
}
pub fn overlay_border(p: Palette) -> Hsla {
    p.border_strong.opacity(0.64)
}
pub fn section_border(p: Palette) -> Hsla {
    p.border.opacity(0.64)
}
pub fn agent_tile(p: Palette) -> Hsla {
    p.card.blend(p.strong.opacity(0.09))
}
pub fn agent_ring(p: Palette, selected: bool) -> Hsla {
    if selected {
        p.accent.opacity(0.45)
    } else {
        p.strong.opacity(0.24)
    }
}
pub fn hover_card_surface(p: Palette, dark: bool) -> Hsla {
    if dark {
        p.card.blend(Hsla {
            a: 0.06,
            ..rgb(0).into()
        })
    } else {
        p.card
    }
}
pub fn menu_shadow(dark: bool) -> Vec<BoxShadow> {
    let color: Hsla = rgb(if dark { 0 } else { 0x3c2a18 }).into();
    vec![
        BoxShadow {
            color: color.opacity(if dark { 0.18 } else { 0.035 }),
            offset: point(px(0.), px(1.)),
            blur_radius: px(2.),
            spread_radius: px(0.),
            inset: false,
        },
        BoxShadow {
            color: color.opacity(if dark { 0.24 } else { 0.065 }),
            offset: point(px(0.), px(8.)),
            blur_radius: px(24.),
            spread_radius: px(0.),
            inset: false,
        },
    ]
}
pub fn hover_card_shadow(dark: bool) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: if dark {
            rgba(0x00000066).into()
        } else {
            rgba(0x3c2a1817).into()
        },
        offset: point(px(0.), px(12.)),
        blur_radius: px(if dark { 32. } else { 28. }),
        spread_radius: px(0.),
        inset: false,
    }]
}
pub fn focus_ring(p: Palette) -> Vec<BoxShadow> {
    vec![BoxShadow {
        color: p.accent.opacity(0.5),
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.),
        spread_radius: px(2.),
        inset: false,
    }]
}
pub fn agent_ring_shadow(p: Palette, selected: bool) -> Vec<BoxShadow> {
    vec![
        BoxShadow {
            color: agent_ring(p, selected),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: avatar::RING_OUTER,
            inset: false,
        },
        BoxShadow {
            color: p.elevated,
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.),
            spread_radius: avatar::RING_GAP,
            inset: false,
        },
    ]
}
pub fn merged_pull_request() -> Hsla {
    rgb(0xb595e8).into()
}
pub fn session_color(value: &str, dark: bool) -> Option<Hsla> {
    let colors = if dark {
        [
            0xf07878, 0x72a7ed, 0x69bf8a, 0xdcc365, 0xb595e8, 0xeaa36a, 0xdf8cb9, 0x66bccb,
        ]
    } else {
        [
            0xc74646, 0x376fbd, 0x328452, 0x9a791b, 0x8652ba, 0xbb681f, 0xb34885, 0x258394,
        ]
    };
    [
        "red", "blue", "green", "yellow", "purple", "orange", "pink", "cyan",
    ]
    .iter()
    .position(|name| *name == value)
    .map(|index| rgb(colors[index]).into())
}
pub fn initials_background(hue: u16, owner: bool) -> Hsla {
    hsla(
        f32::from(hue) / 360.,
        if owner { 0.58 } else { 0.48 },
        if owner { 0.26 } else { 0.42 },
        1.,
    )
}
pub fn initials_foreground() -> Hsla {
    rgb(0xffffff).into()
}

pub fn generated_face(seed: u32) -> [String; 3] {
    let hues = [8, 32, 48, 82, 142, 174, 202, 232, 272, 322];
    let hue = hues[seed as usize % hues.len()];
    [
        format!("hsl({hue},58%,62%)"),
        format!("hsl({hue},65%,90%)"),
        format!("hsl({hue},55%,18%)"),
    ]
}
