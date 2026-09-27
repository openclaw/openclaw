use super::*;
use serde_json::json;

fn row(value: Value) -> SessionRow {
    serde_json::from_value(value).unwrap()
}

#[test]
fn descendant_question_outweighs_parent_failure_and_retains_its_source() {
    let parent = row(json!({"key":"parent","lastRunError":"Parent failed"}));
    let child = row(json!({"key":"question-child","parentSessionKey":"parent"}));
    let later = row(json!({"key":"later-approval","parentSessionKey":"parent"}));
    let (source, attention) = strongest_attention(
        [
            (&parent, SidebarAttention::Error),
            (&child, SidebarAttention::Question),
            (&later, SidebarAttention::Approval),
        ]
        .into_iter(),
    )
    .unwrap();
    assert_eq!(source.key, "question-child");
    assert_eq!(attention, SidebarAttention::Question);
}

#[test]
fn bounds_background_subscriptions_and_keeps_selected_run() {
    let rows: Vec<_> = (0..10)
        .map(|i| row(json!({"key":format!("agent:qa:run{i}"),"hasActiveRun":true,"startedAt":i})))
        .collect();
    let mut activity = SidebarActivity::default();
    let scopes = activity.sync(
        &rows.iter().collect::<Vec<_>>(),
        Some("agent:qa:run0"),
        Some("qa"),
        true,
    );
    assert_eq!(scopes.len(), 7);
    assert_eq!(scopes[0].1, "agent:qa:run9");
    assert_eq!(scopes[6].1, "agent:qa:run0");
    assert!(!scopes.iter().any(|(_, key)| key == "agent:qa:run3"));
    assert!(activity.sync(&[], None, None, false).is_empty());
}

#[test]
fn narration_hides_split_internal_context_and_retracts_replaced_drafts() {
    let run = row(json!({"key":"global","hasActiveRun":true}));
    let mut activity = SidebarActivity::default();
    activity.sync(&[&run], Some("global"), Some("qa"), true);
    let event = |data| json!({"sessionKey":"agent:qa:global","agentId":"qa","runId":"one","stream":"assistant","data":data});
    activity.handle_event(
        "agent",
        &event(json!({"delta":"private mid-run continuation"})),
        100,
    );
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::None, true, true, 100),
        None
    );
    activity.handle_event(
        "agent",
        &event(json!({"text":"**Visible** setup.\n<<<BEGIN_OPENCLAW_INTERNAL_CONT"})),
        100,
    );
    assert_eq!(
        activity
            .subtitle(&run, SidebarAttention::None, true, true, 100)
            .as_deref(),
        Some("Visible setup.")
    );
    activity.handle_event("agent", &event(json!({"delta":format!("EXT>>>{}\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\nFinal [public](https://example.test) line.", "hidden ".repeat(4_000))})), 200);
    activity.tick(2_100);
    assert_eq!(
        activity
            .subtitle(&run, SidebarAttention::None, true, true, 2_100)
            .as_deref(),
        Some("Final public line.")
    );
    activity.handle_event(
        "agent",
        &event(json!({"replace":true,"text":"Corrected draft."})),
        2_200,
    );
    activity.handle_event("agent", &event(json!({"replace":true,"text":""})), 2_300);
    activity.tick(4_500);
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::None, true, true, 4_500),
        None
    );
    activity.handle_event("agent", &json!({"sessionKey":"global","agentId":"other","stream":"assistant","data":{"text":"Wrong agent"}}), 5_000);
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::None, true, true, 5_000),
        None
    );
}

#[test]
fn observer_freshness_active_run_and_attention_own_the_subtitle() {
    let mut run = row(
        json!({"key":"r","hasActiveRun":true,"activeRunIds":["current"],"observerDigest":{"runId":"old","revision":8,"updatedAt":200,"headline":"Old result","health":"done"}}),
    );
    let mut activity = SidebarActivity::default();
    activity.sync(&[&run], None, None, true);
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::None, true, true, 300),
        None
    );
    activity.handle_event("session.observer", &json!({"sessionKey":"r","runId":"current","revision":9,"updatedAt":300,"headline":"Needs your input","health":"waiting-on-user"}), 300);
    assert_eq!(
        activity
            .subtitle(&run, SidebarAttention::None, false, true, 300)
            .as_deref(),
        Some("Needs your input")
    );
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::Question, true, true, 300),
        None
    );
    assert_eq!(
        activity
            .subtitle(&run, SidebarAttention::Approval, false, true, 300)
            .as_deref(),
        Some("Waiting for approval")
    );
    run.observer_digest = Some(
        json!({"runId":"current","revision":10,"updatedAt":301,"headline":"Fresh row projection","health":"on-track"}),
    );
    assert_eq!(
        activity
            .subtitle(&run, SidebarAttention::None, true, true, 301)
            .as_deref(),
        Some("Fresh row projection")
    );
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::None, false, true, 301),
        None
    );
    run.has_active_run = false;
    run.observer_digest = Some(
        json!({"runId":"current","revision":11,"updatedAt":400,"headline":"Done","health":"done"}),
    );
    assert_eq!(
        activity
            .subtitle(&run, SidebarAttention::None, true, true, 400)
            .as_deref(),
        Some("Done")
    );
    run.last_read_at = Some(400.);
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::None, true, true, 400),
        None
    );
    run.worktree = Some(json!({"repoRoot":"/projects/openclaw", "branch":"openclaw/sidebar"}));
    assert_eq!(
        activity
            .subtitle(&run, SidebarAttention::None, true, true, 400)
            .as_deref(),
        Some("openclaw ⎇ sidebar")
    );
    assert_eq!(
        activity.subtitle(&run, SidebarAttention::None, false, true, 400),
        None
    );
}

#[test]
fn narration_removes_control_tokens_and_code_without_losing_latest_prose() {
    for suppressed in [
        "REPLY_SKIP",
        "NO_RE",
        "HEARTBEAT_OK",
        "[[audio_as_voice]] REPLY_SKIP",
    ] {
        assert_eq!(narration_line(suppressed), None);
    }
    assert_eq!(
        narration_line("First sentence. **Newest** sentence.\n\n```rs\nprivate code\n```")
            .as_deref(),
        Some("Newest sentence.")
    );
    assert_eq!(
        narration_line("Visible work. [[reply_to_current]] REPLY_SKIP").as_deref(),
        Some("Visible work.")
    );
}
