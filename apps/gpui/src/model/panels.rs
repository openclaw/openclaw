//! Native presentation state mirrors the Control UI sidebar layout owner.
use crate::ui::theme::tokens::dock::{
    BROWSER_SPLIT_MIN_WIDTH, CHROME_RESERVE, DEFAULT_WIDTH, DIVIDER_WIDTH, MAX_VIEWPORT_FRACTION,
    MAX_WIDTH, MIN_WIDTH,
};
use serde::Deserialize;

#[derive(Debug, PartialEq, Eq)]
pub enum LinkTarget {
    Reading(String),
    External(String),
    Blocked,
}

pub fn normalize_reading_url(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    // A host followed by a numeric port is not an explicit URI scheme.
    let scheme = value.split_once(':').is_some_and(|(prefix, suffix)| {
        prefix.starts_with(|ch: char| ch.is_ascii_alphabetic())
            && prefix
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || "+-.".contains(ch))
            && !suffix.starts_with(|ch: char| ch.is_ascii_digit())
    });
    if scheme
        && !value.to_ascii_lowercase().starts_with("http://")
        && !value.to_ascii_lowercase().starts_with("https://")
    {
        return None;
    }
    let url = url::Url::parse(&if scheme {
        value.into()
    } else {
        format!("https://{value}")
    })
    .ok()?;
    matches!(url.scheme(), "https" | "http").then(|| url.to_string())
}

pub fn classify_link(value: &str) -> LinkTarget {
    let Ok(url) = url::Url::parse(value.trim()) else {
        return LinkTarget::Blocked;
    };
    match url.scheme() {
        "https" | "http" => LinkTarget::Reading(url.to_string()),
        "mailto" | "tel" => LinkTarget::External(url.to_string()),
        _ => LinkTarget::Blocked,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum PanelSlot {
    Browser,
    LinkReader,
    Companion,
    Conversation,
    Dashboard,
    Desktop,
    Detail,
    Discussion,
    Portal,
    Tasks,
    Terminal,
    Workspace,
    Plugin(String),
}

impl PanelSlot {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "browser" => Self::Browser,
            "link-reader" => Self::LinkReader,
            "companion" => Self::Companion,
            "conversation" => Self::Conversation,
            "dashboard" => Self::Dashboard,
            "desktop" => Self::Desktop,
            "detail" => Self::Detail,
            "discussion" => Self::Discussion,
            "portal" => Self::Portal,
            "tasks" => Self::Tasks,
            "terminal" => Self::Terminal,
            "workspace" => Self::Workspace,
            _ => {
                let (plugin, panel) = value.strip_prefix("plugin:")?.split_once('/')?;
                let valid = |part: &str| {
                    !part.is_empty()
                        && part.len() <= 128
                        && part.as_bytes()[0].is_ascii_alphanumeric()
                        && part
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
                };
                if !valid(plugin) || !valid(panel) {
                    return None;
                }
                Self::Plugin(value.to_owned())
            }
        })
    }

    pub fn as_str(&self) -> &str {
        match self {
            Self::Browser => "browser",
            Self::LinkReader => "link-reader",
            Self::Companion => "companion",
            Self::Conversation => "conversation",
            Self::Dashboard => "dashboard",
            Self::Desktop => "desktop",
            Self::Detail => "detail",
            Self::Discussion => "discussion",
            Self::Portal => "portal",
            Self::Tasks => "tasks",
            Self::Terminal => "terminal",
            Self::Workspace => "workspace",
            Self::Plugin(slot) => slot,
        }
    }

    pub fn label(&self) -> &str {
        match self {
            Self::Browser => "Browser",
            Self::LinkReader => "Link reader",
            Self::Companion => "Side chat",
            Self::Conversation => "Conversation",
            Self::Dashboard => "Dashboard",
            Self::Desktop => "Desktop",
            Self::Detail => "Review",
            Self::Discussion => "Discussion",
            Self::Portal => "Portals",
            Self::Tasks => "Tasks",
            Self::Terminal => "Terminal",
            Self::Workspace => "Files",
            Self::Plugin(slot) => slot.strip_prefix("plugin:").unwrap_or(slot),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Panel {
    pub slot: PanelSlot,
    pub task_id: Option<String>,
    pub portal_id: Option<String>,
    pub environment_id: Option<String>,
    pub resource_url: Option<String>,
    pub file_path: Option<String>,
}

impl Panel {
    pub fn new(slot: PanelSlot) -> Self {
        Self {
            slot,
            task_id: None,
            portal_id: None,
            environment_id: None,
            resource_url: None,
            file_path: None,
        }
    }
}

/// Availability belongs to the embedded Control UI, including plugin registrations.
#[derive(Clone, Debug, Deserialize)]
pub struct PanelDefinition {
    pub slot: String,
    pub label: String,
    pub available: bool,
}

#[derive(Clone, Debug)]
pub struct DockLayout {
    pub panels: Vec<Panel>,
    pub active: Option<PanelSlot>,
    pub open: bool,
    pub expanded: bool,
    pub width: f32,
    pub resource_auto_open_dismissed: bool,
    browser_width_pending: bool,
}

impl Default for DockLayout {
    fn default() -> Self {
        Self {
            panels: Vec::new(),
            active: None,
            open: false,
            expanded: false,
            width: DEFAULT_WIDTH,
            resource_auto_open_dismissed: false,
            browser_width_pending: true,
        }
    }
}

impl DockLayout {
    pub fn open(&mut self, slot: PanelSlot) {
        if !self.panels.iter().any(|panel| panel.slot == slot) {
            self.panels.push(Panel::new(slot.clone()));
        }
        self.active = Some(slot);
        self.open = true;
        self.expanded = false;
    }

    pub fn close(&mut self, slot: &PanelSlot) {
        let Some(index) = self.panels.iter().position(|panel| &panel.slot == slot) else {
            return;
        };
        self.panels.remove(index);
        if matches!(slot, PanelSlot::Browser | PanelSlot::Desktop) {
            self.resource_auto_open_dismissed = true;
        }
        if self.active.as_ref() == Some(slot) {
            self.active = self
                .panels
                .get(index.min(self.panels.len().saturating_sub(1)))
                .map(|panel| panel.slot.clone());
            self.expanded = false;
        }
        if self.panels.is_empty() {
            self.open = false;
        }
    }

    pub fn activate(&mut self, slot: &PanelSlot) {
        if self.panels.iter().any(|panel| &panel.slot == slot) {
            self.active = Some(slot.clone());
            self.open = true;
            self.expanded = false;
        }
    }

    pub fn toggle_open(&mut self) {
        self.open = !self.open;
        if !self.open {
            self.resource_auto_open_dismissed = true;
        }
        self.expanded = false;
    }

    pub fn toggle_expanded(&mut self) {
        if self.active.is_some() {
            self.expanded = !self.expanded;
            self.open = true;
        }
    }

    pub fn resize(&mut self, width: f32) {
        if width.is_finite() {
            self.width = width.clamp(MIN_WIDTH, MAX_WIDTH);
            self.browser_width_pending = false;
        }
    }

    pub fn fit_width(&self, available: f32) -> Option<f32> {
        if !available.is_finite() || available <= 0. {
            return Some(self.width);
        }
        let budget = available - CHROME_RESERVE - DIVIDER_WIDTH;
        (budget >= MIN_WIDTH).then(|| {
            self.width
                .min(
                    ((f64::from(available) * MAX_VIEWPORT_FRACTION) as f32)
                        .clamp(MIN_WIDTH, MAX_WIDTH),
                )
                .min(budget)
        })
    }

    pub fn initialize_browser_width(&mut self, available: f32, chat_width: f32) {
        if self.browser_width_pending
            && self.open
            && !self.expanded
            && self.active == Some(PanelSlot::Browser)
            && available.is_finite()
            && available >= BROWSER_SPLIT_MIN_WIDTH
            && chat_width.is_finite()
            && chat_width > 0.
        {
            self.width = self
                .width
                .max(available - chat_width.min(available / 2.) - DIVIDER_WIDTH);
            self.width = self.fit_width(available).unwrap_or(DEFAULT_WIDTH);
            self.browser_width_pending = false;
        }
    }

    /// Discovery adds a live resource but never steals an existing selection.
    pub fn auto_reveal(&mut self, slot: PanelSlot) -> bool {
        if self.resource_auto_open_dismissed
            || (!self.open && !self.panels.is_empty())
            || self.panels.iter().any(|panel| panel.slot == slot)
        {
            return false;
        }
        let active = self.open.then(|| self.active.clone()).flatten();
        let expanded = self.expanded;
        self.open(slot);
        if active.is_some() {
            self.active = active;
        }
        self.expanded = expanded;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_navigation_and_transcript_links_never_load_executable_schemes() {
        for (input, expected) in [
            (" example.com/guide ", Some("https://example.com/guide")),
            ("localhost:3000/page", Some("https://localhost:3000/page")),
            ("http://example.com", Some("http://example.com/")),
            ("http:example.com", None),
            ("javascript:alert(1)", None),
            ("data:text/html,hello", None),
            ("file:///tmp/private", None),
            ("", None),
        ] {
            assert_eq!(normalize_reading_url(input).as_deref(), expected);
        }
        assert_eq!(
            classify_link("mailto:test@example.com"),
            LinkTarget::External("mailto:test@example.com".into())
        );
        assert_eq!(
            classify_link("https://example.com"),
            LinkTarget::Reading("https://example.com/".into())
        );
        assert_eq!(classify_link("javascript:alert(1)"), LinkTarget::Blocked);
    }

    #[test]
    fn close_selects_neighbor_and_focus_restores_the_saved_width() {
        let mut dock = DockLayout::default();
        dock.open(PanelSlot::Tasks);
        dock.open(PanelSlot::Terminal);
        dock.open(PanelSlot::Workspace);
        dock.resize(620.);
        dock.activate(&PanelSlot::Terminal);
        dock.toggle_expanded();
        dock.toggle_expanded();
        assert_eq!(dock.width, 620.);
        assert_eq!(dock.active, Some(PanelSlot::Terminal));
        dock.close(&PanelSlot::Terminal);
        assert_eq!(dock.active, Some(PanelSlot::Workspace));
        dock.close(&PanelSlot::Workspace);
        dock.close(&PanelSlot::Tasks);
        assert!(!dock.open);
        assert!(dock.active.is_none());
    }

    #[test]
    fn automatic_resources_respect_sticky_dismissal_and_never_steal_selection() {
        let mut dock = DockLayout::default();
        dock.open(PanelSlot::Tasks);
        assert!(dock.auto_reveal(PanelSlot::Browser));
        assert_eq!(dock.active, Some(PanelSlot::Tasks));
        dock.close(&PanelSlot::Browser);
        assert!(!dock.auto_reveal(PanelSlot::Desktop));
        dock.open(PanelSlot::Browser);
        assert!(!dock.auto_reveal(PanelSlot::Desktop));
        let mut other_session = DockLayout::default();
        assert!(other_session.auto_reveal(PanelSlot::Desktop));
        other_session.toggle_open();
        assert!(!other_session.auto_reveal(PanelSlot::Browser));
    }

    #[test]
    fn widths_preserve_chat_space_and_manual_resize_overrides_browser_default() {
        let mut dock = DockLayout::default();
        dock.open(PanelSlot::Browser);
        dock.initialize_browser_width(1400., 768.);
        assert_eq!(dock.width, 694.);
        assert_eq!(dock.fit_width(800.), Some(480.));
        assert_eq!(dock.fit_width(577.), None);
        dock.resize(330.);
        dock.initialize_browser_width(1800., 768.);
        assert_eq!(dock.width, 330.);
        dock.resize(f32::NAN);
        assert_eq!(dock.width, 330.);
    }
}
