//! Composer and transcript metrics, retaining the existing pixel and rem units.
use super::{primitives, space};
use gpui_kit::{Pixels, px};

pub const CONTENT_WIDTH: f32 = 768.;
pub const MAX_WIDTH: Pixels = px(CONTENT_WIDTH);
pub const COMPOSER_HEIGHT: f32 = 112.;
pub const COMPOSER_MIN_HEIGHT: Pixels = px(COMPOSER_HEIGHT);
pub const COMPOSER_RADIUS: Pixels = px(primitives::radius::COMPOSER);
pub const COMPOSER_INSET: Pixels = px(primitives::space::INSET);
pub const EDITOR_TEXT_SIZE: Pixels = px(primitives::text::HEADING);
pub const COMPOSER_BUTTON_SIZE: Pixels = space::CONTENT;
pub const ATTACHMENT_SIZE: Pixels = px(56.);
pub const COMPOSER_ATTACHMENT_PREVIEW: Pixels = px(48.);
pub const ATTACHMENT_LABEL_MAX_WIDTH: Pixels = px(160.);
pub const SLASH_MENU_MAX_HEIGHT: Pixels = px(320.);
pub const SLASH_ROW_HEIGHT: Pixels = px(44.);
pub const SLASH_LINE_HEIGHT: Pixels = px(primitives::text::HEADING);
pub const USAGE_PANEL_WIDTH: Pixels = px(240.);
pub const USAGE_RING_RADIUS: Pixels = px(primitives::space::SEARCH);

pub const CODE_FONT_FAMILY: &str = "monospace";

pub const fn heading_scale(level: u8) -> f32 {
    match level {
        1 => 2.,
        2 => 1.5,
        3 => 1.17,
        4 => 1.,
        5 => 0.83,
        _ => 0.67,
    }
}
