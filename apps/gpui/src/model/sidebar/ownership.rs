use super::{Grouping, SidebarPreferences, SortMode};
use crate::model::{
    people::{Person, PersonIdentity},
    sessions::SessionRow,
};
use serde_json::Value;
use std::collections::HashSet;

/// One projection owns owner choices and the grouping/sort capability shown by
/// both the menu and the roster. An absent facet is unresolved, not a denial.
pub struct SidebarOwners {
    pub options: Vec<Person>,
    pub self_id: Option<String>,
    pub filters_available: bool,
    pub people_available: bool,
}
impl SidebarOwners {
    pub fn project<'a>(
        facet: Option<&[Value]>,
        self_user: Option<&Person>,
        rows: impl IntoIterator<Item = &'a SessionRow>,
    ) -> Self {
        let people_available = facet.is_none_or(|owners| owners.len() >= 2);
        let self_id = self_user.map(|person| person.id.clone());
        let mut options: Vec<_> = facet
            .unwrap_or_default()
            .iter()
            .filter_map(|actor| {
                let mut person = Person::from_actor(actor)?;
                if person.identity.is_none() {
                    person.identity = Some(PersonIdentity {
                        kind: if actor.get("type").and_then(Value::as_str) == Some("human") {
                            "profile"
                        } else {
                            "agent"
                        }
                        .into(),
                        id: person.id.clone(),
                    });
                }
                Some(person)
            })
            .collect();
        if let Some(person) = self_user
            && !options.iter().any(|owner| {
                owner.id == person.id
                    && owner
                        .identity
                        .as_ref()
                        .is_some_and(|identity| identity.kind == "agent")
            })
        {
            options.retain(|owner| owner.id != person.id);
            let mut person = person.clone();
            person.identity = Some(PersonIdentity {
                kind: "profile".into(),
                id: person.id.clone(),
            });
            options.insert(0, person);
        }
        let mut identities: HashSet<_> = options.iter().map(Person::key).collect();
        let mut filters_available = identities.len() >= 2;
        if !filters_available {
            let mut pending: Vec<_> = rows.into_iter().collect();
            while let Some(row) = pending.pop() {
                identities.extend(
                    row.participants
                        .iter()
                        .filter_map(Person::from_actor)
                        .map(|person| person.key()),
                );
                if identities.len() >= 2
                    || row.participant_count.unwrap_or(row.participants.len())
                        > row.participants.len()
                {
                    filters_available = true;
                    break;
                }
                pending.extend(row.children.iter());
            }
        }
        Self {
            options,
            self_id,
            filters_available,
            people_available,
        }
    }

    pub fn effective_preferences(&self, stored: &SidebarPreferences) -> SidebarPreferences {
        let mut effective = stored.clone();
        if !self.people_available {
            if effective.grouping == Grouping::Person {
                effective.grouping = Grouping::Category;
            }
            if effective.sort == SortMode::People {
                effective.sort = SortMode::Created;
            }
        }
        if effective.all_agents {
            effective.grouping = Grouping::None;
        }
        effective
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::sidebar::{CreatedOrder, sections};
    use serde_json::json;

    #[test]
    fn owner_facet_drives_the_menu_and_real_section_grouping() {
        let stored = SidebarPreferences {
            grouping: Grouping::Person,
            sort: SortMode::People,
            ..Default::default()
        };
        let alice = json!({"type":"human","id":"alice","label":"Alice","identity":{"type":"profile","id":"alice"}});
        let bob = json!({"type":"human","id":"bob","label":"Bob","identity":{"type":"profile","id":"bob"}});
        let row: SessionRow = serde_json::from_value(
            json!({"key":"agent:qa:release","category":"Release","owner":{"actor":alice.clone()}}),
        )
        .unwrap();
        let rows = [row];
        let mut created = CreatedOrder::default();
        created.observe(&rows);
        for (facet, expected_grouping, expected_sort, expected_section) in [
            (
                None,
                Grouping::Person,
                SortMode::People,
                "person:profile:alice",
            ),
            (
                Some(vec![alice.clone()]),
                Grouping::Category,
                SortMode::Created,
                "category:Release",
            ),
            (
                Some(vec![alice, bob]),
                Grouping::Person,
                SortMode::People,
                "person:profile:alice",
            ),
        ] {
            let owner = SidebarOwners::project(facet.as_deref(), None, &rows);
            let effective = owner.effective_preferences(&stored);
            assert_eq!(
                (effective.grouping, effective.sort),
                (expected_grouping, expected_sort)
            );
            let projected = sections(&rows, &effective, "agent:qa:main", None, &created);
            assert_eq!(
                projected
                    .iter()
                    .find(|section| !section.rows.is_empty())
                    .unwrap()
                    .id,
                expected_section
            );
        }
    }

    #[test]
    fn owner_options_keep_self_first_and_qualified_participants_enable_filters() {
        let own: Person = serde_json::from_value(json!({"id":"same","name":"Alice"})).unwrap();
        let bob = json!({"type":"human","id":"bob","label":"Bob"});
        let rows: Vec<SessionRow> = serde_json::from_value(
            json!([{"key":"one","participants":[{"identity":{"type":"agent","id":"same"}}]}]),
        )
        .unwrap();
        let projection = SidebarOwners::project(Some(&[]), Some(&own), &rows);
        assert!(!projection.people_available);
        assert!(projection.filters_available);
        assert_eq!(projection.options[0].key(), "profile:same");
        let projection = SidebarOwners::project(Some(&[bob]), Some(&own), []);
        assert_eq!(
            projection
                .options
                .iter()
                .map(Person::label)
                .collect::<Vec<_>>(),
            ["Alice", "Bob"]
        );
        let agent = json!({"type":"agent","id":"same","label":"Worker"});
        let projection = SidebarOwners::project(Some(&[agent]), Some(&own), []);
        assert_eq!(projection.options.len(), 1);
        assert_eq!(projection.options[0].key(), "agent:same");
    }
}
