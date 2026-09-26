//! Measured Control UI presentation values. Layout widgets consume these tokens;
//! Gateway policy, cache limits, and generated avatar identity remain with their owners.
use gpui_kit::*;

pub mod colors;

#[derive(Clone, Copy)]
pub struct Typography {
    pub size: Pixels,
    pub line_height: Pixels,
    pub weight: FontWeight,
}
impl Typography {
    const fn new(size: f32, line_height: f32, weight: f32) -> Self {
        Self {
            size: px(size),
            line_height: px(line_height),
            weight: FontWeight(weight),
        }
    }
}
pub trait TypographyExt: Styled + Sized {
    fn typography(self, token: Typography) -> Self {
        self.text_size(token.size)
            .line_height(token.line_height)
            .font_weight(token.weight)
    }
}
impl<T: Styled> TypographyExt for T {}

pub mod text {
    use super::{Rems, Typography, rems};
    pub const WIDGET_XS_SIZE: Rems = rems(0.75);
    pub const BODY: Typography = Typography::new(14., 21.7, 400.);
    pub const NAV: Typography = Typography::new(13., 20.15, 500.);
    pub const MENU: Typography = Typography::new(13., 20.15, 400.);
    pub const SESSION: Typography = Typography::new(13., 18., 500.);
    pub const SESSION_TEAM: Typography = Typography::new(13., 18., 450.);
    pub const CAPTION: Typography = Typography::new(11., 18., 400.);
    pub const SMALL: Typography = Typography::new(12., 18., 400.);
    pub const COUNT: Typography = Typography::new(10., 15.5, 400.);
    pub const CATEGORY: Typography = Typography::new(11., 17.05, 600.);
    pub const SECTION: Typography = Typography::new(11., 17.05, 650.);
    pub const AGENT_TITLE: Typography = Typography::new(14., 16.8, 650.);
    pub const AGENT_TILE: Typography = Typography::new(11., 13.75, 550.);
    pub const AGENT_ROSTER: Typography = Typography::new(16., 24.8, 650.);
    pub const IDENTITY: Typography = Typography::new(13.5, 18., 600.);
    pub const FOOTER_STATUS: Typography = Typography::new(11., 14., 400.);
    pub const IDENTITY_MENU_NAME: Typography = Typography::new(13., 16.25, 500.);
    pub const IDENTITY_MENU_EMAIL: Typography = Typography::new(12., 15., 400.);
    pub const PERSON_CARD_NAME: Typography = Typography::new(14., 14., 600.);
    pub const PERSON_CARD_STATUS: Typography = Typography::new(12., 12., 400.);
    pub const PERSON_CARD_BODY: Typography = SMALL;
    pub const PERSON_CARD_LINK: Typography = Typography::new(12., 18., 500.);
    pub const PERSON_CARD_AGE: Typography = Typography::new(11., 16.5, 400.);
    pub const BUILD: Typography = Typography::new(10.5, 16.275, 400.);
    pub const MONO_FAMILY: &str = "SF Mono";
    pub const UI_FAMILY: &str = "Instrument Sans";
    pub const FALLBACK_FAMILY: &str = ".SystemUIFont";
}

pub mod space {
    use super::*;
    pub const WIDGET_GAP: Rems = rems(0.25);
    pub const WIDGET_INSET: Rems = rems(0.5);
    pub const NONE: Pixels = px(0.);
    pub const HAIRLINE: Pixels = px(1.);
    pub const XXS: Pixels = px(2.);
    pub const TIGHT: Pixels = px(3.);
    pub const XS: Pixels = px(4.);
    pub const SM: Pixels = px(6.);
    pub const MD: Pixels = px(8.);
    pub const LG: Pixels = px(10.);
    pub const XL: Pixels = px(12.);
    pub const XXL: Pixels = px(16.);
    pub const WIDE: Pixels = px(24.);
    pub const CONTENT: Pixels = px(32.);
}
pub mod icon {
    use super::*;
    pub const DISCLOSURE: Pixels = px(10.);
    pub const SECTION: Pixels = px(11.);
    pub const SMALL: Pixels = px(12.);
    pub const COMPACT: Pixels = px(13.);
    pub const ACTION: Pixels = px(14.);
    pub const MENU: Pixels = px(15.);
    pub const NORMAL: Pixels = px(16.);
    pub const FOOTER: Pixels = px(18.);
    pub const LEADING: Pixels = px(20.);
    pub const RUN_RING: Pixels = px(22.);
    pub const DOT: Pixels = px(6.);
    pub const BADGE_BOX: Pixels = px(14.);
    pub const STROKE_WIDTH: f32 = 1.5;
}
pub mod radius {
    use super::*;
    pub const WIDGET_MD: Rems = rems(0.375);
    pub const SMALL: Pixels = px(6.);
    pub const CONTROL: Pixels = px(8.);
    pub const MENU_ITEM: Pixels = px(8.5);
    pub const PERSON: Pixels = px(10.);
    pub const ROW: Pixels = px(12.5);
    pub const CARD: Pixels = px(14.);
}
#[derive(Clone, Copy)]
pub struct Insets {
    pub top: Pixels,
    pub right: Pixels,
    pub bottom: Pixels,
    pub left: Pixels,
}
impl Insets {
    pub const fn new(top: f32, right: f32, bottom: f32, left: f32) -> Self {
        Self {
            top: px(top),
            right: px(right),
            bottom: px(bottom),
            left: px(left),
        }
    }
}
pub trait InsetsExt: Styled + Sized {
    fn insets(self, insets: Insets) -> Self {
        self.pt(insets.top)
            .pr(insets.right)
            .pb(insets.bottom)
            .pl(insets.left)
    }
}
impl<T: Styled> InsetsExt for T {}

#[derive(Clone, Copy)]
pub struct AvatarMetrics {
    pub diameter: Pixels,
    pub text_size: Pixels,
    pub border: Pixels,
}
impl AvatarMetrics {
    const fn new(diameter: f32, text_size: f32, border: f32) -> Self {
        Self {
            diameter: px(diameter),
            text_size: px(text_size),
            border: px(border),
        }
    }
}
pub mod avatar {
    use super::*;
    pub const INITIALS_WEIGHT: FontWeight = FontWeight::BOLD;
    pub const SESSION: AvatarMetrics = AvatarMetrics::new(18., 7., 1.);
    pub const PERSON_SECTION: AvatarMetrics = SESSION;
    pub const PERSON: AvatarMetrics = AvatarMetrics::new(20., 8., 1.);
    pub const IDENTITY: AvatarMetrics = AvatarMetrics::new(28., 10., 1.);
    pub const IDENTITY_MENU: AvatarMetrics = AvatarMetrics::new(26., 10.4, 1.);
    pub const DRAFT_IDENTITY: AvatarMetrics = AvatarMetrics::new(20., 14.4, 0.);
    pub const AGENT_HEADER: AvatarMetrics = AvatarMetrics::new(28., 19., 0.);
    pub const AGENT_TILE: AvatarMetrics = AvatarMetrics::new(48., 25., 0.);
    pub const AGENT_ROSTER: AvatarMetrics = AvatarMetrics::new(36., 25.92, 0.);
    pub const PERSON_CARD: AvatarMetrics = AvatarMetrics::new(34.5, 12., 1.);
    pub const FALLBACK_TEXT_RATIO: f32 = 0.4;
    pub const SESSION_ICON_RATIO: f32 = 0.8;
    pub const RING_GAP: Pixels = px(2.);
    pub const RING_OUTER: Pixels = px(4.);
    pub const WORKSPACE_GLYPH: Pixels = px(24.);
}
pub mod facepile {
    use super::*;
    pub const OVERLAP: Pixels = px(5.);
    pub const LEADING_INSET: Pixels = px(1.);
    pub const OVERFLOW_TEXT: Pixels = px(8.);
    pub const PARTICIPANT_OFFSET_X: Pixels = px(6.);
    pub const PARTICIPANT_OFFSET_Y: Pixels = px(-2.);
}
#[derive(Clone, Copy)]
pub struct RowMetrics {
    pub min_height: Pixels,
    pub padding: Insets,
    pub gap: Pixels,
    pub leading_width: Pixels,
    pub radius: Pixels,
}
pub mod row {
    use super::*;
    pub const CHANNEL_MAX_WIDTH: Pixels = px(120.);
    pub const NAV: RowMetrics = RowMetrics {
        min_height: px(32.),
        padding: Insets::new(0., 8., 0., 8.),
        gap: px(8.),
        leading_width: px(20.),
        radius: radius::ROW,
    };
    pub const SESSION: RowMetrics = RowMetrics {
        min_height: px(30.),
        padding: Insets::new(4., 2., 4., 8.),
        ..NAV
    };
    pub const SESSION_TEAM: RowMetrics = RowMetrics {
        min_height: px(32.),
        padding: Insets::new(0., 0., 0., 24.),
        ..NAV
    };
    pub const PERSON: RowMetrics = RowMetrics {
        min_height: px(30.),
        radius: radius::PERSON,
        ..NAV
    };
    pub const GAP: Pixels = px(2.);
    pub const CHILD_INDENT: Pixels = px(22.);
    pub const TEAM_CHILD_INDENT: Pixels = px(16.);
    pub const RENAME_HEIGHT: Pixels = px(28.);
    pub const CHILD_TOGGLE: Pixels = px(24.);
    pub const CHILD_TOGGLE_HEIGHT: Pixels = px(22.);
    pub const HOVER_ACTIONS_WITH_CHILDREN_RIGHT: Pixels = px(28.);
    pub const SHOW_MORE_HEIGHT: Pixels = px(25.);
}
#[derive(Clone, Copy)]
pub struct IconButtonMetrics {
    pub size: Pixels,
    pub icon: Pixels,
}
pub mod icon_button {
    use super::*;
    pub const COMPACT: IconButtonMetrics = IconButtonMetrics {
        size: px(22.),
        icon: icon::ACTION,
    };
    pub const ROW: IconButtonMetrics = IconButtonMetrics {
        size: px(24.),
        icon: icon::ACTION,
    };
    pub const SECTION: IconButtonMetrics = IconButtonMetrics {
        size: px(24.),
        icon: icon::SMALL,
    };
    pub const FOOTER: IconButtonMetrics = IconButtonMetrics {
        size: px(32.),
        icon: icon::FOOTER,
    };
    pub const IDENTITY: IconButtonMetrics = IconButtonMetrics {
        size: px(26.),
        icon: icon::NORMAL,
    };
}
#[derive(Clone, Copy)]
pub struct MenuMetrics {
    pub width: Pixels,
    pub max_height: Pixels,
    pub padding: Pixels,
}
pub mod menu {
    use super::*;
    pub const SESSION_MIN_WIDTH: Pixels = px(230.);
    pub const SESSION_MAX_WIDTH: Pixels = px(320.);
    pub const STANDARD: MenuMetrics = MenuMetrics {
        width: px(224.),
        max_height: px(420.),
        padding: px(4.),
    };
    pub const IDENTITY: MenuMetrics = MenuMetrics {
        width: px(278.),
        max_height: px(600.),
        padding: px(6.),
    };
    pub const FILTER: MenuMetrics = MenuMetrics {
        width: px(300.),
        max_height: px(450.),
        padding: px(4.),
    };
    pub const AGENT: MenuMetrics = MenuMetrics {
        width: px(264.),
        ..STANDARD
    };
    pub const HELP: MenuMetrics = MenuMetrics {
        width: px(167.875),
        ..STANDARD
    };
    pub const MAX_STANDARD_WIDTH: Pixels = px(264.);
    pub const ROW_HEIGHT: Pixels = px(28.);
    pub const ITEM_PADDING: Insets = Insets::new(0., 8., 0., 13.);
    pub const ICON_COLUMN: Pixels = px(24.);
    pub const ICON_GAP: Pixels = px(9.75);
    pub const ANCHOR_GAP: Pixels = px(10.);
    pub const VIEWPORT_MARGIN: Pixels = px(8.);
    pub const SEPARATOR_HEIGHT: Pixels = px(13.);
    pub const TITLE_HEIGHT: Pixels = px(31.05);
    pub const TITLE_PADDING: Insets = Insets::new(6., 8., 8., 8.);
    pub const IDENTITY_HORIZONTAL_OFFSET: Pixels = px(-8.);
    pub const HELP_LEFT: Pixels = px(258.);
    pub const HELP_TOP: Pixels = px(55.);
    pub const IDENTITY_HEADER_HEIGHT: Pixels = px(40.);
    pub const IDENTITY_FOOTER_HEIGHT: Pixels = px(28.);
    pub const NATIVE_PADDING: Pixels = px(4.);
    pub const NATIVE_ROW_GAP: Pixels = px(2.);
    pub const IDENTITY_ROW_HEIGHT: Pixels = px(30.);
    pub const IDENTITY_LABEL_INSET: Pixels = px(-2.);
    pub const IDENTITY_HELP_MIN_WIDTH: Pixels = px(160.);
    pub const IDENTITY_HELP_MAX_WIDTH: Pixels = px(220.);
}
pub mod header {
    use super::*;
    pub const WINDOW_HEIGHT: Pixels = px(44.);
    pub const AGENT_HEIGHT: Pixels = px(48.);
    pub const AGENT_TRIGGER_HEIGHT: Pixels = px(38.);
    pub const AGENT_NAME_GAP: Pixels = px(8.);
    pub const SECTION_HEIGHT: Pixels = px(24.);
    pub const SECTION_GAP: Pixels = px(12.);
    pub const ROSTER_HEIGHT: Pixels = px(48.);
    pub const ROSTER_BUTTON_HEIGHT: Pixels = px(44.);
    pub const ROSTER_CONTROL_GAP: Pixels = px(7.);
    pub const AGENT_TILE_WIDTH: Pixels = px(82.);
    pub const AGENT_TILE_HEIGHT: Pixels = px(104.);
    pub const AGENT_TILE_LABEL_HEIGHT: Pixels = px(30.);
    pub const AGENT_GRID_MAX_HEIGHT: Pixels = px(212.);
    pub const ONLINE_TRACKING: Pixels = px(0.88);
}
pub mod sidebar {
    use super::*;
    pub const DEFAULT_WIDTH: Pixels = px(258.);
    pub const MIN_WIDTH: Pixels = px(240.);
    pub const MAX_WIDTH: Pixels = px(400.);
    pub const PADDING: Pixels = px(10.);
    pub const DIVIDER: Pixels = px(1.);
    pub const RESIZE_HIT_WIDTH: Pixels = px(5.);
    pub const RESIZE_HIT_OFFSET: Pixels = px(-2.);
    pub const FOOTER_HEIGHT: Pixels = px(44.);
    pub const IDENTITY_TRIGGER_HEIGHT: Pixels = px(34.);
    pub const THREADS_INDENT: Pixels = px(36.);
    pub const FILTER_SUMMARY_MAX_WIDTH: Pixels = px(160.);
    pub const MORE_TOP: Pixels = px(5.);
    pub const MORE_RIGHT: Pixels = px(8.);
    pub const REORDER_WIDTH: Pixels = px(24.);
}
pub mod card {
    use super::*;
    pub const WIDTH: Pixels = px(304.);
    pub const MAX_HEIGHT: Pixels = px(520.);
    pub const ANCHOR_GAP: Pixels = px(10.);
    pub const VIEWPORT_MARGIN: Pixels = px(12.);
    pub const HEADER_PADDING: Insets = Insets::new(15., 16., 12., 16.);
    pub const SECTION_PADDING: Insets = Insets::new(12., 16., 12., 16.);
    pub const FACT_LABEL_WIDTH: Pixels = px(80.);
    pub const FOOTER_MIN_HEIGHT: Pixels = px(37.);
}
pub mod opacity {
    pub const HIDDEN: f32 = 0.;
    pub const VISIBLE: f32 = 1.;
    pub const DISABLED: f32 = 0.5;
    pub const IDLE: f32 = 0.45;
    pub const NAV_ICON: f32 = 0.72;
    pub const DISCLOSURE: f32 = 0.75;
    pub const AGENT_INACTIVE: f32 = 0.55;
    pub const AGENT_HOVER: f32 = 0.85;
}
pub mod motion {
    use std::time::Duration;
    pub const AGENT_OPEN: Duration = Duration::from_millis(300);
    pub const AGENT_CLOSE: Duration = Duration::from_millis(200);
    pub const PERSON_OPEN: Duration = Duration::from_millis(450);
    pub const PERSON_CLOSE: Duration = Duration::from_millis(220);
    pub const TYPEAHEAD_RESET: Duration = Duration::from_secs(1);
}

pub mod dialog {
    use super::*;
    pub const OWNER_OPTIONS_MAX_HEIGHT: Pixels = px(360.);
}
