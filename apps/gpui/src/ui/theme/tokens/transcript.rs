//! Measured transcript presentation; shared primitives stay in the central scale.
use super::{conversation, primitives as scale};
use crate::ui::theme::Palette;
use gpui_kit::*;

/// Computed Control UI transcript geometry (default 1.25 corner scale).
pub(crate) struct TranscriptTokens;
impl TranscriptTokens {
    pub const AVATAR: f32 = 36.;
    pub const AVATAR_GAP: f32 = 10.;
    pub const AVATAR_INITIALS_SIZE: f32 = scale::text::SMALL;
    pub const AVATAR_TEXT_SIZE: f32 = scale::text::ROW;
    pub const BUBBLE_RADIUS: f32 = scale::radius::MODEL_MENU;
    pub const BUBBLE_PADDING_X: f32 = scale::space::XXL;
    pub const BUBBLE_PADDING_Y: f32 = scale::space::XXL;
    pub const FOOTER_HEIGHT: f32 = 24.;
    pub const FOOTER_GAP: f32 = scale::space::MD;
    pub const MESSAGE_GAP: f32 = scale::space::XXS;
    pub const TURN_GAP: f32 = scale::space::XXS;
    pub const CONTINUATION_GAP: f32 = scale::space::SM;
    pub const FIRST_TURN_INSET: f32 = 28.;
    pub const TEXT_SIZE: f32 = scale::text::BODY;
    pub const META_SIZE: f32 = scale::text::SMALL;
    pub const LINE_HEIGHT: f32 = 1.5;
    pub const ROW_INSET: f32 = scale::space::XS;
    pub const OWN_TRAILING_INSET: f32 = scale::space::XXL;
    pub const ASSISTANT_TRAILING_INSET: f32 = 62.;
    pub const ASSISTANT_PADDING_Y: f32 = scale::space::XS;
    pub const USER_MAX_WIDTH: f32 = 0.68;
    pub const MEDIA_IMAGE_MAX: f32 = 400.;
    pub const MEDIA_IMAGE_RADIUS: f32 = 25.;
    pub const REPLY_RADIUS: f32 = 15.;
    pub const REPLY_ICON: f32 = scale::icon::ACTION;
    pub const REPLY_GAP: f32 = scale::space::ROW;
    pub const REPLY_LINE_HEIGHT: f32 = 1.55;
    pub const REPLY_PADDING_Y: f32 = scale::space::SEARCH;
    pub const REPLY_PADDING_LEFT: f32 = scale::space::XL;
    pub const REPLY_PADDING_RIGHT: f32 = scale::space::LG;
    pub const REPLY_MIN_HEIGHT: f32 = 36.;
    pub const REPLY_MARGIN_BOTTOM: f32 = scale::space::XXS;
    pub const ATTRIBUTION_GAP: f32 = scale::space::COMPACT;
    pub const ATTRIBUTION_MARGIN_BOTTOM: f32 = scale::space::XS;
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

/// Transcript Markdown measurements from chat/text.css and markdown-code-blocks.ts.
pub(crate) struct MarkdownTokens;
impl MarkdownTokens {
    pub const BODY: f32 = scale::text::BODY;
    pub const LINE: f32 = 21.;
    pub const PARAGRAPH_REM: f32 = 0.875;
    pub const TABLE_TEXT: f32 = scale::text::ROW;
    pub const TABLE_LINE: f32 = 19.5;
    pub const CELL_PAD: f32 = scale::space::XL;
    pub const CODE_BORDER: f32 = scale::space::HAIRLINE;
    pub const CODE_BORDER_ALPHA: f32 = 0.22;
    pub const TABLE_BORDER_ALPHA: f32 = 0.42;
    pub const TASK_ACCENT_ALPHA: f32 = 0.72;
    pub const CODE_TEXT: f32 = scale::text::SMALL;
    pub const CODE_LINE: f32 = 18.;
    pub const CODE_HEADER: f32 = 36.;
    pub const CODE_LABEL: f32 = scale::text::CAPTION;
    pub const CODE_PAD: f32 = scale::space::INSET;
    pub const RADIUS: f32 = scale::radius::CONTROL;
    pub const SMALL_RADIUS: f32 = scale::radius::SMALL;
    pub const CODE_RADIUS: f32 = scale::radius::MODEL_MENU;
    pub const IMAGE_RADIUS: f32 = scale::radius::PERSON;
    pub const IMAGE_ACTION_HEIGHT: f32 = 28.;
    pub const IMAGE_ACTION_PAD_X: f32 = scale::space::ROW;
    pub const IMAGE_ACTION_PAD_Y: f32 = scale::space::TIGHT;
    pub const IMAGE_ACTION_ALPHA: f32 = 0.08;
    pub const CONTROL: f32 = scale::space::CONTENT;
    pub const ICON: f32 = scale::icon::ACTION;
    pub const GAP: f32 = scale::space::MD;
    pub const QUOTE_PAD_X: f32 = scale::space::XL;
    pub const QUOTE_PAD_Y: f32 = scale::space::MD;
    pub const QUOTE_BAR: f32 = scale::space::TIGHT;
    pub const QUOTE_INSET: f32 = scale::space::XS;
    pub const TASK: f32 = scale::space::XXL;
    pub const TASK_RADIUS: f32 = scale::radius::SMALL;
    pub const TASK_GAP: f32 = scale::space::MD;
    pub const LIST_GAP: f32 = 5.6;
    pub const IMAGE_PAD_X: f32 = 11.2;
    pub const IMAGE_PAD_Y: f32 = 9.8;
    pub const IMAGE_MAX_HEIGHT: f32 = 400.;
    pub const USER_PREVIEW: f32 = 105.;
    pub const DISCLOSURE_GAP: f32 = scale::space::MD;
    pub const DISCLOSURE_OFFSET: f32 = scale::space::SM;
    pub const DISCLOSURE_HEIGHT: f32 = 14.;
    pub const DISCLOSURE_TEXT: f32 = scale::text::SMALL;
    pub const JSON_LINE: f32 = 20.4;
    pub const JSON_INDENT: f32 = 20.;
    pub const JSON_HEIGHT: f32 = 360.;
    pub const JSON_PAD_TOP: f32 = scale::space::SM;
    pub const JSON_PAD_BOTTOM: f32 = scale::space::XXL;
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
pub(crate) struct ToolTokens;
impl ToolTokens {
    pub const ROW_FONT: f32 = scale::text::ROW;
    pub const SMALL_FONT: f32 = scale::text::SMALL;
    pub const OUTCOME_FONT: f32 = scale::text::CAPTION;
    pub const CODE_LINE: f32 = 18.;
    pub const REASONING_LINE: f32 = 16.8;
    pub const ROW_LINE: f32 = 19.5;
    pub const ROW_PADDING: f32 = scale::space::TIGHT;
    pub const INLINE_PADDING: f32 = 4.;
    pub const GAP: f32 = scale::space::SM;
    pub const ROW_GAP: f32 = scale::space::SEARCH;
    pub const BLOCK_GAP: f32 = scale::space::MD;
    pub const BODY_X: f32 = scale::space::XL;
    pub const BODY_Y: f32 = scale::space::LG;
    pub const OUTCOME_X: f32 = scale::space::INSET;
    pub const RADIUS: f32 = scale::radius::CONTROL;
    pub const ICON: f32 = scale::icon::ACTION;
    pub const CLAW: f32 = scale::icon::FOOTER;
    pub const WORKING_HEIGHT: f32 = 28.;
    pub const DIFF_GUTTER: f32 = scale::space::CONTENT;
    pub const OUTPUT_HEIGHT: f32 = 420.;
    pub const TINT: f32 = 0.08;
    pub const REASONING_TINT: f32 = 0.04;
    pub const REASONING_BORDER: f32 = 0.18;
}

/// Control UI transcript notice, welcome, and scroll affordance measurements.
pub(crate) struct TranscriptSurfaceTokens;
impl TranscriptSurfaceTokens {
    pub const WIDTH: f32 = conversation::CONTENT_WIDTH;
    pub const INSET: f32 = scale::space::WIDE;
    pub const NOTICE_WIDTH: f32 = 560.;
    pub const NOTICE_GAP: f32 = scale::space::SEARCH;
    pub const NOTICE_MARGIN: f32 = scale::space::INSET;
    pub const SMALL_TEXT: f32 = scale::text::SMALL;
    pub const BODY_TEXT: f32 = scale::text::ROW;
    pub const RULE_GAP: f32 = scale::space::LG;
    pub const RULE_WIDTH: f32 = 1.;
    pub const GLYPH_SIZE: f32 = 28.;
    pub const GLYPH_ICON: f32 = scale::icon::LEADING;
    pub const COMPACTION_CHECK_INSET: f32 = scale::space::XS;
    pub const COMPACTION_LINE_LEFT: f32 = 1.;
    pub const COMPACTION_LINE_HEIGHT: f32 = 2.;
    pub const COMPACTION_FOLD_X: f32 = scale::space::TIGHT;
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
    pub const SCROLL_ICON: f32 = scale::icon::NORMAL;
    pub const SCROLL_OFFSET: f32 = scale::space::XL;
    pub const SCROLL_PAGE_FRACTION: f32 = 0.9;
    pub const ERROR_WIDTH: f32 = 576.;
    pub const ERROR_BORDER_ALPHA: f32 = 0.32;
    pub const ERROR_FILL_ALPHA: f32 = 0.09;
    pub const ERROR_RADIUS: f32 = scale::radius::MODEL_MENU;
    pub const ERROR_INSET_X: f32 = scale::space::INSET;
    pub const ERROR_INSET_Y: f32 = scale::space::LG;
    pub const ERROR_DETAILS_HEIGHT: f32 = 256.;
    pub const WELCOME_WIDTH: f32 = 640.;
    pub const WELCOME_AVATAR: f32 = 96.;
    pub const WELCOME_AVATAR_TEXT: f32 = 69.12;
    pub const WELCOME_TITLE: f32 = scale::text::TITLE;
    pub const WELCOME_GAP: f32 = scale::space::NOTICE;
    pub const RECENTS_WIDTH: f32 = 520.;
    pub const RECENT_HEIGHT: f32 = 40.;
    pub const RECENT_RADIUS: f32 = scale::radius::ROW;
}
