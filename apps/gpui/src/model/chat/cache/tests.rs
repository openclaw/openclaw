use super::*;
use serde_json::json;
use std::{cell::Cell, rc::Rc};

#[derive(Default)]
struct Prepared {
    rows: Vec<&'static str>,
    scroll: usize,
    bytes: usize,
    _receipt: Option<DropReceipt>,
}

impl Presentation for Prepared {
    fn approximate_bytes(&self) -> usize {
        self.bytes
    }
}

struct DropReceipt(Rc<Cell<usize>>);

impl Drop for DropReceipt {
    fn drop(&mut self) {
        self.0.set(self.0.get() + 1);
    }
}

fn sessions() -> Sessions<Prepared> {
    let mut sessions = Sessions::default();
    sessions.set_profile("gateway-one".into());
    sessions
}

fn select(sessions: &mut Sessions<Prepared>, key: &str) -> Option<Prepared> {
    sessions.switch(key.into(), Some("agent".into()), None, Prepared::default())
}

fn load(sessions: &mut Sessions<Prepared>, text: &str) {
    let request = sessions.begin_history().unwrap();
    assert!(sessions.apply_history(
        &request,
        &json!({
            "messages": [{"role":"user", "content":text, "id":text}],
            "sessionId":"generation-one", "deltaCursor":"cursor-one"
        })
    ));
}

#[test]
fn returning_to_a_session_restores_rows_tools_live_run_and_viewport_before_catch_up() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    let initial = sessions.begin_history().unwrap();
    assert!(initial.startup);
    assert!(initial.cursor.is_none());
    assert!(sessions.loading);
    assert!(sessions.apply_history(
        &initial,
        &json!({
            "messages":[{"role":"assistant", "id":"answer", "runId":"run", "content":[
                {"type":"text", "text":"**Prepared answer**"},
                {"type":"toolCall", "id":"read", "name":"read", "arguments":{"path":"note.txt"}}
            ]}],
            "sessionId":"generation-one", "deltaCursor":"cursor-one",
            "inFlightRun":{"runId":"run", "text":"Still writing", "startedAt":123}
        })
    ));
    assert!(sessions.apply_agent_event(&json!({
        "sessionKey":"a", "agentId":"agent", "runId":"run", "stream":"tool", "seq":1,
        "ts":124, "data":{"phase":"start", "toolCallId":"search", "name":"search"}
    })));
    sessions.switch(
        "b".into(),
        Some("agent".into()),
        None,
        Prepared {
            rows: vec!["prepared markdown row", "expanded tool card"],
            scroll: 27,
            bytes: 256,
            ..Default::default()
        },
    );
    load(&mut sessions, "Session B");

    let restored = select(&mut sessions, "a").unwrap();
    assert_eq!(
        restored.rows,
        ["prepared markdown row", "expanded tool card"]
    );
    assert_eq!(restored.scroll, 27);
    assert_eq!(sessions.messages.len(), 1);
    assert_eq!(sessions.messages[0].text, "**Prepared answer**");
    assert_eq!(sessions.messages[0].tools[0].status(), "Running");
    assert_eq!(sessions.live_tools[0].id, "search");
    assert_eq!(sessions.active_run.as_deref(), Some("run"));
    assert_eq!(sessions.stream_text, "Still writing");
    assert_eq!(sessions.started_at, Some(123));
    assert!(sessions.loaded);
    assert!(!sessions.loading);

    let catch_up = sessions.begin_history().unwrap();
    assert!(!catch_up.startup);
    assert!(catch_up.offset.is_none());
    assert_eq!(catch_up.cursor.as_deref(), Some("cursor-one"));
    assert!(
        !sessions.loading,
        "cached rows remain renderable during catch-up"
    );
    assert!(sessions.history_failed(&catch_up, "temporarily offline".into()));
    assert_eq!(sessions.messages[0].text, "**Prepared answer**");
}

#[test]
fn reselecting_current_generation_keeps_its_viewport_and_pending_history_valid() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    let pending = sessions.begin_history().unwrap();
    let prepared = sessions
        .switch(
            "a".into(),
            Some("agent".into()),
            Some("generation-one"),
            Prepared {
                rows: vec!["prepared A"],
                scroll: 19,
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(prepared.rows, ["prepared A"]);
    assert_eq!(prepared.scroll, 19);
    assert_eq!(sessions.messages[0].text, "A");
    assert!(sessions.loaded);
    assert!(!sessions.loading);
    assert!(sessions.apply_history(&pending, &json!({
        "kind":"delta", "deltaCursor":"cursor-two", "sessionInfo":{"sessionId":"generation-one"},
        "messages":[{"messageId":"A", "message":{"role":"user", "content":"Updated A"}}]
    })));
    assert_eq!(sessions.messages[0].text, "Updated A");
}

#[test]
fn count_bound_evicts_the_least_recently_opened_transcript_and_its_prepared_rows() {
    let mut sessions = sessions();
    sessions.max_sessions = 3;
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    select(&mut sessions, "b");
    load(&mut sessions, "B");
    let dropped_b = Rc::new(Cell::new(0));
    sessions.switch(
        "c".into(),
        Some("agent".into()),
        None,
        Prepared {
            _receipt: Some(DropReceipt(dropped_b.clone())),
            ..Default::default()
        },
    );
    load(&mut sessions, "C");
    assert!(select(&mut sessions, "a").is_some());
    assert_eq!(sessions.messages[0].text, "A");
    select(&mut sessions, "d");

    assert_eq!(sessions.cached_count(), 2);
    assert!(sessions.contains("a", Some("agent")));
    assert!(sessions.contains("c", Some("agent")));
    assert!(!sessions.contains("b", Some("agent")));
    assert_eq!(dropped_b.get(), 1);
    assert!(
        sessions
            .prefetch("e".into(), Some("agent".into()))
            .is_none()
    );
    assert!(select(&mut sessions, "b").is_none());
    assert!(sessions.begin_history().unwrap().startup);
    assert!(sessions.messages.is_empty());
}

#[test]
fn byte_bound_accounts_for_prepared_rows_and_releases_oversized_sessions() {
    let mut sessions = sessions();
    sessions.max_bytes = 24 * 1024;
    let dropped_a = Rc::new(Cell::new(0));
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    sessions.switch(
        "b".into(),
        Some("agent".into()),
        None,
        Prepared {
            bytes: 16 * 1024,
            _receipt: Some(DropReceipt(dropped_a.clone())),
            ..Default::default()
        },
    );
    load(&mut sessions, "B");
    sessions.switch(
        "c".into(),
        Some("agent".into()),
        None,
        Prepared {
            bytes: 16 * 1024,
            ..Default::default()
        },
    );
    assert!(!sessions.contains("a", Some("agent")));
    assert!(sessions.contains("b", Some("agent")));
    assert_eq!(dropped_a.get(), 1);
    assert!(sessions.cached_bytes() <= 24 * 1024);

    load(&mut sessions, "Oversized");
    let dropped_large = Rc::new(Cell::new(0));
    sessions.switch(
        "d".into(),
        Some("agent".into()),
        None,
        Prepared {
            bytes: 13 * 1024 * 1024,
            _receipt: Some(DropReceipt(dropped_large.clone())),
            ..Default::default()
        },
    );
    assert!(!sessions.contains("c", Some("agent")));
    assert_eq!(dropped_large.get(), 1);
}

#[test]
fn a_b_a_and_reconnect_reject_prior_requests_without_clearing_cached_content() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    let before_switch = sessions.begin_history().unwrap();
    let before_switch_claim = sessions.history_claim().unwrap();
    select(&mut sessions, "b");
    load(&mut sessions, "B");
    select(&mut sessions, "a");
    assert!(!sessions.apply_history(&before_switch, &json!({"messages":[]})));
    assert!(!sessions.history_failed(&before_switch, "old failure".into()));
    assert!(!sessions.deny_history(&before_switch_claim));
    let before_reconnect = sessions.begin_history().unwrap();
    let before_reconnect_claim = sessions.history_claim().unwrap();
    sessions.reconnect();
    assert!(!sessions.apply_history(&before_reconnect, &json!({"messages":[]})));
    assert!(!sessions.deny_history(&before_reconnect_claim));
    assert_eq!(sessions.messages[0].text, "A");
    assert!(!sessions.loading);
    let catch_up = sessions.begin_history().unwrap();
    assert_eq!(catch_up.cursor.as_deref(), Some("cursor-one"));
    assert!(!catch_up.startup);
    assert!(select(&mut sessions, "b").is_some());
    assert_eq!(sessions.messages[0].text, "B");
    sessions.begin_history().unwrap();
    let superseded_claim = sessions.history_claim().unwrap();
    let current = sessions.begin_history().unwrap();
    let current_claim = sessions.history_claim().unwrap();
    assert!(!sessions.deny_history(&superseded_claim));
    assert_eq!(sessions.messages[0].text, "B");
    assert!(sessions.deny_history(&current_claim));
    assert!(sessions.messages.is_empty());
    assert!(!sessions.loaded);
    assert!(!sessions.apply_history(&current, &json!({"messages":[]})));
    assert!(select(&mut sessions, "a").is_some());
    assert_eq!(sessions.messages[0].text, "A");
}

#[test]
fn background_history_denial_retires_only_the_entry_that_issued_the_request() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    sessions.begin_history().unwrap();
    let denied = sessions.history_claim().unwrap();
    select(&mut sessions, "b");
    load(&mut sessions, "B");
    select(&mut sessions, "c");
    load(&mut sessions, "C");
    assert!(!sessions.deny_history(&denied));
    assert!(!sessions.contains("a", Some("agent")));
    assert!(sessions.contains("b", Some("agent")));
    assert_eq!(sessions.selected_session.as_deref(), Some("c"));
    assert_eq!(sessions.messages[0].text, "C");
    assert!(select(&mut sessions, "a").is_none());
    assert!(sessions.begin_history().unwrap().startup);
}

#[test]
fn identical_session_keys_remain_isolated_by_agent_including_an_unspecified_agent() {
    let mut sessions = sessions();
    for (agent, text) in [
        (Some("one"), "One"),
        (Some("two"), "Two"),
        (None, "Unscoped"),
    ] {
        assert!(
            sessions
                .switch(
                    "shared".into(),
                    agent.map(str::to_owned),
                    None,
                    Prepared::default()
                )
                .is_none()
        );
        assert!(sessions.messages.is_empty());
        load(&mut sessions, text);
    }
    for (agent, text) in [
        (Some("one"), "One"),
        (None, "Unscoped"),
        (Some("two"), "Two"),
    ] {
        assert!(
            sessions
                .switch(
                    "shared".into(),
                    agent.map(str::to_owned),
                    None,
                    Prepared::default()
                )
                .is_some()
        );
        assert_eq!(sessions.messages[0].text, text);
        assert_eq!(sessions.selected_agent.as_deref(), agent);
    }
}

#[test]
fn session_identity_change_never_restores_previous_generation_rows_or_requests() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "Previous generation");
    let retired = sessions.begin_history().unwrap();
    select(&mut sessions, "b");
    assert!(
        sessions
            .switch(
                "a".into(),
                Some("agent".into()),
                Some("generation-two"),
                Prepared::default()
            )
            .is_none()
    );
    assert!(sessions.messages.is_empty());
    assert!(sessions.delta_cursor.is_none());
    assert!(!sessions.apply_history(&retired, &json!({"messages":[]})));
    let replacement = sessions.begin_history().unwrap();
    assert!(replacement.startup);
    assert!(sessions.apply_history(
        &replacement,
        &json!({
            "sessionId":"generation-two", "deltaCursor":"cursor-two",
            "messages":[{"role":"user", "content":"New generation"}]
        })
    ));
    assert_eq!(sessions.messages[0].text, "New generation");
}

#[test]
fn cursor_delta_appends_and_reconciles_overlap_without_becoming_older_pagination() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    let initial = sessions.begin_history().unwrap();
    assert!(sessions.apply_history(
        &initial,
        &json!({
            "sessionId":"generation-one", "deltaCursor":"cursor-one",
            "messages":[{"role":"assistant", "id":"answer", "content":"Before"}],
            "hasMore":true, "nextOffset":10, "totalMessages":20
        })
    ));
    select(&mut sessions, "b");
    select(&mut sessions, "a");
    let request = sessions.begin_history().unwrap();
    assert_eq!(request.cursor.as_deref(), Some("cursor-one"));
    assert!(sessions.apply_history(&request, &json!({
        "kind":"delta", "deltaCursor":"cursor-two", "sessionInfo":{"sessionId":"generation-one"},
        "messages":[
            {"messageId":"answer", "message":{"role":"assistant", "content":"Updated"}},
            {"messageId":"next", "message":{"role":"user", "content":"Next"}},
            {"messageId":"next", "message":{"role":"user", "content":"Next"}},
            {"sessionKey":"other", "messageId":"foreign", "message":{"role":"user", "content":"Wrong session"}},
            {"agentId":"other", "messageId":"foreign-agent", "message":{"role":"user", "content":"Wrong agent"}},
            {"sessionId":"retired", "messageId":"foreign-generation", "message":{"role":"user", "content":"Wrong generation"}}
        ]
    })));
    assert_eq!(
        sessions
            .messages
            .iter()
            .map(|message| message.text.as_str())
            .collect::<Vec<_>>(),
        ["Updated", "Next"]
    );
    assert_eq!(sessions.delta_cursor.as_deref(), Some("cursor-two"));
    assert_eq!(sessions.next_offset, Some(10));
    let probe = sessions.begin_older().unwrap();
    assert!(probe.rebase_offset);
    assert!(probe.cursor.is_none());
    assert!(probe.offset.is_none());
    assert!(sessions.apply_history(
        &probe,
        &json!({"sessionId":"generation-one", "totalMessages":21})
    ));
    let older = sessions.begin_older().unwrap();
    assert_eq!(older.offset, Some(11));
    assert!(!older.rebase_offset);
    assert!(older.cursor.is_none());
    assert!(!older.startup);
}

#[test]
fn cursor_reset_keeps_visible_rows_until_authoritative_replacement_then_discards_old_run() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "Old transcript");
    sessions.apply_event(&json!({
        "sessionKey":"a", "agentId":"agent", "runId":"old-run", "state":"delta", "seq":1, "deltaText":"Old stream"
    }));
    let request = sessions.begin_history().unwrap();
    assert!(sessions.apply_history(&request, &json!({"kind":"reset"})));
    assert_eq!(sessions.messages[0].text, "Old transcript");
    assert!(!sessions.loading);
    assert!(sessions.needs_history_replacement());
    let replacement = sessions.begin_history().unwrap();
    assert!(replacement.cursor.is_none());
    assert!(replacement.offset.is_none());
    assert!(!sessions.needs_history_replacement());
    assert!(sessions.history_failed(&replacement, "History unavailable".into()));
    assert!(
        !sessions.needs_history_replacement(),
        "failure must stop automatic reset retries"
    );
    assert_eq!(sessions.messages[0].text, "Old transcript");
    assert_eq!(
        sessions.history_error.as_deref(),
        Some("History unavailable")
    );
    assert!(!sessions.loading);
    let replacement = sessions.begin_history().unwrap();
    assert!(replacement.cursor.is_none());
    assert!(replacement.offset.is_none());
    assert!(sessions.apply_history(
        &replacement,
        &json!({
            "sessionId":"generation-two", "deltaCursor":"replacement-cursor",
            "messages":[{"role":"assistant", "content":"Replacement"}]
        })
    ));
    assert_eq!(sessions.messages.len(), 1);
    assert_eq!(sessions.messages[0].text, "Replacement");
    assert!(sessions.active_run.is_none());
    assert!(sessions.stream_text.is_empty());
    assert!(sessions.history_error.is_none());
    assert!(!sessions.needs_history_replacement());
    assert_eq!(sessions.delta_cursor.as_deref(), Some("replacement-cursor"));
}

#[test]
fn backscroll_rebases_raw_count_after_deltas_including_omitted_hidden_records() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    let initial = sessions.begin_history().unwrap();
    assert!(sessions.apply_history(&initial, &json!({
        "sessionId":"generation-one", "deltaCursor":"cursor-one", "hasMore":true, "nextOffset":5, "totalMessages":10,
        "messages":[{"role":"user", "id":"question", "content":"Question  \n\n**literal**\n", "__openclaw":{"seq":10}}]
    })));
    let delta = json!({
        "kind":"delta", "deltaCursor":"cursor-two", "sessionInfo":{"sessionId":"generation-one"},
        "messages":[
            {"messageSeq":11, "messageId":"hidden-before", "message":{"role":"assistant", "content":""}},
            {"messageSeq":12, "messageId":"answer", "message":{"role":"assistant", "content":"Visible answer"}},
            {"messageSeq":13, "messageId":"hidden-after", "message":{"role":"assistant", "content":""}}
        ]
    });
    let catch_up = sessions.begin_history().unwrap();
    assert!(sessions.apply_history(&catch_up, &delta));
    assert_eq!(sessions.messages.len(), 2);
    assert_eq!(sessions.messages[1].text, "Visible answer");
    assert_eq!(sessions.next_offset, Some(5));

    let overlap = sessions.begin_history().unwrap();
    assert!(sessions.apply_history(&overlap, &delta));
    assert_eq!(sessions.messages.len(), 2);
    let probe = sessions.begin_older().unwrap();
    assert!(probe.rebase_offset);
    assert!(probe.cursor.is_none());
    assert!(probe.offset.is_none());
    assert!(sessions.apply_history(&probe, &json!({
        "sessionId":"generation-one", "totalMessages":13,
        "messages":[{"role":"assistant", "id":"answer", "content":"Probe must not replace displayed rows"}]
    })));
    assert_eq!(sessions.messages[0].text, "Question  \n\n**literal**\n");
    assert_eq!(sessions.messages[1].text, "Visible answer");
    let older = sessions.begin_older().unwrap();
    assert_eq!(
        older.offset,
        Some(8),
        "overlap must not advance the raw offset twice"
    );
    assert!(!older.rebase_offset);
    assert!(sessions.apply_history(&older, &json!({
        "sessionId":"generation-one", "totalMessages":13, "messages":[], "hasMore":true, "nextOffset":9
    })));
    let empty_delta = sessions.begin_history().unwrap();
    assert!(sessions.apply_history(&empty_delta, &json!({
        "kind":"delta", "deltaCursor":"cursor-three", "sessionInfo":{"sessionId":"generation-one"}, "messages":[]
    })));
    let probe = sessions.begin_older().unwrap();
    assert!(
        probe.rebase_offset,
        "a cursor can advance without a delivered message envelope"
    );
    assert!(sessions.apply_history(
        &probe,
        &json!({"sessionId":"generation-one", "totalMessages":14})
    ));
    assert_eq!(sessions.messages.len(), 2);
    assert_eq!(sessions.messages[0].text, "Question  \n\n**literal**\n");
    assert_eq!(sessions.messages[1].text, "Visible answer");
    assert_eq!(sessions.delta_cursor.as_deref(), Some("cursor-three"));
    let older = sessions.begin_older().unwrap();
    assert_eq!(older.offset, Some(10));
    assert!(!older.rebase_offset);
}

#[test]
fn background_events_cannot_publish_into_selected_session_and_reopen_catches_up() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    select(&mut sessions, "b");
    load(&mut sessions, "B");
    let chat_event = json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "state":"delta", "seq":1, "deltaText":"A live"});
    assert!(!sessions.observe_event("chat", &chat_event));
    assert!(!sessions.apply_event(&chat_event).changed);
    let tool_event = json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "stream":"tool", "seq":2, "ts":100, "data":{"phase":"start", "toolCallId":"a-tool", "name":"read"}});
    assert!(!sessions.observe_event("agent", &tool_event));
    assert!(!sessions.apply_agent_event(&tool_event));
    assert_eq!(sessions.messages[0].text, "B");
    assert!(sessions.active_run.is_none());
    assert!(sessions.live_tools.is_empty());
    select(&mut sessions, "a");
    assert_eq!(sessions.messages[0].text, "A");
    let catch_up = sessions.begin_history().unwrap();
    assert_eq!(catch_up.cursor.as_deref(), Some("cursor-one"));
    assert!(sessions.apply_history(&catch_up, &json!({
        "kind":"delta", "deltaCursor":"cursor-two", "sessionInfo":{"sessionId":"generation-one"},
        "messages":[], "inFlightRun":{"runId":"a-run", "text":"A live", "startedAt":100}
    })));
    assert_eq!(sessions.stream_text, "A live");
}

#[test]
fn structural_events_invalidate_only_their_session_and_fence_pending_history() {
    for (name, event) in [
        (
            "sessions.changed",
            json!({"sessionKey":"a", "agentId":"agent", "reason":"reset"}),
        ),
        (
            "sessions.changed",
            json!({"sessionKey":"a", "agentId":"agent", "reason":"delete"}),
        ),
        (
            "sessions.changed",
            json!({"sessionKey":"a", "agentId":"agent", "reason":"compaction"}),
        ),
        (
            "sessions.changed",
            json!({"sessionKey":"a", "agentId":"agent", "reason":"sharing"}),
        ),
        (
            "sessions.changed",
            json!({"sessionKey":"a", "agentId":"agent", "phase":"message"}),
        ),
        (
            "agent",
            json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "stream":"compaction", "data":{"phase":"end", "completed":true}}),
        ),
        (
            "session.tool",
            json!({"runId":"a-run", "stream":"compaction", "data":{"phase":"end", "completed":true, "willRetry":true}}),
        ),
        (
            "sessions.changed",
            json!({"agentId":"agent", "session":{"key":"a", "sessionId":"generation-two"}}),
        ),
        (
            "session.operation",
            json!({"sessionKey":"a", "agentId":"agent", "operation":"compact", "phase":"end", "completed":true}),
        ),
    ] {
        for selected in [false, true] {
            let mut sessions = sessions();
            select(&mut sessions, "b");
            load(&mut sessions, "B");
            select(&mut sessions, "a");
            load(&mut sessions, "A");
            assert!(sessions.apply_event(&json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "state":"delta", "seq":1, "deltaText":"Running"})).changed);
            let retired = sessions.begin_history().unwrap();
            if !selected {
                select(&mut sessions, "b");
            }
            assert_eq!(
                sessions.observe_event(name, &event),
                selected,
                "{name}: {event}"
            );
            assert!(sessions.contains("b", Some("agent")));
            if !selected {
                assert_eq!(sessions.messages[0].text, "B");
                assert!(select(&mut sessions, "a").is_none());
            }
            assert!(!sessions.loaded);
            assert!(sessions.messages.is_empty());
            assert!(sessions.delta_cursor.is_none());
            assert!(!sessions.apply_history(&retired, &json!({"messages":[]})));
        }
    }
}

#[test]
fn delayed_generation_delete_cannot_retire_reopened_session() {
    for reason in ["delete", "cleanup"] {
        for selected in [false, true] {
            let mut sessions = sessions();
            select(&mut sessions, "a");
            load(&mut sessions, "New A");
            if !selected {
                select(&mut sessions, "b");
                load(&mut sessions, "B");
            }
            assert!(!sessions.invalidate_generation(
                "a",
                Some("agent"),
                Some("retired-generation")
            ));
            let event = if reason == "delete" {
                json!({"reason":reason, "sessionKey":"a", "agentId":"agent", "sessionId":"retired-generation"})
            } else {
                json!({"reason":reason, "agentId":"agent", "session":{"key":"a", "sessionId":"retired-generation"}})
            };
            assert!(!sessions.observe_event("sessions.changed", &event));
            assert!(sessions.contains("a", Some("agent")));
            assert_eq!(
                sessions.messages[0].text,
                if selected { "New A" } else { "B" }
            );
            assert_eq!(sessions.observe_event("sessions.changed", &json!({
                "reason":reason, "sessionKey":"a", "agentId":"agent", "sessionId":"generation-one"
            })), selected);
            if selected {
                assert!(sessions.messages.is_empty());
                assert!(!sessions.loaded);
            } else {
                assert_eq!(sessions.messages[0].text, "B");
                assert!(!sessions.contains("a", Some("agent")));
                assert!(select(&mut sessions, "a").is_none());
            }
        }
    }
}

#[test]
fn failed_or_unrelated_compaction_does_not_discard_cached_content() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    assert!(sessions.apply_event(&json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "state":"delta", "seq":1, "deltaText":"Running"})).changed);
    select(&mut sessions, "b");
    load(&mut sessions, "B");
    for event in [
        json!({"sessionKey":"a", "agentId":"agent", "operation":"compact", "phase":"start", "completed":false}),
        json!({"sessionKey":"a", "agentId":"agent", "operation":"compact", "phase":"end", "completed":false}),
        json!({"sessionKey":"a", "agentId":"other", "operation":"compact", "phase":"end", "completed":true}),
    ] {
        assert!(!sessions.observe_event("session.operation", &event));
        assert!(sessions.contains("a", Some("agent")));
    }
    for name in ["agent", "session.tool"] {
        for event in [
            json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "stream":"compaction", "data":{"phase":"start", "completed":true}}),
            json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "stream":"compaction", "data":{"phase":"end", "completed":false}}),
            json!({"sessionKey":"a", "agentId":"agent", "runId":"a-run", "stream":"compaction", "data":{"phase":"end"}}),
            json!({"sessionKey":"a", "agentId":"agent", "runId":"retired-run", "stream":"compaction", "data":{"phase":"end", "completed":true}}),
            json!({"sessionKey":"a", "agentId":"other", "runId":"a-run", "stream":"compaction", "data":{"phase":"end", "completed":true}}),
        ] {
            assert!(!sessions.observe_event(name, &event));
            assert!(sessions.contains("a", Some("agent")));
        }
    }
    assert!(!sessions.observe_event(
        "sessions.changed",
        &json!({
            "sessionKey":"a", "agentId":"agent", "phase":"message", "messageSeq":12
        })
    ));
    assert!(select(&mut sessions, "a").is_some());
    assert_eq!(sessions.messages[0].text, "A");
    assert_eq!(sessions.active_run.as_deref(), Some("a-run"));
}

#[test]
fn profile_identity_authority_or_broad_sharing_change_discards_all_transcripts_and_old_requests() {
    for boundary in ["profile", "identity", "authority", "sharing"] {
        let mut sessions = sessions();
        let authority = json!({"identity":"operator", "scopes":["read", "write"]});
        assert!(!sessions.set_authority(authority.clone()));
        assert!(!sessions.set_identity("operator-one".into()));
        select(&mut sessions, "a");
        load(&mut sessions, "A");
        select(&mut sessions, "b");
        load(&mut sessions, "B");
        let retired = sessions.begin_history().unwrap();
        assert!(!sessions.set_profile("gateway-one".into()));
        assert!(!sessions.set_authority(authority));
        assert!(!sessions.set_identity("operator-one".into()));
        assert_eq!(sessions.messages[0].text, "B");
        match boundary {
            "profile" => assert!(sessions.set_profile("gateway-two".into())),
            "identity" => assert!(sessions.set_identity("operator-two".into())),
            "authority" => {
                assert!(sessions.set_authority(json!({"identity":"operator", "scopes":["read"]})))
            }
            "sharing" => {
                assert!(sessions.observe_event("sessions.changed", &json!({"reason":"sharing"})))
            }
            _ => unreachable!(),
        }
        assert!(sessions.messages.is_empty());
        assert_eq!(
            sessions.selected_session.as_deref(),
            (boundary == "sharing").then_some("b")
        );
        assert_eq!(sessions.cached_count(), 0);
        assert!(!sessions.apply_history(&retired, &json!({"messages":[]})));
        assert!(select(&mut sessions, "a").is_none());
        assert!(sessions.begin_history().unwrap().startup);
    }
}

#[test]
fn prefetch_cannot_repopulate_retired_contexts_or_replace_a_foreground_load() {
    for boundary in [
        "switch",
        "reconnect",
        "reset",
        "profile",
        "identity",
        "authority",
        "sharing-scoped",
        "sharing-broad",
        "foreground",
    ] {
        let mut sessions = sessions();
        sessions.set_authority(json!({"identity":"one"}));
        sessions.set_identity("operator-one".into());
        select(&mut sessions, "a");
        load(&mut sessions, "A");
        let (generation, mut background, request) =
            sessions.prefetch("b".into(), Some("agent".into())).unwrap();
        assert!(background.apply_history(
            &request,
            &json!({"messages":[{"role":"user", "content":"Background B"}]})
        ));
        match boundary {
            "switch" => {
                select(&mut sessions, "c");
            }
            "reconnect" => sessions.reconnect(),
            "reset" => {
                sessions.invalidate("b", Some("agent"));
            }
            "profile" => {
                sessions.set_profile("other".into());
            }
            "authority" => {
                sessions.set_authority(json!({"identity":"two"}));
            }
            "identity" => {
                sessions.set_identity("operator-two".into());
            }
            "sharing-scoped" => {
                sessions.observe_event(
                    "sessions.changed",
                    &json!({"sessionKey":"b", "agentId":"agent", "reason":"sharing"}),
                );
            }
            "sharing-broad" => {
                sessions.observe_event("sessions.changed", &json!({"reason":"sharing"}));
            }
            "foreground" => {
                select(&mut sessions, "b");
                load(&mut sessions, "Foreground B");
            }
            _ => unreachable!(),
        }
        sessions.finish_prefetch(generation, background);
        if boundary == "foreground" {
            assert_eq!(sessions.messages[0].text, "Foreground B");
        } else {
            assert!(!sessions.contains("b", Some("agent")), "{boundary}");
        }
    }
}

#[test]
fn speculative_prefetch_cannot_evict_opened_transcripts_to_fit_the_byte_budget() {
    let mut sessions = sessions();
    sessions.max_bytes = 24 * 1024;
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    let dropped_a = Rc::new(Cell::new(0));
    sessions.switch(
        "b".into(),
        Some("agent".into()),
        None,
        Prepared {
            rows: vec!["prepared A"],
            bytes: 16 * 1024,
            _receipt: Some(DropReceipt(dropped_a.clone())),
            ..Default::default()
        },
    );
    load(&mut sessions, "B");
    let (generation, mut background, request) =
        sessions.prefetch("c".into(), Some("agent".into())).unwrap();
    assert!(background.apply_history(
        &request,
        &json!({
            "messages":[{"role":"assistant", "content":"c".repeat(8 * 1024)}]
        })
    ));
    sessions.finish_prefetch(generation, background);
    assert!(!sessions.contains("c", Some("agent")));
    assert_eq!(sessions.messages[0].text, "B");
    assert_eq!(dropped_a.get(), 0);
    let restored = select(&mut sessions, "a").unwrap();
    assert_eq!(restored.rows, ["prepared A"]);
    assert_eq!(sessions.messages[0].text, "A");
}

#[test]
fn prefetch_admission_counts_selected_prepared_rows_even_without_inactive_entries() {
    let mut sessions = sessions();
    sessions.max_bytes = 24 * 1024;
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    sessions.bound_memory(20 * 1024);
    assert_eq!(sessions.cached_count(), 0);
    let (generation, mut background, request) =
        sessions.prefetch("b".into(), Some("agent".into())).unwrap();
    assert!(background.apply_history(
        &request,
        &json!({
            "messages":[{"role":"assistant", "content":"B".repeat(8 * 1024)}]
        })
    ));
    sessions.finish_prefetch(generation, background);
    assert_eq!(sessions.cached_count(), 0);
    assert!(!sessions.contains("b", Some("agent")));
    assert_eq!(sessions.selected_session.as_deref(), Some("a"));
    assert_eq!(sessions.messages[0].text, "A");
}

#[test]
fn prefetched_rows_render_immediately_but_first_open_still_requests_startup_metadata() {
    let mut sessions = sessions();
    select(&mut sessions, "a");
    load(&mut sessions, "A");
    let (generation, mut background, prefetch) =
        sessions.prefetch("b".into(), Some("agent".into())).unwrap();
    assert!(!prefetch.startup);
    assert!(background.apply_history(
        &prefetch,
        &json!({
            "sessionId":"generation-b", "deltaCursor":"prefetch-cursor",
            "messages":[{"role":"assistant", "content":"Prefetched B"}]
        })
    ));
    sessions.finish_prefetch(generation, background);
    select(&mut sessions, "b");
    assert!(sessions.loaded);
    assert!(!sessions.loading);
    assert_eq!(sessions.messages[0].text, "Prefetched B");
    let first_open = sessions.begin_history().unwrap();
    assert!(first_open.startup);
    assert_eq!(first_open.cursor.as_deref(), Some("prefetch-cursor"));
    assert!(!sessions.loading);
    assert!(sessions.apply_history(
        &first_open,
        &json!({
            "kind":"delta", "messages":[], "deltaCursor":"opened-cursor",
            "sessionInfo":{"sessionId":"generation-b", "model":"model-b"}
        })
    ));
    assert_eq!(sessions.messages[0].text, "Prefetched B");
    assert_eq!(sessions.session_info.model.as_deref(), Some("model-b"));
    select(&mut sessions, "a");
    select(&mut sessions, "b");
    let reopened = sessions.begin_history().unwrap();
    assert!(!reopened.startup);
    assert_eq!(reopened.cursor.as_deref(), Some("opened-cursor"));
}

#[test]
fn growth_of_selected_history_or_prepared_rows_evicts_inactive_transcripts() {
    for growth in ["history", "prepared"] {
        let mut sessions = sessions();
        sessions.max_bytes = 24 * 1024;
        select(&mut sessions, "a");
        load(&mut sessions, "A");
        let dropped_a = Rc::new(Cell::new(0));
        sessions.switch(
            "b".into(),
            Some("agent".into()),
            None,
            Prepared {
                bytes: 16 * 1024,
                _receipt: Some(DropReceipt(dropped_a.clone())),
                ..Default::default()
            },
        );
        load(&mut sessions, "B");
        assert!(sessions.contains("a", Some("agent")));
        assert_eq!(dropped_a.get(), 0);
        let expected = if growth == "history" {
            "B".repeat(16 * 1024)
        } else {
            "B".into()
        };
        if growth == "history" {
            load(&mut sessions, &expected);
        } else {
            sessions.bound_memory(16 * 1024);
        }
        assert_eq!(sessions.selected_session.as_deref(), Some("b"));
        assert_eq!(sessions.messages[0].text, expected);
        assert_eq!(sessions.cached_count(), 0, "{growth}");
        assert!(!sessions.contains("a", Some("agent")));
        assert_eq!(dropped_a.get(), 1, "{growth}");
    }
}
