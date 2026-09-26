//! Native projection of the Control UI's sidebar grouping, sorting and selection contracts.
use super::sessions::{SessionRow, visible_child_keys};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cmp::Ordering,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
};

mod ownership;
pub use ownership::SidebarOwners;

pub const SECTION_PAGE_SIZE: usize = 10;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchiveFilter {
    #[default]
    Active,
    Archived,
    All,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Grouping {
    #[default]
    Category,
    Person,
    Project,
    None,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortMode {
    #[default]
    Created,
    Updated,
    People,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EmptyGroups {
    #[default]
    Filtering,
    Always,
    Never,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SidebarPreferences {
    pub archive: ArchiveFilter,
    pub owner_id: Option<String>,
    pub involving_me: bool,
    pub show_preview: bool,
    pub live_activity: bool,
    pub show_cron: bool,
    pub show_system: bool,
    pub grouping: Grouping,
    pub sort: SortMode,
    pub empty_groups: EmptyGroups,
    pub collapsed_sections: BTreeSet<String>,
    /// Gateway-owned group inventory is hydrated again, never persisted as preference.
    #[serde(skip)]
    pub known_groups: Vec<String>,
    #[serde(skip)]
    pub section_order: Vec<String>,
    pub all_agents: bool,
    pub people_collapsed: bool,
    pub people_collapsed_roster: bool,
    pub sidebar_entries: Vec<String>,
    pub hidden_catalogs: BTreeSet<String>,
}
impl Default for SidebarPreferences {
    fn default() -> Self {
        Self {
            archive: ArchiveFilter::Active,
            owner_id: None,
            involving_me: false,
            show_preview: false,
            live_activity: true,
            show_cron: false,
            show_system: false,
            grouping: Grouping::Category,
            sort: SortMode::Created,
            empty_groups: EmptyGroups::Filtering,
            collapsed_sections: BTreeSet::from(["work".into()]),
            known_groups: Vec::new(),
            section_order: Vec::new(),
            all_agents: false,
            people_collapsed: false,
            people_collapsed_roster: true,
            hidden_catalogs: BTreeSet::new(),
            sidebar_entries: [
                "route:agents-home",
                "route:dashboards",
                "route:systems",
                "route:cron",
                "route:plugins",
            ]
            .map(str::to_owned)
            .to_vec(),
        }
    }
}
impl SidebarPreferences {
    pub fn filtered(&self) -> bool {
        self.archive != ArchiveFilter::Active || self.owner_id.is_some() || self.involving_me
    }
    pub fn matches(&self, row: &SessionRow) -> bool {
        (self.archive == ArchiveFilter::All
            || row.archived == (self.archive == ArchiveFilter::Archived))
            && (self.show_cron || !row.is_cron())
            && (self.show_system || !row.is_system())
            && !matches!(row.kind.as_deref(), Some("global" | "unknown"))
            && (self.involving_me
                || self
                    .owner_id
                    .as_deref()
                    .is_none_or(|id| row.owner_id() == Some(id)))
        // Involving-me is Gateway-owned: participants is only a bounded display projection.
    }
}

#[derive(Default)]
pub struct CreatedOrder {
    entries: HashMap<String, u64>,
    next: u64,
}
impl CreatedOrder {
    pub fn observe(&mut self, rows: &[SessionRow]) {
        for row in rows {
            if !self.entries.contains_key(&row.key) {
                self.entries.insert(row.key.clone(), self.next);
                self.next += 1;
            }
        }
        if self.entries.len() > 1_000 {
            let visible: HashSet<_> = rows.iter().map(|row| row.key.as_str()).collect();
            let mut absent: Vec<_> = self
                .entries
                .iter()
                .filter(|(key, _)| !visible.contains(key.as_str()))
                .map(|(key, rank)| (key.clone(), *rank))
                .collect();
            absent.sort_by_key(|(_, rank)| *rank);
            for (key, _) in absent.into_iter().take(self.entries.len() - 1_000) {
                self.entries.remove(&key);
            }
        }
    }
    fn compare(&self, a: &SessionRow, b: &SessionRow) -> Ordering {
        let valid = |value: Option<f64>| value.filter(|value| value.is_finite() && *value >= 0.);
        let by_time = match (valid(a.created_at), valid(b.created_at)) {
            (Some(a), Some(b)) => b.total_cmp(&a),
            (Some(_), None) => Ordering::Less,
            (None, Some(_)) => Ordering::Greater,
            _ => Ordering::Equal,
        };
        by_time
            .then_with(|| {
                self.entries
                    .get(&a.key)
                    .unwrap_or(&u64::MAX)
                    .cmp(self.entries.get(&b.key).unwrap_or(&u64::MAX))
            })
            .then_with(|| a.key.cmp(&b.key))
    }
}

#[derive(Clone, Debug)]
pub struct SidebarSection {
    pub id: String,
    pub label: String,
    pub rows: Vec<SessionRow>,
    pub render_header: bool,
    pub person_owner: Option<Value>,
}
fn section(id: impl Into<String>, label: impl Into<String>) -> SidebarSection {
    SidebarSection {
        id: id.into(),
        label: label.into(),
        rows: Vec::new(),
        render_header: true,
        person_owner: None,
    }
}

pub fn sections(
    rows: &[SessionRow],
    prefs: &SidebarPreferences,
    main_key: &str,
    self_id: Option<&str>,
    created: &CreatedOrder,
) -> Vec<SidebarSection> {
    let visible: Vec<_> = rows.iter().filter(|row| prefs.matches(row)).collect();
    let keys: HashSet<_> = visible.iter().map(|row| row.key.as_str()).collect();
    let main = rows
        .iter()
        .find(|row| row.key == main_key)
        .cloned()
        .unwrap_or_else(|| SessionRow {
            key: main_key.to_owned(),
            ..Default::default()
        });
    let known: Vec<_> = rows.iter().collect();
    let main_children = visible_child_keys(&main, &known, main_key);
    let mut roots: Vec<_> = visible
        .into_iter()
        .filter(|row| {
            row.key != main_key
                && !row.is_subagent()
                && (main_children.contains(&row.key)
                    || row
                        .category
                        .as_deref()
                        .is_some_and(|value| !value.trim().is_empty())
                    || row
                        .navigation_parent(main_key, None)
                        .is_none_or(|parent| parent == main_key || !keys.contains(parent)))
        })
        .collect();
    roots.sort_by(|a, b| match prefs.sort {
        SortMode::Created => created.compare(a, b),
        SortMode::Updated => b
            .pinned
            .cmp(&a.pinned)
            .then_with(|| {
                b.pinned_at
                    .unwrap_or(0.)
                    .total_cmp(&a.pinned_at.unwrap_or(0.))
            })
            .then_with(|| {
                b.updated_at
                    .unwrap_or(0.)
                    .total_cmp(&a.updated_at.unwrap_or(0.))
            })
            .then_with(|| a.key.cmp(&b.key)),
        SortMode::People => a
            .owner_label()
            .to_lowercase()
            .cmp(&b.owner_label().to_lowercase())
            .then_with(|| a.owner_id().cmp(&b.owner_id()))
            .then_with(|| created.compare(a, b)),
    });
    let mut pinned = section("pinned", "Pinned");
    let mut other = section("ungrouped", "Other");
    let mut groups = section("groups", "Groups");
    let mut coding = section("work", "Coding");
    let mut named: BTreeMap<String, SidebarSection> = BTreeMap::new();
    let mut derived: BTreeMap<String, SidebarSection> = BTreeMap::new();
    if prefs.grouping == Grouping::Category {
        for name in &prefs.known_groups {
            let name = name.trim();
            if !name.is_empty() {
                named
                    .entry(name.to_owned())
                    .or_insert_with(|| section(format!("category:{name}"), name));
            }
        }
    }
    let mut groups_return_target = false;
    for row in roots {
        if row.pinned {
            pinned.rows.push(row.clone());
            continue;
        }
        if prefs.grouping == Grouping::None {
            other.rows.push(row.clone());
            continue;
        }
        if prefs.grouping == Grouping::Project
            && let Some(path) = row.work_path().and_then(fold_worktree_path)
        {
            let id = format!("project:{path}");
            derived
                .entry(id.clone())
                .or_insert_with(|| section(id, path.rsplit(['/', '\\']).next().unwrap_or(&path)))
                .rows
                .push(row.clone());
            continue;
        }
        if prefs.grouping == Grouping::Person
            && let Some(actor) = row.owner.as_ref().and_then(|owner| owner.get("actor"))
            && let Some(key) = actor_group_id(actor)
        {
            let entry = derived.entry(format!("person:{key}")).or_insert_with(|| {
                let mut entry = section(format!("person:{key}"), row.owner_label());
                entry.person_owner = Some(actor.clone());
                entry
            });
            entry.rows.push(row.clone());
            continue;
        }
        if prefs.grouping == Grouping::Category
            && let Some(name) = row
                .category
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
        {
            groups_return_target |= row.kind.as_deref() == Some("group");
            named
                .entry(name.to_owned())
                .or_insert_with(|| section(format!("category:{name}"), name))
                .rows
                .push(row.clone());
            continue;
        }
        if row.kind.as_deref() == Some("group") {
            groups.rows.push(row.clone());
        } else if row.work_session() {
            coding.rows.push(row.clone());
        } else {
            other.rows.push(row.clone());
        }
    }
    let mut result = Vec::new();
    if !pinned.rows.is_empty() {
        result.push(pinned);
    }
    let mut derived: Vec<_> = derived.into_values().collect();
    let rank = |section: &SidebarSection| {
        let identity = section
            .person_owner
            .as_ref()
            .and_then(|actor| actor.get("identity"));
        match identity
            .and_then(|identity| identity.get("type"))
            .and_then(Value::as_str)
        {
            Some("profile")
                if identity
                    .and_then(|identity| identity.get("id"))
                    .and_then(Value::as_str)
                    == self_id =>
            {
                0
            }
            Some("agent") => 2,
            _ => 1,
        }
    };
    derived.sort_by(|a, b| {
        rank(a)
            .cmp(&rank(b))
            .then_with(|| a.label.to_lowercase().cmp(&b.label.to_lowercase()))
            .then_with(|| a.id.cmp(&b.id))
    });
    result.extend(derived);
    let mut zones = Vec::new();
    for name in &prefs.known_groups {
        if let Some(group) = named.remove(name.trim()) {
            zones.push(group);
        }
    }
    zones.extend(named.into_values());
    zones.push(other);
    if !groups.rows.is_empty() || groups_return_target {
        zones.push(groups);
    }
    if !coding.rows.is_empty() {
        zones.push(coding);
    }
    let default_order: Vec<_> = zones.iter().map(|zone| zone.id.clone()).collect();
    zones.sort_by_key(|zone| {
        prefs
            .section_order
            .iter()
            .position(|id| id == &zone.id)
            .unwrap_or(
                prefs.section_order.len()
                    + default_order
                        .iter()
                        .position(|id| id == &zone.id)
                        .unwrap_or_default(),
            )
    });
    let hide_empty = prefs.empty_groups == EmptyGroups::Always
        || (prefs.empty_groups == EmptyGroups::Filtering
            && (prefs.owner_id.is_some() || prefs.involving_me));
    result.extend(
        zones
            .into_iter()
            .filter(|zone| !hide_empty || !zone.rows.is_empty()),
    );
    let has_peer = prefs.grouping != Grouping::None
        && result
            .iter()
            .any(|section| section.id != "ungrouped" && section.id != "pinned");
    for section in &mut result {
        if section.id == "ungrouped" {
            section.render_header = has_peer;
        }
    }
    result
}

pub(super) fn actor_group_id(actor: &Value) -> Option<String> {
    let identity = actor.get("identity")?;
    let id = identity.get("id")?.as_str()?;
    let kind = identity.get("type")?.as_str()?;
    if id.is_empty() {
        return None;
    }
    if matches!(kind, "profile" | "agent") {
        Some(format!("{kind}:{id}"))
    } else {
        let sorted: BTreeMap<_, _> = identity.as_object()?.iter().collect();
        serde_json::to_string(&sorted).ok()
    }
}

pub fn fold_worktree_path(path: &str) -> Option<String> {
    let path = path.trim_end_matches(['/', '\\']);
    if path.is_empty() {
        return None;
    }
    let normalized = path.replace('\\', "/");
    if let Some(index) = normalized.find("/.claude/worktrees/")
        && normalized.len() > index + "/.claude/worktrees/".len()
    {
        return (index > 0).then(|| path[..index].to_owned());
    }
    Some(path.to_owned())
}

pub fn page_rows<'a>(
    section: &'a SidebarSection,
    limit: usize,
    selected: Option<&str>,
) -> Vec<&'a SessionRow> {
    let required = section
        .rows
        .iter()
        .filter(|row| row.pinned || selected == Some(row.key.as_str()))
        .count();
    let mut slots = limit.saturating_sub(required);
    section
        .rows
        .iter()
        .filter(|row| {
            if row.pinned || selected == Some(row.key.as_str()) {
                return true;
            }
            if slots == 0 {
                return false;
            }
            slots -= 1;
            true
        })
        .collect()
}

#[derive(Default, Debug)]
pub struct Selection {
    pub keys: BTreeSet<String>,
    pub anchor: Option<String>,
}
impl Selection {
    pub fn toggle(&mut self, key: &str) {
        if self.keys.remove(key) {
            self.anchor = None;
        } else {
            self.keys.insert(key.to_owned());
            self.anchor = Some(key.to_owned());
        }
    }
    pub fn extend(&mut self, visible: &[String], key: &str, active: Option<&str>) {
        let anchor = self.anchor.as_deref().or(active).unwrap_or(key);
        let range = visible
            .iter()
            .position(|value| value == anchor)
            .zip(visible.iter().position(|value| value == key));
        if let Some((a, b)) = range {
            let anchor = anchor.to_owned();
            self.keys = visible[a.min(b)..=a.max(b)].iter().cloned().collect();
            self.anchor = Some(anchor);
        } else {
            self.keys = BTreeSet::from([key.to_owned()]);
            self.anchor = Some(key.to_owned());
        }
    }
    pub fn clear(&mut self) {
        self.keys.clear();
        self.anchor = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn rows(value: Value) -> Vec<SessionRow> {
        serde_json::from_value(value).unwrap()
    }
    fn project(rows: &[SessionRow], prefs: &SidebarPreferences) -> Vec<SidebarSection> {
        let mut order = CreatedOrder::default();
        order.observe(rows);
        sections(rows, prefs, "agent:qa:main", Some("me"), &order)
    }
    #[test]
    fn manual_categories_win_smart_zones_and_flat_removes_smart_groups() {
        let data = rows(json!([
            {"key":"pin","pinned":true,"category":"Release"},
            {"key":"manual","category":"Release","kind":"group"},
            {"key":"group","kind":"group"},
            {"key":"work","worktree":{"id":"wt","repoRoot":"/repo"}},
            {"key":"other"}, {"key":"agent:qa:main"},
            {"key":"child","parentSessionKey":"other"}
        ]));
        let mut prefs = SidebarPreferences::default();
        let sections = project(&data, &prefs);
        assert_eq!(
            sections
                .iter()
                .map(|section| section.id.as_str())
                .collect::<Vec<_>>(),
            ["pinned", "category:Release", "ungrouped", "groups", "work"]
        );
        assert_eq!(sections[1].rows[0].key, "manual");
        prefs.grouping = Grouping::None;
        let sections = project(&data, &prefs);
        assert_eq!(sections.len(), 2);
        assert_eq!(sections[1].rows.len(), 4);
        assert!(!sections[1].render_header);
    }
    #[test]
    fn archive_ownership_and_machine_visibility_keep_server_involvement_authority() {
        let data = rows(json!([
            {"key":"mine","owner":{"actor":{"id":"me"}}},
            {"key":"other","owner":{"actor":{"id":"other"}}},
            {"key":"old","archived":true},
            {"key":"agent:qa:cron:daily","createdActor":{"type":"system"}},
            {"key":"probe","createdVia":"internal"},
            {"key":"named-cli","createdVia":"run","label":"My session"}
        ]));
        let mut prefs = SidebarPreferences::default();
        assert_eq!(
            data.iter()
                .filter(|row| prefs.matches(row))
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            ["mine", "other", "named-cli"]
        );
        prefs.owner_id = Some("me".into());
        assert_eq!(project(&data, &prefs)[0].rows[0].key, "mine");
        prefs.involving_me = true;
        assert!(prefs.matches(&data[1]));
        prefs.archive = ArchiveFilter::Archived;
        assert!(prefs.matches(&data[2]));
        assert!(!prefs.matches(&data[0]));
        prefs.archive = ArchiveFilter::All;
        prefs.show_cron = true;
        assert!(prefs.matches(&data[3]));
        assert!(!prefs.matches(&data[4]));
        prefs.show_system = true;
        assert!(prefs.matches(&data[4]));
    }
    #[test]
    fn people_keep_identity_namespaces_and_self_first_projects_fold_worktrees() {
        let data = rows(json!([
            {"key":"agent","owner":{"actor":{"id":"me","label":"A bot","identity":{"type":"agent","id":"me"}}}},
            {"key":"human","owner":{"actor":{"id":"me","label":"Zoe","identity":{"type":"profile","id":"me"}}}},
            {"key":"checkout","spawnedCwd":"/repo/.claude/worktrees/feature/src"},
            {"key":"worktree","worktree":{"repoRoot":"/repo/"}}
        ]));
        let mut prefs = SidebarPreferences {
            grouping: Grouping::Person,
            ..Default::default()
        };
        let groups = project(&data, &prefs);
        assert_eq!(groups[0].id, "person:profile:me");
        assert_eq!(groups[1].id, "person:agent:me");
        prefs.grouping = Grouping::Project;
        let groups = project(&data, &prefs);
        assert_eq!(groups[0].id, "project:/repo");
        assert_eq!(groups[0].rows.len(), 2);
        let acp = rows(json!([{"key":"agent:acp:normal"}, {"key":"agent:qa:acp:worker"}]));
        assert!(!acp[0].work_session());
        assert!(acp[1].work_session());
        let remote = rows(
            json!([{"key":"remote", "execNode":"node", "worktree":{"repoRoot":"/gateway/local"}, "execCwd":"/node/work"}]),
        );
        assert_eq!(remote[0].work_path(), Some("/node/work"));
        assert_eq!(
            fold_worktree_path("C:\\repo\\.claude\\worktrees\\x\\src"),
            Some("C:\\repo".into())
        );
    }
    #[test]
    fn created_sort_does_not_jump_when_update_order_changes_and_pages_retain_selection() {
        let mut data = rows(
            json!([{"key":"b"},{"key":"a"},{"key":"new","createdAt":100},{"key":"old","createdAt":10}]),
        );
        let mut order = CreatedOrder::default();
        order.observe(&data);
        data.reverse();
        order.observe(&data);
        let prefs = SidebarPreferences::default();
        let groups = sections(&data, &prefs, "main", None, &order);
        assert_eq!(
            groups[0]
                .rows
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            ["new", "old", "b", "a"]
        );
        assert_eq!(
            page_rows(&groups[0], 2, Some("a"))
                .iter()
                .map(|row| row.key.as_str())
                .collect::<Vec<_>>(),
            ["new", "a"]
        );
        let prefs = SidebarPreferences {
            sort: SortMode::Updated,
            ..prefs
        };
        data[0].updated_at = Some(999.);
        assert_eq!(
            sections(&data, &prefs, "main", None, &order)[0].rows[0].key,
            "old"
        );
    }
    #[test]
    fn selection_ranges_replace_prior_range_and_reset_a_missing_anchor() {
        let visible = ["a", "b", "c", "d"].map(str::to_owned);
        let mut selection = Selection::default();
        selection.extend(&visible, "d", Some("b"));
        assert_eq!(
            selection.keys,
            BTreeSet::from(["b".into(), "c".into(), "d".into()])
        );
        selection.extend(&visible, "c", None);
        assert_eq!(selection.keys, BTreeSet::from(["b".into(), "c".into()]));
        selection.toggle("a");
        selection.toggle("c");
        assert!(!selection.keys.contains("c"));
        selection.anchor = Some("hidden".into());
        selection.extend(&visible, "d", None);
        assert_eq!(selection.keys, BTreeSet::from(["d".into()]));
        selection.clear();
        assert!(selection.keys.is_empty());
    }
}
