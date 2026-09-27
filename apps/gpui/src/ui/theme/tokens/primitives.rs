//! Scalar sources shared by measured f32 metrics and typed GPUI tokens.
//! Pixel and rem scales stay separate so font-relative spacing remains unchanged.

pub mod space {
    pub const HAIRLINE: f32 = 1.;
    pub const XXS: f32 = 2.;
    pub const TIGHT: f32 = 3.;
    pub const XS: f32 = 4.;
    pub const COMPACT: f32 = 5.;
    pub const SM: f32 = 6.;
    pub const SEARCH: f32 = 7.;
    pub const MD: f32 = 8.;
    pub const ROW: f32 = 9.;
    pub const LG: f32 = 10.;
    pub const SECTION: f32 = 11.;
    pub const XL: f32 = 12.;
    pub const INSET: f32 = 14.;
    pub const XXL: f32 = 16.;
    pub const NOTICE: f32 = 18.;
    pub const WIDE: f32 = 24.;
    pub const CONTENT: f32 = 32.;
}

pub mod icon {
    pub const DISCLOSURE: f32 = 10.;
    pub const SECTION: f32 = 11.;
    pub const SMALL: f32 = 12.;
    pub const COMPACT: f32 = 13.;
    pub const ACTION: f32 = 14.;
    pub const MENU: f32 = 15.;
    pub const NORMAL: f32 = 16.;
    pub const FOOTER: f32 = 18.;
    pub const LEADING: f32 = 20.;
    pub const RUN_RING: f32 = 22.;
    pub const DOT: f32 = 6.;
}

pub mod radius {
    pub const TINY: f32 = 4.;
    pub const SMALL: f32 = 6.;
    pub const CONTROL: f32 = 8.;
    pub const MENU_ITEM: f32 = 8.5;
    pub const PERSON: f32 = 10.;
    pub const PANEL: f32 = 12.;
    pub const ROW: f32 = 12.5;
    pub const SLIDER: f32 = 13.;
    pub const CARD: f32 = 14.;
    pub const MODEL_MENU: f32 = 17.5;
    pub const COMPOSER: f32 = 20.;
}

pub mod text {
    pub const TINY: f32 = 9.;
    pub const META: f32 = 10.;
    pub const CAPTION: f32 = 11.;
    pub const SMALL: f32 = 12.;
    pub const ROW: f32 = 13.;
    pub const BODY: f32 = 14.;
    pub const EDITOR: f32 = 15.;
    pub const HEADING: f32 = 16.;
    pub const TITLE: f32 = 24.;
}

pub mod rem {
    pub const XS: f32 = 0.25;
    pub const SM: f32 = 0.5;
    pub const MD: f32 = 0.75;
    pub const LG: f32 = 1.;
    pub const ROOMY: f32 = 1.25;
    pub const XL: f32 = 1.5;
    pub const XXL: f32 = 2.;
}
