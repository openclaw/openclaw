//! Measured Control UI presentation values. Layout widgets consume these tokens;
//! Gateway policy, cache limits, and generated avatar identity remain with their owners.
use gpui_kit::*;

pub mod colors;
pub mod conversation;
pub mod primitives;
pub mod shell;
pub mod transcript;

#[derive(Clone, Copy)]
pub struct Typography {
    pub size: Pixels,
    pub line_height: Pixels,
    pub weight: FontWeight,
}
impl Typography {
    const fn new(size: f32, line_height: f32, weight: FontWeight) -> Self {
        Self {
            size: px(size),
            line_height: px(line_height),
            weight,
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
    use super::{Rems, Typography, primitives, rems, weight};
    pub const WIDGET_XS_SIZE: Rems = rems(primitives::rem::MD);
    pub const WIDGET_SM_SIZE: Rems = rems(0.875);
    pub const WIDGET_LG_SIZE: Rems = rems(1.125);
    pub const WIDGET_XL_SIZE: Rems = rems(primitives::rem::ROOMY);
    pub const BODY: Typography = Typography::new(primitives::text::BODY, 21.7, weight::NORMAL);
    pub const NAV: Typography = Typography::new(primitives::text::ROW, 20.15, weight::MEDIUM);
    pub const MENU: Typography = Typography::new(primitives::text::ROW, 20.15, weight::NORMAL);
    pub const SESSION: Typography = Typography::new(primitives::text::ROW, 18., weight::MEDIUM);
    pub const SESSION_TEAM: Typography = Typography::new(primitives::text::ROW, 18., weight::BOOK);
    pub const CAPTION: Typography = Typography::new(primitives::text::CAPTION, 18., weight::NORMAL);
    pub const SMALL: Typography = Typography::new(primitives::text::SMALL, 18., weight::NORMAL);
    pub const COUNT: Typography = Typography::new(primitives::text::META, 15.5, weight::NORMAL);
    pub const CATEGORY: Typography =
        Typography::new(primitives::text::CAPTION, 17.05, weight::SEMIBOLD);
    pub const SECTION: Typography =
        Typography::new(primitives::text::CAPTION, 17.05, weight::HEADING);
    pub const AGENT_TITLE: Typography =
        Typography::new(primitives::text::BODY, 16.8, weight::HEADING);
    pub const AGENT_TILE: Typography =
        Typography::new(primitives::text::CAPTION, 13.75, weight::MEDIUM_STRONG);
    pub const AGENT_ROSTER: Typography =
        Typography::new(primitives::text::HEADING, 24.8, weight::HEADING);
    pub const IDENTITY: Typography = Typography::new(13.5, 18., weight::SEMIBOLD);
    pub const FOOTER_STATUS: Typography =
        Typography::new(primitives::text::CAPTION, 14., weight::NORMAL);
    pub const IDENTITY_MENU_NAME: Typography =
        Typography::new(primitives::text::ROW, 16.25, weight::MEDIUM);
    pub const IDENTITY_MENU_EMAIL: Typography =
        Typography::new(primitives::text::SMALL, 15., weight::NORMAL);
    pub const PERSON_CARD_NAME: Typography =
        Typography::new(primitives::text::BODY, 14., weight::SEMIBOLD);
    pub const PERSON_CARD_STATUS: Typography =
        Typography::new(primitives::text::SMALL, 12., weight::NORMAL);
    pub const PERSON_CARD_BODY: Typography = SMALL;
    pub const PERSON_CARD_LINK: Typography =
        Typography::new(primitives::text::SMALL, 18., weight::MEDIUM);
    pub const PERSON_CARD_AGE: Typography =
        Typography::new(primitives::text::CAPTION, 16.5, weight::NORMAL);
    pub const BUILD: Typography = Typography::new(10.5, 16.275, weight::NORMAL);
    pub const MONO_FAMILY: &str = "SF Mono";
    pub const UI_FAMILY: &str = "Instrument Sans";
    pub const FALLBACK_FAMILY: &str = ".SystemUIFont";
}

pub mod space {
    use super::*;
    pub const WIDGET_GAP: Rems = REM_XS;
    pub const WIDGET_INSET: Rems = REM_SM;
    pub const NONE: Pixels = px(0.);
    pub const HAIRLINE: Pixels = px(primitives::space::HAIRLINE);
    pub const XXS: Pixels = px(primitives::space::XXS);
    pub const TIGHT: Pixels = px(primitives::space::TIGHT);
    pub const XS: Pixels = px(primitives::space::XS);
    pub const SM: Pixels = px(primitives::space::SM);
    pub const MD: Pixels = px(primitives::space::MD);
    pub const LG: Pixels = px(primitives::space::LG);
    pub const XL: Pixels = px(primitives::space::XL);
    pub const XXL: Pixels = px(primitives::space::XXL);
    pub const WIDE: Pixels = px(primitives::space::WIDE);
    pub const CONTENT: Pixels = px(primitives::space::CONTENT);
    pub const REM_XS: Rems = rems(primitives::rem::XS);
    pub const REM_SM: Rems = rems(primitives::rem::SM);
    pub const REM_MD: Rems = rems(primitives::rem::MD);
    pub const REM_LG: Rems = rems(primitives::rem::LG);
    pub const REM_XL: Rems = rems(primitives::rem::XL);
    pub const REM_XXL: Rems = rems(primitives::rem::XXL);
}
pub mod icon {
    use super::*;
    pub const DISCLOSURE: Pixels = px(primitives::icon::DISCLOSURE);
    pub const SECTION: Pixels = px(primitives::icon::SECTION);
    pub const SMALL: Pixels = px(primitives::icon::SMALL);
    pub const COMPACT: Pixels = px(primitives::icon::COMPACT);
    pub const ACTION: Pixels = px(primitives::icon::ACTION);
    pub const MENU: Pixels = px(primitives::icon::MENU);
    pub const NORMAL: Pixels = px(primitives::icon::NORMAL);
    pub const FOOTER: Pixels = px(primitives::icon::FOOTER);
    pub const LEADING: Pixels = px(primitives::icon::LEADING);
    pub const RUN_RING: Pixels = px(primitives::icon::RUN_RING);
    pub const DOT: Pixels = px(primitives::icon::DOT);
    pub const BADGE_BOX: Pixels = ACTION;
    pub const STROKE_WIDTH: f32 = 1.5;
}
pub mod radius {
    use super::*;
    pub const WIDGET_SM: Rems = rems(primitives::rem::XS);
    pub const WIDGET_MD: Rems = rems(0.375);
    pub const WIDGET_LG: Rems = rems(primitives::rem::SM);
    pub const WIDGET_XL: Rems = rems(primitives::rem::MD);
    pub const SMALL: Pixels = px(primitives::radius::SMALL);
    pub const CONTROL: Pixels = px(primitives::radius::CONTROL);
    pub const MENU_ITEM: Pixels = px(primitives::radius::MENU_ITEM);
    pub const PERSON: Pixels = px(primitives::radius::PERSON);
    pub const ROW: Pixels = px(primitives::radius::ROW);
    pub const CARD: Pixels = px(primitives::radius::CARD);
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
    pub const INITIALS_WEIGHT: FontWeight = weight::BOLD;
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
    pub const RING_GAP: Pixels = space::XXS;
    pub const RING_OUTER: Pixels = space::XS;
    pub const WORKSPACE_GLYPH: Pixels = px(24.);
}
pub mod facepile {
    use super::*;
    pub const OVERLAP: Pixels = px(primitives::space::COMPACT);
    pub const LEADING_INSET: Pixels = space::HAIRLINE;
    pub const OVERFLOW_TEXT: Pixels = px(8.);
    pub const PARTICIPANT_OFFSET_X: Pixels = space::SM;
    pub const PARTICIPANT_OFFSET_Y: Pixels = px(-primitives::space::XXS);
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
        gap: space::MD,
        leading_width: icon::LEADING,
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
    pub const GAP: Pixels = space::XXS;
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
        padding: space::XS,
    };
    pub const IDENTITY: MenuMetrics = MenuMetrics {
        width: px(278.),
        max_height: px(600.),
        padding: space::SM,
    };
    pub const FILTER: MenuMetrics = MenuMetrics {
        width: px(300.),
        max_height: px(450.),
        padding: space::XS,
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
    pub const ANCHOR_GAP: Pixels = space::LG;
    pub const VIEWPORT_MARGIN: Pixels = space::MD;
    pub const SEPARATOR_HEIGHT: Pixels = px(13.);
    pub const TITLE_HEIGHT: Pixels = px(31.05);
    pub const TITLE_PADDING: Insets = Insets::new(6., 8., 8., 8.);
    pub const IDENTITY_HORIZONTAL_OFFSET: Pixels = px(-primitives::space::MD);
    pub const HELP_LEFT: Pixels = px(258.);
    pub const HELP_TOP: Pixels = px(55.);
    pub const IDENTITY_HEADER_HEIGHT: Pixels = px(40.);
    pub const IDENTITY_FOOTER_HEIGHT: Pixels = px(28.);
    pub const NATIVE_PADDING: Pixels = space::XS;
    pub const NATIVE_ROW_GAP: Pixels = space::XXS;
    pub const IDENTITY_ROW_HEIGHT: Pixels = px(30.);
    pub const GATEWAY_STATUS_SIZE: Pixels = px(7.);
    pub const GATEWAY_CHECK_SIZE: Pixels = px(12.);
    // PopupMenu reserves its 12px icon plus 4px gap when Help has an icon.
    pub const IDENTITY_LABEL_INSET: Pixels = px(-18.);
    pub const IDENTITY_AVATAR_GAP: Pixels = px(3.);
    pub const IDENTITY_HELP_MIN_WIDTH: Pixels = px(160.);
    pub const IDENTITY_HELP_MAX_WIDTH: Pixels = px(220.);
}
pub mod header {
    use super::*;
    pub const WINDOW_HEIGHT: Pixels = px(44.);
    pub const AGENT_HEIGHT: Pixels = px(48.);
    pub const AGENT_TRIGGER_HEIGHT: Pixels = px(38.);
    pub const AGENT_NAME_GAP: Pixels = space::MD;
    pub const SECTION_HEIGHT: Pixels = px(24.);
    pub const SECTION_GAP: Pixels = space::XL;
    pub const ROSTER_HEIGHT: Pixels = px(48.);
    pub const ROSTER_BUTTON_HEIGHT: Pixels = px(44.);
    pub const ROSTER_CONTROL_GAP: Pixels = px(primitives::space::SEARCH);
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
    pub const PADDING: Pixels = space::LG;
    pub const DIVIDER: Pixels = space::HAIRLINE;
    pub const RESIZE_HIT_WIDTH: Pixels = px(primitives::space::COMPACT);
    pub const RESIZE_HIT_OFFSET: Pixels = px(-primitives::space::XXS);
    pub const FOOTER_HEIGHT: Pixels = px(44.);
    pub const IDENTITY_TRIGGER_HEIGHT: Pixels = px(34.);
    pub const THREADS_INDENT: Pixels = px(36.);
    pub const FILTER_SUMMARY_MAX_WIDTH: Pixels = px(160.);
    pub const MORE_TOP: Pixels = px(primitives::space::COMPACT);
    pub const MORE_RIGHT: Pixels = space::MD;
    pub const REORDER_WIDTH: Pixels = px(24.);
}
pub mod card {
    use super::*;
    pub const WIDTH: Pixels = px(304.);
    pub const MAX_HEIGHT: Pixels = px(520.);
    pub const ANCHOR_GAP: Pixels = space::LG;
    pub const VIEWPORT_MARGIN: Pixels = space::XL;
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

pub mod weight {
    use super::FontWeight;
    pub const NORMAL: FontWeight = FontWeight::NORMAL;
    pub const MEDIUM: FontWeight = FontWeight::MEDIUM;
    pub const SEMIBOLD: FontWeight = FontWeight::SEMIBOLD;
    pub const BOLD: FontWeight = FontWeight::BOLD;
    pub const BOOK: FontWeight = FontWeight(450.);
    pub const MEDIUM_STRONG: FontWeight = FontWeight(550.);
    pub const HEADING: FontWeight = FontWeight(650.);
}

pub mod window {
    use super::*;
    pub const GATEWAY_SIZE: Size<Pixels> = Size {
        width: px(1200.),
        height: px(800.),
    };
    pub const GATEWAY_MIN_SIZE: Size<Pixels> = Size {
        width: px(720.),
        height: px(480.),
    };
    pub const MANAGER_SIZE: Size<Pixels> = Size {
        width: px(880.),
        height: px(700.),
    };
    pub const MANAGER_MIN_SIZE: Size<Pixels> = Size {
        width: px(780.),
        height: px(620.),
    };
}

pub mod dock {
    pub const MIN_WIDTH: f32 = 260.;
    pub const MAX_WIDTH: f32 = 1200.;
    pub const DEFAULT_WIDTH: f32 = 480.;
    pub const DIVIDER_WIDTH: f32 = super::primitives::space::SM;
    pub const CHROME_RESERVE: f32 = 312.;
    pub const BROWSER_SPLIT_MIN_WIDTH: f32 = 680.;
    pub const MAX_VIEWPORT_FRACTION: f64 = 0.6;
}
