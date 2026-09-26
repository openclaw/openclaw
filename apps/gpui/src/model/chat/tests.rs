use super::*;
use serde_json::json;

fn chat() -> ChatState {
    let mut chat = ChatState::default();
    chat.select_context("main".to_owned(), None);
    chat
}

fn displayed_tools(chat: &ChatState) -> Vec<ToolCall> {
    (0..chat.messages.len())
        .flat_map(|index| chat.history_tools(index))
        .chain(chat.streaming_tools())
        .collect()
}

#[test]
fn newer_terminal_tool_result_wins_over_stale_completed_history() {
    let mut chat = chat();
    let mut snapshot = json!({"messages":[{"role":"assistant","runId":"run","content":[
        {"type":"toolCall","id":"read","name":"read","arguments":{"path":"proof-note.txt"}}
    ]}],"inFlightRun":{"runId":"run"}});
    let initial = chat.begin_history().unwrap();
    chat.apply_history(&initial, &snapshot);
    chat.apply_event(&json!({"sessionKey":"main","runId":"run","state":"aborted","seq":2}));
    let stale = chat.begin_history().unwrap();
    assert!(chat.apply_agent_event(&json!({"sessionKey":"main","runId":"run","stream":"tool","seq":3,"ts":300,"data":{"phase":"result","toolCallId":"read","result":"file contents"}})));
    snapshot["messages"].as_array_mut().unwrap().push(json!({"role":"toolResult","runId":"run","toolCallId":"read","content":"Aborted","isError":true,"timestamp":200}));
    assert!(chat.apply_history(&stale, &snapshot));
    let tools = displayed_tools(&chat);
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].status(), "Done");
    assert_eq!(tools[0].output, "file contents");
    assert!(chat.active_run.is_none());
    let fresh = chat.begin_history().unwrap();
    chat.apply_event(
        &json!({"sessionKey":"main","runId":"next","state":"delta","seq":1,"deltaText":"new turn"}),
    );
    snapshot["messages"][1]["content"] = json!("authoritative result");
    snapshot["messages"][1]["isError"] = json!(false);
    assert!(chat.apply_history(&fresh, &snapshot));
    assert_eq!(
        displayed_tools(&chat)[0].output,
        "authoritative result",
        "unrelated new activity must not make an older tool result outrank the history receipt"
    );
    assert_eq!(chat.stream_text, "new turn");
}

#[test]
fn history_rejects_all_retired_stream_fields_and_resets_a_new_run() {
    let mut chat = chat();
    chat.apply_event(&json!({"sessionKey":"main","runId":"retired","state":"final","seq":1}));
    let history = chat.begin_history().unwrap();
    chat.apply_history(&history, &json!({"messages":[],"inFlightRun":{"runId":"retired","text":"stale text","startedAt":100}}));
    assert!(chat.active_run.is_none());
    assert!(chat.started_at.is_none());
    assert!(chat.stream_text.is_empty());
    chat.apply_event(&json!({"sessionKey":"main","runId":"next","state":"delta","seq":1,"deltaText":"fresh text"}));
    assert_eq!(chat.stream_text, "fresh text");
    chat.apply_agent_event(&json!({"sessionKey":"main","runId":"next","stream":"thinking","data":{"text":"earlier thoughts"}}));
    chat.apply_agent_event(
        &json!({"sessionKey":"main","runId":"next","stream":"usage","data":{"outputTokens":20}}),
    );
    chat.apply_agent_event(&json!({"sessionKey":"main","runId":"next","stream":"tool","seq":2,"ts":200,"data":{"phase":"start","toolCallId":"earlier-tool","name":"read"}}));
    let newer = chat.begin_history().unwrap();
    chat.apply_history(
        &newer,
        &json!({"messages":[],"inFlightRun":{"runId":"newer","text":"new stream","startedAt":300}}),
    );
    assert_eq!(chat.active_run.as_deref(), Some("newer"));
    assert_eq!(chat.stream_text, "new stream");
    assert_eq!(chat.started_at, Some(300));
    assert!(chat.stream_thinking.is_empty());
    assert!(chat.live_tools.is_empty());
    assert_eq!(chat.output_tokens, 0);
    assert!(chat.phase_label.is_empty());
}

#[test]
fn history_replay_recovers_only_unambiguous_producer_encoded_bridge_parent() {
    let args = json!({"questions":[{"question":"What should we work on next?"}]});
    for (parents, child_id, expected) in [
        (
            vec!["call_mock_tool_call_bc25e95b40_3|fc_mock_tool_call_bc25e95b40_3"],
            "tool_search_code:call_mock_tool_call_bc25e95b40_3_fc_mock_tool_call_bc25e95b40_3:ask_user:1",
            1,
        ),
        (vec!["outer|fc"], "unrelated-question", 2),
        (
            vec!["outer|fc", "outer/fc"],
            "tool_search_code:outer_fc:ask_user:1",
            3,
        ),
    ] {
        let mut chat = chat();
        let history = chat.begin_history().unwrap();
        let calls: Vec<_> = parents.iter().map(|id| json!({"type":"toolCall","id":id,"name":"tool_call","arguments":{"id":"ask_user","args":args}})).collect();
        chat.apply_history(&history, &json!({
            "messages":[{"role":"assistant","__openclaw":{"runId":"run"},"content":calls}],
            "inFlightRun":{"runId":"run","events":[
                {"sessionKey":"main","runId":"run","stream":"tool","seq":10,"ts":100,"data":{"phase":"start","name":"ask_user","toolCallId":child_id,"args":args}}
            ]}
        }));
        let cards = displayed_tools(&chat);
        assert_eq!(cards.len(), expected, "replayed child {child_id}");
        assert!(cards.iter().all(|card| card.status() == "Running"));
    }
}

#[test]
fn history_receipt_cannot_resurrect_tool_after_live_result() {
    let mut chat = chat();
    let snapshot = json!({"messages":[{"role":"assistant","runId":"run","content":[
        {"type":"toolCall","id":"read","name":"read","arguments":{"path":"proof-note.txt"}}
    ]}],"inFlightRun":{"runId":"run"}});
    let initial = chat.begin_history().unwrap();
    chat.apply_history(&initial, &snapshot);
    let stale = chat.begin_history().unwrap();
    assert!(chat.apply_agent_event(&json!({"sessionKey":"main","runId":"run","stream":"tool","seq":2,"ts":200,"data":{"phase":"result","toolCallId":"read","result":"file contents"}})));
    assert!(chat.apply_history(&stale, &snapshot));
    let tools = displayed_tools(&chat);
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].status(), "Done");
    assert_eq!(tools[0].output, "file contents");
}

#[test]
fn tool_bridge_question_has_one_card_across_history_and_live_and_settles_after_sequence_reset() {
    let mut chat = chat();
    let history = chat.begin_history().unwrap();
    let args = json!({"questions":[{"question":"Which task?"}]});
    chat.apply_history(&history, &json!({"messages":[{
        "role":"assistant", "content":[{"type":"tool_call","id":"outer","name":"tool_call","args":{"id":"ask_user","args":args}}]
    }], "inFlightRun":{"runId":"run"}}));
    for (seq, data) in [
        (
            8,
            json!({"phase":"start","name":"tool_call","toolCallId":"outer","args":{"id":"ask_user","args":args}}),
        ),
        (
            10,
            json!({"phase":"start","name":"ask_user","toolCallId":"question","parentToolCallId":"outer","args":args}),
        ),
    ] {
        assert!(chat.apply_agent_event(&json!({"sessionKey":"main","runId":"run","stream":"tool","seq":seq,"ts":100+seq,"data":data})));
    }
    let tools = displayed_tools(&chat);
    assert_eq!(
        tools.len(),
        1,
        "one concrete question, not its bridge or history projection"
    );
    assert_eq!(tools[0].name, "ask_user");
    assert_eq!(tools[0].status(), "Running");
    let stale_history = chat.begin_history().unwrap();
    assert!(chat.apply_agent_event(&json!({"sessionKey":"main","runId":"run","stream":"tool","seq":1,"ts":200,"data":{"phase":"result","name":"ask_user","toolCallId":"question","parentToolCallId":"outer","result":"Aborted","isError":true}})));
    assert_eq!(displayed_tools(&chat)[0].status(), "Interrupted");
    assert!(chat.apply_history(&stale_history, &json!({"messages":[{
        "role":"assistant", "runId":"run", "content":[
            {"type":"toolCall","id":"outer","name":"tool_call","args":{"id":"ask_user","args":args}},
            {"type":"toolCall","id":"question","parentToolCallId":"outer","name":"ask_user","args":args}
        ]
    }], "inFlightRun":{"runId":"run"}})));
    assert_eq!(displayed_tools(&chat).len(), 1);
    assert_eq!(
        displayed_tools(&chat)[0].status(),
        "Interrupted",
        "an older history receipt must not erase a live result"
    );
}

#[test]
fn terminal_runs_settle_history_and_live_tools_without_overriding_completed_results() {
    for terminal in ["final", "aborted", "error"] {
        let mut chat = chat();
        let history = chat.begin_history().unwrap();
        chat.apply_history(
            &history,
            &json!({"messages":[{
            "role":"assistant", "runId":"run", "content":[
                {"type":"toolUse","id":"finished","name":"read","input":{"path":"proof-note.txt"}},
                {"type":"tool_result","tool_use_id":"finished","content":"file contents"},
                {"type":"toolCall","id":"waiting","name":"exec","arguments":{"command":"echo hi"}}
            ]
        }],"inFlightRun":{"runId":"run"}}),
        );
        chat.apply_agent_event(&json!({"sessionKey":"main","runId":"run","stream":"tool","seq":1,"ts":100,"data":{"phase":"start","toolCallId":"waiting","name":"exec","args":{"command":"echo hi"}}}));
        assert!(chat.apply_event(&json!({"sessionKey":"main","runId":"run","state":terminal,"seq":2,"message":{"role":"assistant","content":[{"type":"tool_call","id":"waiting","name":"exec","args":{"command":"echo hi"}}]}})).terminal);
        let tools = displayed_tools(&chat);
        assert_eq!(tools.len(), 2, "call/result and final snapshots must merge");
        assert_eq!(
            tools
                .iter()
                .find(|tool| tool.id == "finished")
                .unwrap()
                .status(),
            "Done"
        );
        assert_eq!(
            tools
                .iter()
                .find(|tool| tool.id == "waiting")
                .unwrap()
                .status(),
            "Interrupted"
        );
        assert!(tools.iter().all(|tool| !tool.running()));
        assert!(chat.apply_agent_event(&json!({"sessionKey":"main","runId":"run","stream":"tool","seq":1,"ts":300,"data":{"phase":"result","toolCallId":"waiting","result":"hi"}})));
        assert_eq!(
            displayed_tools(&chat)
                .iter()
                .find(|tool| tool.id == "waiting")
                .unwrap()
                .status(),
            "Done"
        );
        assert!(chat.active_run.is_none());
        assert!(!chat.apply_agent_event(&json!({"sessionKey":"main","runId":"run","stream":"tool","seq":4,"ts":400,"data":{"phase":"start","toolCallId":"late","name":"exec"}})));
    }
}

#[test]
fn stream_appends_replaces_repairs_snapshot_and_finalizes_once() {
    let mut chat = chat();
    for (seq, fields, expected) in [
        (1, json!({"deltaText": "hel"}), "hel"),
        (2, json!({"deltaText": "lo"}), "hello"),
        (3, json!({"deltaText": "Good", "replace": true}), "Good"),
        (
            4,
            json!({"deltaText": "!", "message": {"role": "assistant", "content": "Repaired!"}}),
            "Repaired!",
        ),
        (
            5,
            json!({"deltaText": " More", "message": {"role": "assistant", "content": "Repaired! More"}}),
            "Repaired! More",
        ),
    ] {
        let mut event = json!({"sessionKey": "main", "runId": "run", "state": "delta", "seq": seq});
        event
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        assert!(chat.apply_event(&event).changed);
        assert_eq!(chat.stream_text, expected);
    }
    assert!(!chat.apply_event(&json!({"sessionKey": "main", "runId": "run", "state": "delta", "seq": 4, "deltaText": "stale"})).changed);
    let terminal = json!({"sessionKey": "main", "runId": "run", "state": "final", "seq": 6, "message": {"role": "assistant", "content": [{"type": "text", "text": "Final answer"}]}});
    assert!(chat.apply_event(&terminal).terminal);
    assert_eq!(chat.messages[0].text, "Final answer");
    assert!(chat.active_run.is_none());
    assert!(chat.stream_text.is_empty());
    assert!(!chat.apply_event(&terminal).changed);
    assert_eq!(chat.messages.len(), 1);
}

#[test]
fn stale_session_events_and_requests_cannot_replace_new_selection() {
    let mut chat = chat();
    let history = chat.begin_history().unwrap();
    let send = chat
        .begin_send_with_attachments("old-run".to_owned(), "Old message".to_owned(), Vec::new())
        .unwrap();
    chat.select_context("other".to_owned(), None);
    chat.select_context("main".to_owned(), None);
    assert!(!chat.apply_history(
        &history,
        &json!({"messages": [{"role": "user", "content": "stale"}]})
    ));
    assert!(!chat.send_failed(&send, "old-run", "stale error".to_owned()));
    assert!(!chat.send_ack(&send, "old-run", &json!({"runId": "old-run"})));
    assert!(!chat.apply_event(&json!({"sessionKey": "other", "runId": "other-run", "state": "delta", "seq": 1, "deltaText": "wrong session"})).changed);
    assert!(chat.messages.is_empty());
    assert!(chat.active_run.is_none());
    assert!(chat.note.is_none());
}

#[test]
fn history_keeps_baseline_and_live_stream_and_does_not_duplicate_live_final() {
    let mut chat = chat();
    let first = chat.begin_history().unwrap();
    let second = chat.begin_history().unwrap();
    assert!(!chat.apply_history(&first, &json!({"messages": []})));
    chat.apply_event(&json!({"sessionKey": "main", "runId": "run", "state": "delta", "seq": 1, "deltaText": "Live"}));
    assert!(chat.apply_history(&second, &json!({"messages": [{"role": "user", "content": "Historical question"}], "inFlightRun": {"runId": "run", "text": "Older"}})));
    assert_eq!(chat.messages[0].text, "Historical question");
    assert_eq!(chat.stream_text, "Live");
    let request = chat.begin_history().unwrap();
    let answer =
        json!({"role": "assistant", "content": "Live final", "__openclaw": {"id": "answer"}});
    chat.apply_event(&json!({"sessionKey": "main", "runId": "run", "state": "final", "seq": 2, "message": answer}));
    let saved =
        json!({"role": "assistant", "content": "Saved final", "__openclaw": {"id": "answer"}});
    chat.apply_history(&request, &json!({"messages": [{"role": "user", "content": "Historical question"}, saved], "inFlightRun": {"runId": "run", "text": "Older"}}));
    assert_eq!(chat.messages.len(), 2);
    assert_eq!(chat.messages[1].text, "Saved final");
    assert!(chat.active_run.is_none());
    assert!(chat.stream_text.is_empty());
}

#[test]
fn abort_and_error_keep_partial_text_and_release_send() {
    for (state, expected_error) in [("aborted", false), ("error", true)] {
        let mut chat = chat();
        let scope = chat
            .begin_send_with_attachments("run".to_owned(), "Question".to_owned(), Vec::new())
            .unwrap();
        chat.apply_event(&json!({"sessionKey": "main", "runId": "run", "state": "delta", "seq": 1, "deltaText": "Partial"}));
        chat.apply_event(&json!({"sessionKey": "main", "runId": "run", "state": state, "seq": 2, "errorMessage": "Provider failed"}));
        assert_eq!(chat.messages[1].text, "Partial");
        assert_eq!(chat.note.as_ref().unwrap().error, expected_error);
        assert!(chat.active_run.is_none());
        assert!(!chat.send_ack(&scope, "run", &json!({"runId": "run"})));
    }
}

#[test]
fn uncertain_send_failure_does_not_discard_later_gateway_activity() {
    for already_streaming in [false, true] {
        let mut chat = chat();
        let scope = chat
            .begin_send_with_attachments("run".to_owned(), "Question".to_owned(), Vec::new())
            .unwrap();
        if already_streaming {
            chat.apply_event(&json!({"sessionKey": "main", "runId": "run", "state": "delta", "seq": 1, "deltaText": "Partial"}));
        }
        assert!(chat.send_failed(&scope, "run", "Acknowledgement timed out".to_owned()));
        assert_eq!(chat.active_run.is_some(), already_streaming);
        assert!(chat.note.as_ref().unwrap().error);
        assert!(chat.apply_event(&json!({"sessionKey": "main", "runId": "run", "state": "delta", "seq": 2, "deltaText": "Recovered", "replace": true})).changed);
        assert_eq!(chat.stream_text, "Recovered");
        assert_eq!(chat.active_run.as_deref(), Some("run"));
        assert!(chat.note.is_none());
        chat.apply_event(
            &json!({"sessionKey": "main", "runId": "run", "state": "final", "seq": 3}),
        );
        assert_eq!(chat.messages[1].text, "Recovered");
    }
}

#[test]
fn history_projects_text_thinking_tools_and_ignores_unknown_blocks() {
    let mut chat = chat();
    let request = chat.begin_history().unwrap();
    chat.apply_history(
        &request,
        &json!({"messages": [
            {"role": "system", "content": "System notice"},
            {"role": "assistant", "content": [
                {"type": "thinking", "thinking": "Considering the request"},
                {"type": "toolCall", "name": "read"},
                {"type": "toolUse", "name": "search"},
                {"type": "output_text", "text": "An answer"},
                {"type": "unknown", "text": "Not text"}, null
            ]},
            {"role": "toolResult", "toolName": "read", "content": "Large result"}
        ]}),
    );
    assert_eq!(chat.messages.len(), 3);
    assert!(chat.messages[0].system);
    assert_eq!(chat.messages[1].text, "An answer");
    assert_eq!(chat.messages[1].thinking, "Considering the request");
    assert_eq!(
        chat.messages[1]
            .tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        ["read", "search"]
    );
    assert_eq!(chat.messages[2].tools[0].name, "read");
    assert!(chat.messages[2].text.is_empty());
}

#[test]
fn older_pages_prepend_without_duplicate_overlap_or_disturbing_live_run() {
    let mut chat = chat();
    let initial = chat.begin_history().unwrap();
    chat.apply_history(&initial,&json!({"messages":[{"role":"user","content":"latest","__openclaw":{"id":"latest"}}],"hasMore":true,"nextOffset":1}));
    let older = chat.begin_older().unwrap();
    chat.apply_event(&json!({"sessionKey":"main","runId":"live","state":"delta","seq":1,"deltaText":"streaming"}));
    assert!(chat.apply_history(&older,&json!({"messages":[{"role":"user","content":"older","__openclaw":{"id":"older"}},{"role":"user","content":"latest","__openclaw":{"id":"latest"}}],"hasMore":false})));
    assert_eq!(
        chat.messages
            .iter()
            .map(|m| m.text.as_str())
            .collect::<Vec<_>>(),
        ["older", "latest"]
    );
    assert_eq!(chat.stream_text, "streaming");
    assert_eq!(chat.active_run.as_deref(), Some("live"));
    assert!(!chat.has_more);
}

#[test]
fn queued_send_ack_failure_and_retry_do_not_replace_running_response() {
    let mut chat = chat();
    chat.begin_send_with_attachments("first".into(), "one".into(), Vec::new())
        .unwrap();
    let second = chat
        .begin_send_with_attachments("second".into(), "two".into(), Vec::new())
        .unwrap();
    assert_eq!(chat.active_run.as_deref(), Some("first"));
    chat.send_failed(&second, "second", "offline".into());
    assert_eq!(chat.messages[1].send_error.as_deref(), Some("offline"));
    chat.retry_send("second");
    assert!(chat.messages[1].pending);
    chat.send_ack(
        &second,
        "second",
        &json!({"runId":"second","status":"queued"}),
    );
    assert!(!chat.messages[1].pending);
    assert_eq!(chat.active_run.as_deref(), Some("first"));
    let history = chat.begin_history().unwrap();
    chat.apply_history(&history,&json!({"messages":[{"role":"user","content":"one","__openclaw":{"id":"persisted","idempotencyKey":"first:user"}}]}));
    assert_eq!(chat.messages.len(), 2);
    assert_eq!(chat.messages[1].text, "two");
}

#[test]
fn agent_scoping_and_history_failures_preserve_the_selected_transcript() {
    let mut chat = chat();
    chat.select_context("shared".into(), Some("one".into()));
    let old = chat.begin_history().unwrap();
    chat.select_context("shared".into(), Some("two".into()));
    assert!(!chat.apply_history(&old, &json!({"messages":[]})));
    assert!(!chat.apply_event(&json!({"sessionKey":"shared","agentId":"one","runId":"other","state":"delta","seq":1,"deltaText":"wrong"})).changed);
    let current = chat.begin_history().unwrap();
    chat.apply_history(
        &current,
        &json!({"messages":[{"role":"user","content":"held"}]}),
    );
    let failed = chat.begin_history().unwrap();
    chat.history_failed(&failed, "Unavailable".into());
    assert_eq!(chat.messages[0].text, "held");
    assert_eq!(chat.history_error.as_deref(), Some("Unavailable"));
}

#[test]
fn reconnect_restores_unconfirmed_delivery_without_duplicating_authoritative_input_or_starting_runs()
 {
    let mut chat = chat();
    let page = chat.begin_history().unwrap();
    chat.apply_history(&page,&json!({"messages":[{"role":"user","content":"repeat","__openclaw":{"id":"persisted","idempotencyKey":"accepted:user"}}]}));
    let pending = |id: &str| Message {
        role: "user".into(),
        text: "repeat".into(),
        send_id: Some(id.into()),
        pending: true,
        ..Default::default()
    };
    assert!(chat.restore_pending_messages(vec![pending("accepted"), pending("new")]));
    assert_eq!(chat.messages.len(), 2);
    assert_eq!(chat.messages[1].send_id.as_deref(), Some("new"));
    assert!(chat.active_run.is_none());
    assert!(!chat.restore_pending_messages(vec![pending("new")]));
}

#[test]
fn reopened_history_only_shows_unfinished_tools_running_for_the_current_run() {
    let mut chat = chat();
    let request = chat.begin_history().unwrap();
    chat.apply_history(&request,&json!({
        "messages":[
            {"role":"assistant","__openclaw":{"runId":"unknown-old"},"content":[{"type":"toolCall","id":"missing","name":"read"}]},
            {"role":"assistant","__openclaw":{"runId":"old"},"content":[{"type":"toolCall","id":"aborted","name":"ask_user"}]},
            {"role":"toolResult","__openclaw":{"runId":"old"},"toolCallId":"aborted","content":[{"type":"text","text":"aborted"}]},
            {"role":"assistant","__openclaw":{"runId":"current"},"content":[{"type":"toolCall","id":"waiting","name":"ask_user"}]}
        ],
        "inFlightRun":{"runId":"current","startedAt":123000,"events":[
            {"sessionKey":"main","runId":"current","seq":1,"ts":123010,"stream":"tool","data":{"phase":"start","toolCallId":"waiting","name":"ask_user"}}
        ]}
    }));
    assert_eq!(chat.messages[0].tools[0].status(), "Interrupted");
    assert_eq!(chat.messages[1].tools[0].status(), "Interrupted");
    assert_eq!(chat.messages[2].tools[0].status(), "Running");
    assert!(chat.live_tools.is_empty());
    assert_eq!(chat.started_at, Some(123000));
    chat.apply_event(&json!({"sessionKey":"main","runId":"current","state":"aborted","seq":2}));
    assert_eq!(
        chat.messages.last().unwrap().tools[0].status(),
        "Interrupted"
    );
}

#[test]
fn successful_turn_recap_survives_history_and_accepts_only_its_late_usage() {
    let mut chat = chat();
    chat.apply_event(
        &json!({"sessionKey":"main","runId":"run","state":"delta","seq":1,"deltaText":"Answer"}),
    );
    chat.apply_agent_event(
        &json!({"sessionKey":"main","runId":"run","stream":"usage","data":{"outputTokens":42}}),
    );
    chat.apply_event(&json!({"sessionKey":"main","runId":"run","state":"final","seq":2}));
    assert_eq!(chat.turn_recap.as_ref().unwrap().output_tokens, Some(42));
    let history = chat.begin_history().unwrap();
    chat.apply_history(
        &history,
        &json!({"messages":[{"role":"assistant","runId":"run","content":"Answer"}]}),
    );
    assert_eq!(chat.turn_recap.as_ref().unwrap().run_id, "run");
    assert!(chat.apply_agent_event(
        &json!({"sessionKey":"main","runId":"run","stream":"usage","data":{"outputTokens":45}})
    ));
    assert_eq!(chat.turn_recap.as_ref().unwrap().output_tokens, Some(45));
    chat.apply_event(
        &json!({"sessionKey":"main","runId":"next","state":"delta","seq":1,"deltaText":"Next"}),
    );
    assert!(chat.turn_recap.is_none());
    assert!(!chat.apply_agent_event(
        &json!({"sessionKey":"main","runId":"run","stream":"usage","data":{"outputTokens":99}})
    ));
    assert_eq!(chat.output_tokens, 0);
    chat.apply_agent_event(
        &json!({"sessionKey":"main","runId":"next","stream":"compaction","data":{"phase":"start"}}),
    );
    assert!(chat.compacting);
    chat.apply_event(&json!({"sessionKey":"main","runId":"next","state":"aborted","seq":2}));
    assert!(!chat.compacting);
    assert!(chat.turn_recap.is_none());
}

#[test]
fn history_projects_compaction_and_collapsed_system_context_as_notices() {
    let mut chat = chat();
    let request = chat.begin_history().unwrap();
    assert!(chat.apply_history(&request, &json!({"messages":[
        {"role":"custom","customType":"openclaw.context-compaction","__openclaw":{"tokensBefore":1500,"tokensAfter":500}},
        {"role":"user","content":"[System] **Context**\n\n- Preserve this list", "provenance":{"kind":"internal_system","sourceTool":"cli_harness_context"}}
    ]})));
    assert_eq!(chat.messages.len(), 2);
    let compact = chat.messages[0].notice.as_ref().unwrap();
    assert!(compact.compaction);
    assert_eq!(compact.saved_tokens, Some(1000));
    let injected = chat.messages[1].notice.as_ref().unwrap();
    assert!(injected.collapsed);
    assert_eq!(injected.label, "System · injected context");
    assert!(chat.messages[1].text.contains("**Context**"));
}

#[test]
fn manual_compaction_stays_scoped_and_ignores_superseded_operation_end() {
    let mut chat = chat();
    chat.select_context("main".into(), Some("qa".into()));
    let operation = |id: &str, phase: &str, ts: u64, completed: bool| json!({"sessionKey":"main", "agentId":"qa", "operation":"compact", "operationId":id, "phase":phase, "ts":ts, "completed":completed});
    for (field, value) in [
        ("sessionKey", "other"),
        ("agentId", "other"),
        ("operation", "reset"),
    ] {
        let mut wrong_scope = operation("wrong", "start", 50, false);
        wrong_scope[field] = json!(value);
        assert!(!chat.apply_session_operation(&wrong_scope).changed);
    }
    assert!(
        chat.apply_session_operation(&operation("first", "start", 100, false))
            .changed
    );
    assert!(
        chat.active_run.is_none(),
        "manual compaction must be visible while idle"
    );
    let history = chat.begin_history().unwrap();
    chat.apply_history(&history, &json!({"messages":[]}));
    assert_eq!(
        chat.manual_compaction.as_ref().unwrap().operation_id,
        "first"
    );

    chat.apply_event(&json!({"sessionKey":"main","agentId":"qa","runId":"agent-run","state":"delta","seq":1,"deltaText":"Working"}));
    chat.apply_agent_event(&json!({"sessionKey":"main","agentId":"qa","runId":"agent-run","stream":"compaction","data":{"phase":"start"}}));
    chat.apply_event(
        &json!({"sessionKey":"main","agentId":"qa","runId":"agent-run","state":"aborted","seq":2}),
    );
    assert!(!chat.compacting);
    assert_eq!(
        chat.manual_compaction.as_ref().unwrap().operation_id,
        "first",
        "agent lifecycle cannot settle a manual operation"
    );

    assert!(
        chat.apply_session_operation(&operation("second", "start", 200, false))
            .changed
    );
    assert!(
        !chat
            .apply_session_operation(&operation("first", "start", 100, false))
            .changed
    );
    let stale = chat.apply_session_operation(&operation("first", "end", 300, true));
    assert!(!stale.changed && !stale.terminal);
    assert_eq!(
        chat.manual_compaction.as_ref().unwrap().operation_id,
        "second"
    );
    let cancelled = chat.apply_session_operation(&operation("second", "end", 400, false));
    assert!(cancelled.changed && !cancelled.terminal);
    assert!(chat.manual_compaction.is_none());

    chat.apply_session_operation(&operation("third", "start", 500, false));
    let completed = chat.apply_session_operation(&operation("third", "end", 600, true));
    assert!(
        completed.changed && completed.terminal,
        "matching completion requests canonical history refresh"
    );
    assert!(chat.manual_compaction.is_none());
    assert!(
        !chat
            .apply_session_operation(&operation("third", "end", 600, true))
            .changed
    );
    chat.apply_session_operation(&operation("fourth", "start", 700, false));
    chat.select_context("other".into(), Some("qa".into()));
    assert!(chat.manual_compaction.is_none());
    assert!(
        !chat
            .apply_session_operation(&operation("fourth", "end", 800, true))
            .changed
    );
    chat.select_context("main".into(), Some("qa".into()));
    let returned = chat.apply_session_operation(&operation("fourth", "end", 800, true));
    assert!(
        returned.terminal && !returned.changed,
        "returning before completion must refresh history even when its start was cleared"
    );
}
