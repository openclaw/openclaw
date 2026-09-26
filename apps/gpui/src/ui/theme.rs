use gpui_kit::{
    component::{Theme, ThemeMode},
    *,
};

#[derive(Clone, Copy)]
pub struct Palette {
    pub bg: Hsla,
    pub sidebar: Hsla,
    pub elevated: Hsla,
    pub hover: Hsla,
    pub card: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub text: Hsla,
    pub strong: Hsla,
    pub muted: Hsla,
    pub accent: Hsla,
    pub accent_hover: Hsla,
    pub accent_fg: Hsla,
    pub ok: Hsla,
    pub danger: Hsla,
    pub accent_subtle: Hsla,
    pub user_bubble: Hsla,
    pub panel_strong: Hsla,
    pub popover: Hsla,
    pub focus_ring: Hsla,
}

impl Palette {
    pub fn get(cx: &App) -> Self {
        Self::for_dark(Theme::global(cx).is_dark())
    }

    pub(super) fn for_dark(dark: bool) -> Self {
        // ui/src/styles/base.css owns the Control UI palette.
        let values = if dark {
            [
                0x0e1015, 0x13151b, 0x191c24, 0x1f2330, 0x161920, 0x1e2028, 0x2e3040, 0xbcbcc0,
                0xf4f4f5, 0x8b8b94, 0xff5c5c, 0xff7070, 0xfafafa, 0x22c55e, 0xf87171,
            ]
        } else {
            [
                0xf4f1ec, 0xfaf9f7, 0xffffff, 0xefebe4, 0xffffff, 0xe8e4dc, 0xd6d0c5, 0x403c35,
                0x211e1a, 0x6e6960, 0xbd4531, 0xa83c29, 0xffffff, 0x166534, 0xb91c1c,
            ]
        };
        let [
            bg,
            sidebar,
            elevated,
            hover,
            card,
            border,
            border_strong,
            text,
            strong,
            muted,
            accent,
            accent_hover,
            accent_fg,
            ok,
            danger,
        ] = values.map(|v| rgb(v).into());
        Self {
            bg,
            sidebar,
            elevated,
            hover,
            card,
            border,
            border_strong,
            text,
            strong,
            muted,
            accent,
            accent_hover,
            accent_fg,
            ok,
            danger,
            accent_subtle: bg.blend(Hsla {
                a: if dark { 0.1 } else { 0.08 },
                ..accent
            }),
            user_bubble: if dark {
                bg.blend(Hsla {
                    a: 0.16,
                    ..rgb(0x389f9d).into()
                })
            } else {
                rgb(0xe6faf9).into()
            },
            panel_strong: elevated,
            popover: card,
            focus_ring: accent,
        }
    }
}

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum Appearance {
    #[default]
    System,
    Light,
    Dark,
}

impl Global for Appearance {}

pub fn set_appearance(mode: Appearance, window: &mut Window, cx: &mut App) {
    cx.set_global(mode);
    apply(window, cx);
}

pub fn appearance(cx: &App) -> Appearance {
    cx.try_global::<Appearance>().copied().unwrap_or_default()
}

pub fn apply(window: &mut Window, cx: &mut App) {
    let mode = match appearance(cx) {
        Appearance::System => ThemeMode::from(window.appearance()),
        Appearance::Light => ThemeMode::Light,
        Appearance::Dark => ThemeMode::Dark,
    };
    Theme::change(mode, Some(window), cx);
    let p = Palette::get(cx);
    let font_family = if cx
        .text_system()
        .all_font_names()
        .iter()
        .any(|name| name == "Instrument Sans")
    {
        "Instrument Sans"
    } else {
        ".SystemUIFont"
    };
    let t = Theme::global_mut(cx);
    t.font_family = font_family.into();
    t.background = p.bg;
    t.foreground = p.text;
    t.border = p.border;
    t.input = p.border_strong;
    t.muted = p.sidebar;
    t.muted_foreground = p.muted;
    t.accent = p.hover;
    t.accent_foreground = p.strong;
    t.primary = p.accent;
    t.primary_hover = p.accent_hover;
    t.primary_active = p.accent_hover;
    t.primary_foreground = p.accent_fg;
    t.button_primary = p.accent;
    t.button_primary_hover = p.accent_hover;
    t.button_primary_active = p.accent_hover;
    t.button_primary_foreground = p.accent_fg;
    t.button = p.elevated;
    t.button_hover = p.hover;
    t.button_active = p.hover;
    t.button_foreground = p.text;
    t.secondary = p.elevated;
    t.secondary_foreground = p.text;
    t.colors.list = p.sidebar;
    t.list_hover = p.hover;
    t.list_active = p.hover;
    t.list_active_border = p.accent;
    t.popover = p.popover;
    t.popover_foreground = p.text;
    t.table_head = p.bg;
    t.table_head_foreground = p.strong;
    t.table_row_border = p.border;
    t.link = p.accent;
    t.link_hover = p.accent_hover;
    t.caret = p.accent;
    t.ring = p.focus_ring;
    t.success = p.ok;
    t.danger = p.danger;
    t.font_size = px(14.);
    t.radius = px(8.);
    // Widgets read resolved backgrounds as well as the solid color fields.
    t.tokens = t.colors.into();
    Theme::sync_base(cx);
    window.refresh();
}
pub(crate) mod draft_tokens;
pub(crate) mod menu_tokens;
