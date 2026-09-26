use std::collections::BTreeMap;

use crate::gateway::profiles::GatewayProfile;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum GatewayStatus {
    #[default]
    Offline,
    NeedsSignIn,
    Connecting,
    Connected,
}

impl GatewayStatus {
    pub fn label(self) -> &'static str {
        match self {
            Self::Connected => "Connected",
            Self::Connecting => "Connecting",
            Self::NeedsSignIn => "Sign in required",
            Self::Offline => "Offline",
        }
    }
}

pub fn profile_statuses<'a>(
    windows: impl IntoIterator<Item = (&'a str, GatewayStatus)>,
) -> BTreeMap<String, GatewayStatus> {
    let mut statuses = BTreeMap::<String, GatewayStatus>::new();
    for (id, status) in windows {
        let existing = statuses.entry(id.to_owned()).or_default();
        *existing = (*existing).max(status);
    }
    statuses
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MenuRow {
    pub id: String,
    pub name: String,
    pub number: Option<usize>,
    pub primary: bool,
    pub checked: bool,
    pub status: GatewayStatus,
}

impl MenuRow {
    pub fn new_window_title(&self) -> String {
        format!("New {} Window", self.name)
    }

    pub fn has_same_structure(&self, other: &Self) -> bool {
        self.id == other.id
            && self.name == other.name
            && self.number == other.number
            && self.primary == other.primary
    }
}

pub fn menu_rows(
    profiles: &[GatewayProfile],
    primary: Option<&str>,
    current: Option<&str>,
    statuses: &BTreeMap<String, GatewayStatus>,
) -> Vec<MenuRow> {
    let mut ordered: Vec<_> = profiles.iter().collect();
    ordered.sort_by_key(|p| (Some(p.id.as_str()) != primary, p.order, &p.id));
    ordered
        .iter()
        .enumerate()
        .map(|(index, p)| MenuRow {
            id: p.id.clone(),
            name: p.name.clone(),
            number: (index < 9).then_some(index + 1),
            primary: Some(p.id.as_str()) == primary,
            checked: Some(p.id.as_str()) == current,
            status: statuses.get(&p.id).copied().unwrap_or_default(),
        })
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NativeMenuEntry {
    Gateway { index: usize, new_window: bool },
    Separator,
    Manage,
}

pub fn native_entries(rows: &[MenuRow]) -> Vec<NativeMenuEntry> {
    let mut entries = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        entries.extend([
            NativeMenuEntry::Gateway {
                index,
                new_window: false,
            },
            NativeMenuEntry::Gateway {
                index,
                new_window: true,
            },
        ]);
        if row.primary && rows.len() > 1 {
            entries.push(NativeMenuEntry::Separator);
        }
    }
    if !rows.is_empty() {
        entries.push(NativeMenuEntry::Separator);
    }
    entries.push(NativeMenuEntry::Manage);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::profiles::GatewayKind;

    fn profiles() -> Vec<GatewayProfile> {
        (0..11)
            .rev()
            .map(|n| GatewayProfile {
                id: format!("g{n}"),
                name: format!("Gateway {n}"),
                order: n,
                kind: GatewayKind::Direct {
                    url: format!("wss://g{n}.example/"),
                },
            })
            .collect()
    }

    #[test]
    fn primary_order_drives_shortcuts_while_each_window_selects_its_own_gateway() {
        let statuses = BTreeMap::from([("g3".into(), GatewayStatus::Connected)]);
        let rows = menu_rows(&profiles(), Some("g5"), Some("g3"), &statuses);
        assert_eq!(
            rows.iter().map(|row| row.id.as_str()).collect::<Vec<_>>(),
            [
                "g5", "g0", "g1", "g2", "g3", "g4", "g6", "g7", "g8", "g9", "g10"
            ]
        );
        assert!(rows[0].primary);
        assert!(!rows[0].checked);
        assert_eq!(rows.iter().filter(|row| row.primary).count(), 1);
        assert_eq!(rows.iter().filter(|row| row.checked).count(), 1);
        assert!(rows[4].checked);
        assert_eq!(rows[4].status, GatewayStatus::Connected);
        assert_eq!(rows[0].status, GatewayStatus::Offline);
        assert_eq!(
            rows.iter().map(|row| row.number).collect::<Vec<_>>(),
            [
                Some(1),
                Some(2),
                Some(3),
                Some(4),
                Some(5),
                Some(6),
                Some(7),
                Some(8),
                Some(9),
                None,
                None
            ]
        );
        assert_eq!(rows[4].new_window_title(), "New Gateway 3 Window");

        let promoted = menu_rows(&profiles(), Some("g3"), None, &statuses);
        assert_eq!(promoted[0].id, "g3");
        assert_eq!(promoted[0].number, Some(1));
        assert!(promoted[0].primary);
        assert!(promoted.iter().all(|row| !row.checked));
    }

    #[test]
    fn live_status_and_selection_updates_preserve_native_menu_structure() {
        let initial = menu_rows(&profiles(), Some("g5"), Some("g3"), &BTreeMap::new());
        let updated = menu_rows(
            &profiles(),
            Some("g5"),
            Some("g4"),
            &BTreeMap::from([("g3".into(), GatewayStatus::Connected)]),
        );
        assert!(
            initial
                .iter()
                .zip(&updated)
                .all(|(a, b)| a.has_same_structure(b))
        );
        let mut renamed = updated[0].clone();
        renamed.name = "Renamed Gateway".into();
        assert!(!initial[0].has_same_structure(&renamed));
        let promoted = menu_rows(&profiles(), Some("g3"), None, &BTreeMap::new());
        assert!(!initial[0].has_same_structure(&promoted[0]));
    }

    #[test]
    fn native_menu_groups_primary_with_its_alternate_before_saved_profiles() {
        use NativeMenuEntry::{Gateway, Manage, Separator};
        let rows = menu_rows(&profiles()[..3], Some("g9"), None, &BTreeMap::new());
        assert_eq!(rows[0].id, "g9");
        assert_eq!(
            native_entries(&rows),
            [
                Gateway {
                    index: 0,
                    new_window: false
                },
                Gateway {
                    index: 0,
                    new_window: true
                },
                Separator,
                Gateway {
                    index: 1,
                    new_window: false
                },
                Gateway {
                    index: 1,
                    new_window: true
                },
                Gateway {
                    index: 2,
                    new_window: false
                },
                Gateway {
                    index: 2,
                    new_window: true
                },
                Separator,
                Manage,
            ]
        );
        assert_eq!(
            native_entries(&rows[..1]),
            [
                Gateway {
                    index: 0,
                    new_window: false
                },
                Gateway {
                    index: 0,
                    new_window: true
                },
                Separator,
                Manage,
            ]
        );
        assert_eq!(native_entries(&[]), [Manage]);
    }

    #[test]
    fn connected_profile_stays_connected_while_another_window_reconnects() {
        let windows = [
            ("online", GatewayStatus::Connected),
            ("online", GatewayStatus::Connecting),
            ("online", GatewayStatus::Offline),
            ("signin", GatewayStatus::NeedsSignIn),
            ("offline", GatewayStatus::Offline),
        ];
        let statuses = profile_statuses(windows);
        assert_eq!(statuses["online"], GatewayStatus::Connected);
        assert_eq!(statuses["signin"], GatewayStatus::NeedsSignIn);
        assert_eq!(statuses["offline"], GatewayStatus::Offline);
        assert_eq!(profile_statuses(windows.into_iter().rev()), statuses);
        assert_eq!(
            profile_statuses(windows[1..].iter().copied())["online"],
            GatewayStatus::Connecting
        );
    }
}
