//! Native window, connection, attention, and browser chrome geometry.
use gpui_kit::{Pixels, px};

pub const CHROME_BUTTON_SIZE: Pixels = px(28.);
pub const TAB_CLOSE_SIZE: Pixels = px(20.);
pub const OVERLAY_OPACITY: f32 = 0.72;
pub const QUESTION_SELECTED_BORDER_OPACITY: f32 = 0.4;

pub const TRANSCRIPT_OVERSCAN: Pixels = px(600.);
pub const TITLEBAR_RESERVED_WIDTH: Pixels = px(80.);
pub const TITLEBAR_COLLAPSED_WIDTH: Pixels = px(94.);
pub const TOAST_MAX_WIDTH: Pixels = px(420.);

pub const ATTENTION_HEIGHT_RATIO: f32 = 0.45;
pub const ATTENTION_MIN_HEIGHT: Pixels = px(180.);
pub const ATTENTION_MAX_HEIGHT: Pixels = px(360.);
pub const APPROVAL_DETAIL_MAX_HEIGHT: Pixels = px(100.);
pub const QUESTION_OPTION_MIN_HEIGHT: Pixels = px(44.);
pub const QUESTION_DESCRIPTION_LINE_HEIGHT: Pixels = px(17.);

pub const BROWSER_MODE_HEIGHT: Pixels = px(36.);
pub const BROWSER_TAB_HEIGHT: Pixels = px(34.);
pub const BROWSER_TAB_MIN_WIDTH: Pixels = px(72.);
pub const BROWSER_TAB_MAX_WIDTH: Pixels = px(180.);
pub const BROWSER_NEW_TAB_SIZE: Pixels = px(30.);
pub const BROWSER_TOOLBAR_HEIGHT: Pixels = px(40.);
pub const BROWSER_EMPTY_ICON_SIZE: Pixels = px(28.);

pub const CONNECT_MAX_WIDTH: Pixels = px(440.);
pub const CONNECT_FORM_GAP: Pixels = px(20.);
pub const CONNECT_LOGO_SIZE: Pixels = px(48.);
pub const CONNECT_LOGO_TEXT_SIZE: Pixels = px(30.);
pub const CONNECT_TITLE_SIZE: Pixels = px(26.);
pub const CONNECT_TAGLINE_HEIGHT: Pixels = px(22.);
pub const CONNECT_CREDENTIAL_GAP: Pixels = px(14.);
pub const CONNECT_NOTE_LINE_HEIGHT: Pixels = px(18.);
pub const CONNECT_BODY_LINE_HEIGHT: Pixels = px(20.);
pub const CONNECT_BUTTON_HEIGHT: Pixels = px(40.);
pub const GATEWAY_LIST_WIDTH: Pixels = px(310.);

pub const PALETTE_TOP: Pixels = px(88.);
pub const PALETTE_WIDTH: Pixels = px(580.);
pub const PALETTE_WIDTH_RATIO: f32 = 0.9;
pub const PALETTE_HEIGHT: Pixels = px(410.);
pub const PALETTE_RESULTS_MAX_HEIGHT: Pixels = px(350.);

pub const DOCK_STRIP_HEIGHT: Pixels = px(38.);
pub const PANEL_PICKER_MAX_HEIGHT: Pixels = px(540.);
pub const PANEL_PICKER_TOP: Pixels = px(48.);
pub const PANEL_PICKER_WIDTH: Pixels = px(280.);

pub const BROWSER_SCROLL_LINE_PIXELS: f32 = 24.;
