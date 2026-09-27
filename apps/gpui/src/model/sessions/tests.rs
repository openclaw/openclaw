use super::*;
use serde_json::json;

fn projected_roots(rows: &[SessionRow], main_key: &str) -> Vec<SessionRow> {
    use crate::model::sidebar::{CreatedOrder, SidebarPreferences, sections};
    let mut order = CreatedOrder::default();
    order.observe(rows);
    sections(rows, &SidebarPreferences::default(), main_key, None, &order)
        .into_iter()
        .flat_map(|section| section.rows)
        .collect()
}

#[test]
fn session_titles_prefer_readable_metadata_and_never_leak_routing_keys() {
    let cases = [
        (
            json!({"key":"agent:qa:main", "label":"agent:qa:main", "displayName":" Home base ", "derivedTitle":"Derived"}),
            "Home base",
        ),
        (
            json!({"key":"agent:qa:main", "label":" Named ", "displayName":"Display"}),
            "Named",
        ),
        (
            json!({"key":"agent:qa:main", "label":" ", "displayName":"agent:qa:main", "derivedTitle":" Release review "}),
            "Release review",
        ),
        (
            json!({"key":"agent:qa:main", "lastMessagePreview":"Plan the release\nwith the team"}),
            "Plan the release with the team",
        ),
        (
            json!({"key":"agent:qa:main", "label":"agent:qa:main"}),
            "Main",
        ),
        (json!({"key":"agent:qa:dashboard:1234-5678"}), "New session"),
        (
            json!({"key":"agent:qa:explicit:release-review"}),
            "release-review",
        ),
    ];
    for (value, expected) in cases {
        let page = SessionPage::parse(json!({"sessions":[value]})).unwrap();
        assert_eq!(page.sessions[0].title(), expected);
    }
}

#[test]
fn roster_orders_pins_and_hides_archives_without_flattening_children() {
    let page = SessionPage::parse(json!({"sessions":[
        {"key":"new","updatedAt":900,"derivedTitle":"Derived"},
        {"key":"hidden","pinned":true,"archived":true},
        {"key":"pin","updatedAt":10,"pinned":true,"label":"Named","displayName":"Ignored"},
        {"key":"child","parentSessionKey":"pin","updatedAt":1000}
    ]}))
    .unwrap();
    let visible = projected_roots(&page.sessions, "agent:main:main");
    assert_eq!(
        visible
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>(),
        ["pin", "new"]
    );
    assert_eq!(visible[0].title(), "Named");
}

#[test]
fn implicit_home_links_keep_operator_roots_visible_and_pinnable() {
    let page = SessionPage::parse(json!({"sessions":[
        {"key":"agent:qa:showcase", "pinned":true, "parentSessionKey":"agent:qa:main", "createdVia":"operator", "spawnDepth":0, "childSessions":["agent:qa:child"]},
        {"key":"agent:qa:recent", "parentSessionKey":"agent:qa:main", "createdVia":"operator", "spawnDepth":0},
        {"key":"agent:qa:child", "parentSessionKey":"agent:qa:showcase", "parentSessionId":"showcase-incarnation", "createdVia":"operator", "spawnDepth":0},
        {"key":"agent:qa:main", "childSessions":["agent:qa:showcase", "agent:qa:recent"]},
        {"key":"agent:qa:explicit", "parentSessionKey":"agent:qa:main", "parentSessionId":"main-incarnation", "createdVia":"operator", "spawnDepth":0},
        {"key":"agent:qa:archived-child", "parentSessionKey":"agent:qa:showcase", "archived":true}
    ]})).unwrap();
    let main = "agent:qa:main";
    let visible = projected_roots(&page.sessions, main);
    assert_eq!(
        visible
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>(),
        ["agent:qa:showcase", "agent:qa:explicit", "agent:qa:recent"]
    );
    let known: Vec<_> = page.sessions.iter().collect();
    let root = page.sessions.iter().find(|row| row.key == main).unwrap();
    assert_eq!(
        visible_child_keys(root, &known, main),
        ["agent:qa:explicit"]
    );
    let showcase = &visible[0];
    assert_eq!(
        visible_child_keys(showcase, &known, main),
        ["agent:qa:child", "agent:qa:archived-child"]
    );
    assert!(showcase.can_pin(main));
    assert!(
        !page
            .sessions
            .iter()
            .find(|row| row.key == "agent:qa:child")
            .unwrap()
            .can_pin(main)
    );
    assert!(
        !page
            .sessions
            .iter()
            .find(|row| row.key == "agent:qa:explicit")
            .unwrap()
            .can_pin(main)
    );
}

#[test]
fn nested_snapshots_update_known_rows_and_reject_stale_or_unknown_membership() {
    let mut rows = SessionPage::parse(
        json!({"sessions":[{"key":"known","snapshotAt":100,"label":"Before","pinned":true}]}),
    )
    .unwrap()
    .sessions;
    assert!(reconcile_event(&mut rows, &json!({"session":{"key":"known","snapshotAt":101,"label":"After"},"label":"Wrong envelope"})).changed);
    assert_eq!(rows[0].title(), "After");
    let mut slow_read = SessionPage::parse(
        json!({"sessions":[{"key":"known", "snapshotAt":100, "label":"Before"}]}),
    )
    .unwrap()
    .sessions;
    retain_newer_rows(&rows, &mut slow_read);
    assert_eq!(slow_read[0].title(), "After");

    assert!(
        !reconcile_event(
            &mut rows,
            &json!({"session":{"key":"known","snapshotAt":99,"label":"Stale"}})
        )
        .changed
    );
    assert!(
        reconcile_event(
            &mut rows,
            &json!({"session":{"key":"new","label":"Unknown"}})
        )
        .refresh
    );
    assert_eq!(rows.len(), 1);
    assert!(
        reconcile_event(
            &mut rows,
            &json!({"session":{"key":"known","snapshotAt":102,"archived":true}})
        )
        .refresh
    );
    assert!(rows[0].archived);
}

#[test]
fn unknown_child_event_still_updates_admitted_ancestors_with_their_own_clock() {
    let mut rows = SessionPage::parse(json!({"sessions":[
        {"key":"parent", "snapshotAt":100, "status":"idle", "childSessions":["child"]}
    ]}))
    .unwrap()
    .sessions;
    let result = reconcile_event(
        &mut rows,
        &json!({
            "session":{"key":"child", "snapshotAt":999, "status":"failed"},
            "ancestorSessions":[{"key":"parent", "snapshotAt":101, "status":"running"}]
        }),
    );
    assert!(result.refresh);
    assert_eq!(rows[0].status.as_deref(), Some("running"));
    assert_eq!(rows[0].snapshot_at, Some(101.));
    assert_eq!(rows.len(), 1);
}

#[test]
fn hidden_runs_fold_to_persistent_children_without_cycles_or_duplicate_categories() {
    let rows: Vec<SessionRow> = serde_json::from_value(json!([
        {"key":"root","childSessions":["subagent:first","direct","categorized"],"hasActiveSubagentRun":true},
        {"key":"subagent:first","childSessions":["subagent:second"]},
        {"key":"subagent:second","childSessions":["subagent:first","promoted"]},
        {"key":"direct","parentSessionKey":"root"},
        {"key":"promoted","parentSessionKey":"subagent:second"},
        {"key":"categorized","category":"Release","parentSessionKey":"root"}
    ])).unwrap();
    let known: Vec<_> = rows.iter().collect();
    assert_eq!(
        visible_child_keys(&rows[0], &known, "main"),
        ["promoted", "direct"]
    );
    assert_eq!(
        projected_roots(&rows, "root")
            .iter()
            .map(|row| row.key.as_str())
            .collect::<Vec<_>>(),
        ["categorized", "direct", "promoted"]
    );
    assert!(rows[0].display_running());
    assert!(!rows[0].running());
    let mut archived = rows[0].clone();
    archived.archived = true;
    assert!(!archived.display_running());
}

#[test]
fn child_runtime_uses_sampled_active_work_and_freezes_completed_rows() {
    let mut row = SessionRow {
        runtime_ms: Some(800.),
        runtime_sampled_at: Some(1000.),
        has_active_run: true,
        ..Default::default()
    };
    assert_eq!(row.runtime_duration_ms(1300), Some(1100));
    row.apply_patch(&json!({"runtimeMs": 1200}));
    row.sample_runtime_at(1400);
    assert_eq!(row.runtime_duration_ms(1500), Some(1300));
    row.runtime_ms = Some(800.);
    row.has_active_run = false;
    assert_eq!(row.runtime_duration_ms(2000), Some(800));
    row.runtime_ms = None;
    row.started_at = Some(100.);
    row.ended_at = Some(550.);
    assert_eq!(row.runtime_duration_ms(2000), Some(450));
    row.started_at = Some(f64::NAN);
    assert_eq!(row.runtime_duration_ms(2000), None);
}

#[test]
fn stale_mutation_cannot_undo_newer_edit_on_same_session() {
    let mut receipts = MutationReceipts::default();
    let first = receipts.begin("a");
    let second = receipts.begin("a");
    let independent = receipts.begin("b");
    assert!(!receipts.current("a", first));
    assert!(receipts.current("a", second));
    assert!(receipts.current("b", independent));
}
