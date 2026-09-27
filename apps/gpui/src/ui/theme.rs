pub mod tokens;

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
    pub warn: Hsla,
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

    pub(super) fn sidebar(cx: &App) -> Self {
        let mut palette = Self::get(cx);
        palette.sidebar = if Theme::global(cx).is_dark() {
            palette.bg.blend(palette.elevated.opacity(0.04))
        } else {
            palette.sidebar.blend(Hsla {
                a: 0.02,
                ..rgb(0xffffff).into()
            })
        };
        palette
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
            warn: rgb(if dark { 0xf59e0b } else { 0x92400e }).into(),
            accent_subtle: bg.blend(Hsla {
                a: if dark { 0.1 } else { 0.08 },
                ..accent
            }),
            user_bubble: if dark {
                Hsla { a: 0.1, ..accent }
            } else {
                bg.blend(Hsla { a: 0.15, ..accent })
            },
            panel_strong: elevated,
            popover: elevated,
            focus_ring: accent,
        }
    }
}

/// Measured composer control geometry and typography from the Control UI.
pub mod controls {
    use super::tokens::{self, opacity, primitives as scale};
    use gpui_kit::FontWeight;
    pub const REM_SPACE_XS: f32 = scale::rem::XS;
    pub const REM_SPACE_SM: f32 = scale::rem::SM;
    pub const REM_SPACE_MD: f32 = scale::rem::MD;
    pub const REM_SPACE_LG: f32 = scale::rem::LG;
    pub const SPACE_HAIRLINE: f32 = scale::space::HAIRLINE;
    pub const SPACE_TINY: f32 = scale::space::XXS;
    pub const SPACE_COMPACT: f32 = scale::space::TIGHT;
    pub const SPACE_XS: f32 = scale::space::XS;
    pub const SPACE_SM: f32 = scale::space::SM;
    pub const SPACE_SEARCH: f32 = scale::space::SEARCH;
    pub const SPACE_MD: f32 = scale::space::MD;
    pub const SPACE_ROW: f32 = scale::space::ROW;
    pub const SPACE_INSET: f32 = scale::space::LG;
    pub const SPACE_SECTION_Y: f32 = scale::space::SECTION;
    pub const SPACE_LG: f32 = scale::space::XL;
    pub const ICON_SMALL: f32 = scale::icon::SMALL;
    pub const ICON_META: f32 = scale::icon::COMPACT;
    pub const ICON: f32 = scale::icon::ACTION;
    pub const ICON_TRIGGER: f32 = scale::icon::MENU;
    pub const ICON_PROVIDER: f32 = scale::icon::NORMAL;
    pub const ROW_ICON_SLOT: f32 = 18.;
    pub const ROW_ACTION_SLOT: f32 = 22.;
    pub const CHIP_HEIGHT: f32 = 30.;
    pub const CHIP_MIN_WIDTH: f32 = 44.;
    pub const CHIP_MAX_WIDTH: f32 = 260.;
    pub const SEARCH_HEIGHT: f32 = 36.;
    pub const SEARCH_INPUT_HEIGHT: f32 = 34.;
    pub const MODEL_MENU_WIDTH: f32 = 338.;
    pub const EFFORT_MENU_WIDTH: f32 = 328.;
    pub const MENU_MAX_HEIGHT: f32 = 398.;
    pub const EMPTY_HEIGHT: f32 = 112.;
    pub const SEARCH_EMPTY_HEIGHT: f32 = 80.;
    pub const ROW_MIN_HEIGHT: f32 = 40.;
    pub const SECTION_HEIGHT: f32 = 32.;
    pub const MENU_RADIUS: f32 = scale::radius::MODEL_MENU;
    pub const ROW_RADIUS: f32 = scale::radius::ROW;
    pub const SEARCH_RADIUS: f32 = scale::radius::PERSON;
    pub const FALLBACK_ICON_RADIUS: f32 = scale::radius::TINY;
    pub const TEXT_TINY: f32 = scale::text::TINY;
    pub const TEXT_META: f32 = scale::text::META;
    pub const TEXT_SECTION: f32 = scale::text::CAPTION;
    pub const TEXT_LABEL: f32 = scale::text::SMALL;
    pub const TEXT_ROW: f32 = scale::text::ROW;
    pub const TEXT_CHIP: f32 = scale::text::BODY;
    pub const CHIP_LINE_HEIGHT: f32 = 18.9;
    pub const META_LINE_HEIGHT: f32 = 13.;
    pub const ICON_BUTTON_SIZE: f32 = 22.;
    pub const POPOVER_OFFSET: f32 = scale::space::SM;
    pub const SLIDER_HEIGHT: f32 = 26.;
    pub const SLIDER_WIDTH: f32 = 292.;
    pub const SLIDER_RADIUS: f32 = scale::radius::SLIDER;
    pub const SLIDER_THUMB_WIDTH: f32 = 28.;
    pub const SLIDER_THUMB_HEIGHT: f32 = 20.;
    pub const SLIDER_THUMB_INSET: f32 = scale::space::TIGHT;
    pub const SLIDER_THUMB_RADIUS: f32 = scale::radius::PERSON;
    pub const SLIDER_DOT_SIZE: f32 = 4.;
    pub const SLIDER_DOT_INSET: f32 = scale::space::XL;
    pub const SLIDER_DOT_TOP: f32 = scale::space::SECTION;
    pub const SLIDER_FOCUS_OUTSET: f32 = scale::space::XXS;
    pub const SLIDER_FOCUS_RADIUS: f32 = scale::radius::PANEL;
    pub const SLIDER_BOOST_BLUR: f32 = 12.;
    pub const SLIDER_ULTRA_BLUR: f32 = 18.;
    pub const SLIDER_GRADIENT_ANGLE: f32 = 90.;
    pub const TOGGLE_WIDTH: f32 = 36.;
    pub const TOGGLE_HEIGHT: f32 = 22.;
    pub const TOGGLE_INNER_WIDTH: f32 = 34.;
    pub const TOGGLE_INNER_HEIGHT: f32 = 20.;
    pub const TOGGLE_THUMB_SIZE: f32 = 14.;
    pub const TOGGLE_THUMB_INSET: f32 = scale::space::TIGHT;
    pub const TOGGLE_THUMB_ACTIVE: f32 = 17.;
    pub const DISABLED_OPACITY: f32 = opacity::DISABLED;
    pub const UNANCHORED_OPACITY: f32 = 0.35;
    pub const WEIGHT_BODY: FontWeight = tokens::weight::NORMAL;
    pub const WEIGHT_SCALE: FontWeight = tokens::weight::MEDIUM;
    pub const WEIGHT_LABEL: FontWeight = tokens::weight::SEMIBOLD;
    pub const WEIGHT_HEADING: FontWeight = tokens::weight::BOLD;
}

#[derive(Clone, Copy)]
pub struct ControlColors {
    pub chip: Hsla,
    pub menu: Hsla,
    pub menu_border: Hsla,
    pub search: Hsla,
    pub search_border: Hsla,
    pub selected: Hsla,
    pub section_border: Hsla,
    pub warning: Hsla,
    pub slider_track: Hsla,
    pub slider_fill: Hsla,
    pub slider_dot: Hsla,
    pub boost_center: Hsla,
    pub ultra_center: Hsla,
    pub boost_glow: Hsla,
    pub ultra_glow: Hsla,
    pub boost_border: Hsla,
    pub ultra_border: Hsla,
    pub toggle_active: Hsla,
    pub toggle_inactive: Hsla,
}

impl Palette {
    pub fn controls(self) -> ControlColors {
        ControlColors {
            chip: self.popover.blend(self.strong.opacity(0.65)),
            menu: self.elevated.blend(self.card.opacity(0.04)),
            menu_border: tokens::colors::overlay_border(self),
            search: self.card.opacity(0.78),
            search_border: self.border.opacity(0.78),
            selected: self.text.opacity(0.08),
            section_border: self.border.opacity(0.7),
            warning: rgb(0xfbbf24).into(),
            slider_track: self.elevated.blend(self.text.opacity(0.07)),
            slider_fill: self.text.opacity(0.12),
            slider_dot: self.text.opacity(0.28),
            boost_center: Hsla::from(rgb(0xffffff)).blend(self.accent.opacity(0.6)),
            ultra_center: Hsla::from(rgb(0xffffff)).blend(Hsla::from(rgb(0x14b8a6)).opacity(0.7)),
            boost_glow: self.accent.opacity(0.24),
            ultra_glow: self.accent.opacity(0.48),
            boost_border: self.accent.opacity(0.45),
            ultra_border: self.accent.opacity(0.75),
            toggle_active: self.card.blend(self.accent.opacity(0.58)),
            toggle_inactive: self.card.blend(self.text.opacity(0.12)),
        }
    }

    pub fn provider_color(self, provider: &str) -> Hsla {
        match provider {
            "openai" => rgb(0x10a37f).into(),
            "anthropic" | "claude-cli" => rgb(0xd97757).into(),
            "google" => rgb(0x4285f4).into(),
            "ollama" | "lmstudio" | "llama-cpp" | "opencode" => self.strong,
            _ => self.muted,
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
        .any(|name| name == tokens::text::UI_FAMILY)
    {
        tokens::text::UI_FAMILY
    } else {
        tokens::text::FALLBACK_FAMILY
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
    t.font_size = tokens::text::BODY.size;
    t.radius = tokens::radius::CONTROL;
    // Widgets read resolved backgrounds as well as the solid color fields.
    t.tokens = t.colors.into();
    Theme::sync_base(cx);
    window.refresh();
}
pub(crate) mod draft_tokens;
pub(crate) mod menu_tokens;
