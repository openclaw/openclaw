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
                Hsla { a: 0.1, ..accent }
            } else {
                bg.blend(Hsla { a: 0.15, ..accent })
            },
            panel_strong: elevated,
            popover: card,
            focus_ring: accent,
        }
    }
}

/// Computed Control UI transcript geometry (default 1.25 corner scale).
pub(super) struct TranscriptTokens;
impl TranscriptTokens {
    pub const AVATAR: f32 = 36.;
    pub const AVATAR_GAP: f32 = 10.;
    pub const AVATAR_INITIALS_SIZE: f32 = 12.;
    pub const AVATAR_TEXT_SIZE: f32 = 13.;
    pub const BUBBLE_RADIUS: f32 = 17.5;
    pub const BUBBLE_PADDING_X: f32 = 16.;
    pub const BUBBLE_PADDING_Y: f32 = 16.;
    pub const FOOTER_HEIGHT: f32 = 24.;
    pub const FOOTER_GAP: f32 = 8.;
    pub const MESSAGE_GAP: f32 = 2.;
    pub const TURN_GAP: f32 = 2.;
    pub const CONTINUATION_GAP: f32 = 6.;
    pub const FIRST_TURN_INSET: f32 = 28.;
    pub const TEXT_SIZE: f32 = 14.;
    pub const META_SIZE: f32 = 12.;
    pub const LINE_HEIGHT: f32 = 1.5;
    pub const ROW_INSET: f32 = 4.;
    pub const OWN_TRAILING_INSET: f32 = 16.;
    pub const ASSISTANT_TRAILING_INSET: f32 = 62.;
    pub const ASSISTANT_PADDING_Y: f32 = 4.;
    pub const USER_MAX_WIDTH: f32 = 0.68;
    pub const MEDIA_IMAGE_MAX: f32 = 400.;
    pub const MEDIA_IMAGE_RADIUS: f32 = 25.;
    pub const REPLY_RADIUS: f32 = 15.;
    pub const REPLY_ICON: f32 = 14.;
    pub const REPLY_GAP: f32 = 9.;
    pub const REPLY_LINE_HEIGHT: f32 = 1.55;
    pub const REPLY_PADDING_Y: f32 = 7.;
    pub const REPLY_PADDING_LEFT: f32 = 12.;
    pub const REPLY_PADDING_RIGHT: f32 = 10.;
    pub const REPLY_MIN_HEIGHT: f32 = 36.;
    pub const REPLY_MARGIN_BOTTOM: f32 = 2.;
    pub const ATTRIBUTION_GAP: f32 = 5.;
    pub const ATTRIBUTION_MARGIN_BOTTOM: f32 = 4.;
    pub const DETAIL_WIDTH: f32 = 380.;
    pub const COPY_FEEDBACK_MS: u64 = 1500;
    pub const COPY_FAILURE_MS: u64 = 2000;

    pub fn sender_label(hue: u16, dark: bool) -> Hsla {
        hsla(
            f32::from(hue) / 360.,
            if dark { 0.45 } else { 0.60 },
            if dark { 0.70 } else { 0.36 },
            1.,
        )
    }

    pub fn reply_fill(p: Palette) -> Hsla {
        Hsla {
            a: 0.04,
            ..p.strong
        }
    }
    pub fn reply_border(p: Palette) -> Hsla {
        Hsla {
            a: 0.10,
            ..p.strong
        }
    }

    pub fn sender_bubble(p: Palette, hue: u16, dark: bool) -> Hsla {
        let hue = f32::from(hue) / 360.;
        if dark {
            p.bg.blend(hsla(hue, 0.48, 0.42, 0.16))
        } else {
            hsla(hue, 0.65, 0.94, 1.)
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

/// Transcript Markdown measurements from chat/text.css and markdown-code-blocks.ts.
pub(super) struct MarkdownTokens;
impl MarkdownTokens {
    pub const BODY: f32 = 14.;
    pub const LINE: f32 = 21.;
    pub const PARAGRAPH_REM: f32 = 0.875;
    pub const TABLE_TEXT: f32 = 13.;
    pub const TABLE_LINE: f32 = 19.5;
    pub const CELL_PAD: f32 = 12.;
    pub const CODE_BORDER: f32 = 1.;
    pub const CODE_BORDER_ALPHA: f32 = 0.22;
    pub const TABLE_BORDER_ALPHA: f32 = 0.42;
    pub const TASK_ACCENT_ALPHA: f32 = 0.72;
    pub const CODE_TEXT: f32 = 12.;
    pub const CODE_LINE: f32 = 18.;
    pub const CODE_HEADER: f32 = 36.;
    pub const CODE_LABEL: f32 = 11.;
    pub const CODE_PAD: f32 = 14.;
    pub const RADIUS: f32 = 8.;
    pub const SMALL_RADIUS: f32 = 6.;
    pub const CODE_RADIUS: f32 = 17.5;
    pub const IMAGE_RADIUS: f32 = 10.;
    pub const IMAGE_ACTION_HEIGHT: f32 = 28.;
    pub const IMAGE_ACTION_PAD_X: f32 = 9.;
    pub const IMAGE_ACTION_PAD_Y: f32 = 3.;
    pub const IMAGE_ACTION_ALPHA: f32 = 0.08;
    pub const CONTROL: f32 = 32.;
    pub const ICON: f32 = 14.;
    pub const GAP: f32 = 8.;
    pub const QUOTE_PAD_X: f32 = 12.;
    pub const QUOTE_PAD_Y: f32 = 8.;
    pub const QUOTE_BAR: f32 = 3.;
    pub const QUOTE_INSET: f32 = 4.;
    pub const TASK: f32 = 16.;
    pub const TASK_RADIUS: f32 = 6.;
    pub const TASK_GAP: f32 = 8.;
    pub const LIST_GAP: f32 = 5.6;
    pub const IMAGE_PAD_X: f32 = 11.2;
    pub const IMAGE_PAD_Y: f32 = 9.8;
    pub const IMAGE_MAX_HEIGHT: f32 = 400.;
    pub const USER_PREVIEW: f32 = 105.;
    pub const DISCLOSURE_GAP: f32 = 8.;
    pub const DISCLOSURE_OFFSET: f32 = 6.;
    pub const DISCLOSURE_HEIGHT: f32 = 14.;
    pub const DISCLOSURE_TEXT: f32 = 12.;
    pub const JSON_LINE: f32 = 20.4;
    pub const JSON_INDENT: f32 = 20.;
    pub const JSON_HEIGHT: f32 = 360.;
    pub const JSON_PAD_TOP: f32 = 6.;
    pub const JSON_PAD_BOTTOM: f32 = 16.;
    pub const DIALOG_WIDTH: f32 = 1000.;
    pub const DIALOG_HEIGHT: f32 = 600.;

    pub fn syntax(dark: bool) -> std::sync::Arc<gpui_kit::component::highlighter::HighlightTheme> {
        use gpui_kit::component::highlighter::{HighlightTheme, ThemeStyle};
        use std::sync::{Arc, OnceLock};
        static DARK: OnceLock<Arc<HighlightTheme>> = OnceLock::new();
        static LIGHT: OnceLock<Arc<HighlightTheme>> = OnceLock::new();
        (if dark { &DARK } else { &LIGHT })
            .get_or_init(|| {
                let mut theme = if dark {
                    (*HighlightTheme::default_dark()).clone()
                } else {
                    (*HighlightTheme::default_light()).clone()
                };
                // These are the Control UI's --hljs-* roles, mapped onto the native grammar.
                let colors = if dark {
                    [
                        "#ff8a80", "#79c0ff", "#a5d6ff", "#d2a8ff", "#ffa657", "#7ee787", "#8b8b94",
                    ]
                } else {
                    [
                        "#cf222e", "#0550ae", "#0a3069", "#8250df", "#953800", "#116329", "#6e6960",
                    ]
                };
                let [keyword, number, string, title, kind, attribute, muted] =
                    colors.map(|color| {
                        Some(
                            serde_json::from_value::<ThemeStyle>(
                                serde_json::json!({"color": color}),
                            )
                            .expect("syntax color token"),
                        )
                    });
                let syntax = &mut theme.style.syntax;
                syntax.keyword = keyword;
                syntax.number = number;
                syntax.boolean = number;
                syntax.string = string;
                syntax.string_escape = string;
                syntax.function = title;
                syntax.type_ = kind;
                syntax.constructor = kind;
                syntax.attribute = attribute;
                syntax.property = attribute;
                syntax.variable = attribute;
                syntax.comment = muted;
                Arc::new(theme)
            })
            .clone()
    }
}

/// Control UI reasoning, tool-card and working-indicator measurements.
pub(super) struct ToolTokens;
impl ToolTokens {
    pub const ROW_FONT: f32 = 13.;
    pub const SMALL_FONT: f32 = 12.;
    pub const OUTCOME_FONT: f32 = 11.;
    pub const CODE_LINE: f32 = 18.;
    pub const REASONING_LINE: f32 = 16.8;
    pub const ROW_LINE: f32 = 19.5;
    pub const ROW_PADDING: f32 = 3.;
    pub const INLINE_PADDING: f32 = 4.;
    pub const GAP: f32 = 6.;
    pub const ROW_GAP: f32 = 7.;
    pub const BLOCK_GAP: f32 = 8.;
    pub const BODY_X: f32 = 12.;
    pub const BODY_Y: f32 = 10.;
    pub const OUTCOME_X: f32 = 14.;
    pub const RADIUS: f32 = 8.;
    pub const ICON: f32 = 14.;
    pub const CLAW: f32 = 18.;
    pub const WORKING_HEIGHT: f32 = 28.;
    pub const DIFF_GUTTER: f32 = 32.;
    pub const OUTPUT_HEIGHT: f32 = 420.;
    pub const TINT: f32 = 0.08;
    pub const REASONING_TINT: f32 = 0.04;
    pub const REASONING_BORDER: f32 = 0.18;
}

/// Control UI transcript notice, welcome, and scroll affordance measurements.
pub(super) struct TranscriptSurfaceTokens;
impl TranscriptSurfaceTokens {
    pub const WIDTH: f32 = 768.;
    pub const INSET: f32 = 24.;
    pub const NOTICE_WIDTH: f32 = 560.;
    pub const NOTICE_GAP: f32 = 7.;
    pub const NOTICE_MARGIN: f32 = 14.;
    pub const SMALL_TEXT: f32 = 12.;
    pub const BODY_TEXT: f32 = 13.;
    pub const RULE_GAP: f32 = 10.;
    pub const RULE_WIDTH: f32 = 1.;
    pub const GLYPH_SIZE: f32 = 28.;
    pub const GLYPH_ICON: f32 = 20.;
    pub const COMPACTION_CHECK_INSET: f32 = 4.;
    pub const COMPACTION_LINE_LEFT: f32 = 1.;
    pub const COMPACTION_LINE_HEIGHT: f32 = 2.;
    pub const COMPACTION_FOLD_X: f32 = 3.;
    pub const COMPACTION_OPEN_OPACITY: f32 = 0.38;
    pub const COMPACTION_CYCLE_MS: u64 = 3200;
    pub const COMPACTION_PHASES: [f32; 4] = [0.12, 0.48, 0.70, 0.86];
    // Top, width, folded y offset, folded x scale and folded opacity.
    pub const COMPACTION_LINES: [(f32, f32, f32, f32, f32); 5] = [
        (3., 26., 6., 0.65, 0.85),
        (8., 20., 1., 0.85, 0.),
        (13., 24., 0., 0.7, 1.),
        (18., 16., -1., 1.05, 0.),
        (23., 22., -6., 0.76, 0.85),
    ];
    pub const SCROLL_SIZE: f32 = 36.;
    pub const SCROLL_ICON: f32 = 16.;
    pub const SCROLL_OFFSET: f32 = 12.;
    pub const SCROLL_PAGE_FRACTION: f32 = 0.9;
    pub const ERROR_WIDTH: f32 = 576.;
    pub const ERROR_BORDER_ALPHA: f32 = 0.32;
    pub const ERROR_FILL_ALPHA: f32 = 0.09;
    pub const ERROR_RADIUS: f32 = 17.5;
    pub const ERROR_INSET_X: f32 = 14.;
    pub const ERROR_INSET_Y: f32 = 10.;
    pub const ERROR_DETAILS_HEIGHT: f32 = 256.;
    pub const WELCOME_WIDTH: f32 = 640.;
    pub const WELCOME_AVATAR: f32 = 96.;
    pub const WELCOME_TITLE: f32 = 24.;
    pub const WELCOME_GAP: f32 = 18.;
    pub const RECENTS_WIDTH: f32 = 520.;
    pub const RECENT_HEIGHT: f32 = 40.;
    pub const RECENT_RADIUS: f32 = 12.5;
}
