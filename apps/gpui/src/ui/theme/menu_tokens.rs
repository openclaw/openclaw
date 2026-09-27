use super::tokens::primitives::{icon, radius, space, text};
use gpui_kit::FontWeight;

// Control UI menu geometry: new-session.css, chat/composer.css and composer-surface.css.
pub const PANEL_RADIUS: f32 = radius::PANEL;
pub const SELECTION_PANEL_PADDING: f32 = space::COMPACT;
pub const SELECTION_PANEL_GAP: f32 = space::XXS;
pub const SELECTION_PANEL_MAX_HEIGHT: f32 = 360.;
pub const CAPABILITY_PANEL_PADDING: f32 = space::XS;
pub const CAPABILITY_PANEL_MAX_HEIGHT: f32 = 420.;
pub const CAPABILITY_ROOT_WIDTH: f32 = 208.;
pub const CAPABILITY_DETAIL_WIDTH: f32 = 272.;
pub const PERMISSION_PANEL_WIDTH: f32 = 340.;
pub const PERMISSION_PANEL_PADDING: f32 = space::MD;

pub const ROW_HEIGHT: f32 = 28.;
pub const ROW_PADDING_X: f32 = space::MD;
pub const ROW_TEXT_SIZE: f32 = text::SMALL;
pub const ROW_GAP: f32 = space::MD;
pub const ROW_CHECK_WIDTH: f32 = 20.;
pub const ICON_SIZE: f32 = icon::ACTION;
pub const DETAIL_TEXT_SIZE: f32 = text::CAPTION;
pub const INLINE_CHECK_WIDTH: f32 = 16.;

pub const HEADER_PADDING_TOP: f32 = space::XS;
pub const HEADER_PADDING_BOTTOM: f32 = space::XXS;
pub const HEADER_TEXT_SIZE: f32 = text::CAPTION;
pub const HEADER_WEIGHT: FontWeight = super::tokens::weight::SEMIBOLD;
pub const NOTE_PADDING_TOP: f32 = space::XS;
pub const NOTE_PADDING_BOTTOM: f32 = space::SM;
pub const NOTE_TEXT_SIZE: f32 = text::CAPTION;
pub const NOTE_LINE_HEIGHT: f32 = 15.4;
pub const FIELD_LABEL_WIDTH: f32 = 32.;
pub const FIELD_PADDING_Y: f32 = space::TIGHT;

pub const CAPABILITY_ROW_HEIGHT: f32 = 40.;
pub const CAPABILITY_ROW_PADDING_X: f32 = space::ROW;
pub const CAPABILITY_ROW_PADDING_Y: f32 = space::SM;
pub const CAPABILITY_ROW_RADIUS: f32 = radius::PERSON;
pub const CAPABILITY_ICON_SIZE: f32 = icon::NORMAL;
pub const CAPABILITY_COPY_GAP: f32 = space::TIGHT;
pub const CAPABILITY_TITLE_SIZE: f32 = text::ROW;
pub const CAPABILITY_TITLE_LINE_HEIGHT: f32 = 15.6;
pub const CAPABILITY_TITLE_WEIGHT: FontWeight = super::tokens::weight::SEMIBOLD;
pub const CAPABILITY_NOTE_SIZE: f32 = text::CAPTION;
pub const CAPABILITY_NOTE_LINE_HEIGHT: f32 = 13.75;
pub const CAPABILITY_STATE_PADDING_X: f32 = space::XL;
pub const CAPABILITY_STATE_PADDING_Y: f32 = space::LG;
pub const CAPABILITY_STATE_LINE_HEIGHT: f32 = 16.8;
pub const CAPABILITY_SUBROW_INDENT: f32 = 28.;
pub const BADGE_TEXT_SIZE: f32 = text::META;
pub const DIVIDER_HEIGHT: f32 = space::HAIRLINE;
pub const DIVIDER_MARGIN_X: f32 = space::SM;
pub const DIVIDER_MARGIN_Y: f32 = space::XS;
pub const TOGGLE_WIDTH: f32 = 26.;
pub const TOGGLE_HEIGHT: f32 = 15.;
pub const TOGGLE_INSET: f32 = space::XXS;
pub const TOGGLE_THUMB_SIZE: f32 = 11.;

pub const PLUS_BUTTON_SIZE: f32 = 28.;
pub const PLUS_ICON_SIZE: f32 = icon::LEADING;
pub const PERMISSION_HEADING_PADDING_BOTTOM: f32 = space::ROW;
pub const PERMISSION_HEADING_WEIGHT: FontWeight = super::tokens::weight::BOLD;
pub const PERMISSION_SHORTCUT_SIZE: f32 = text::TINY;
pub const PERMISSION_CHIP_HEIGHT: f32 = super::controls::CHIP_HEIGHT;
pub const PERMISSION_CHIP_GAP: f32 = super::controls::SPACE_SM;
pub const PERMISSION_CHIP_TEXT_SIZE: f32 = super::controls::TEXT_CHIP;
pub const PERMISSION_CHIP_LINE_HEIGHT: f32 = super::controls::CHIP_LINE_HEIGHT;

pub const CONNECTOR_DIALOG_WIDTH: f32 = 480.;
pub const LIBRARY_DIALOG_WIDTH: f32 = 960.;
pub const LIBRARY_PREVIEW_HEIGHT: f32 = 360.;
pub const FORM_GAP: f32 = space::XL;
pub const FORM_ACTION_GAP: f32 = space::MD;
pub const FORM_SEGMENT_GAP: f32 = space::XS;
pub const FORM_TEXT_SIZE: f32 = text::ROW;
