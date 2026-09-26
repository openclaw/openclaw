use super::*;
use serde_json::json;

#[test]
fn collapsed_tool_summaries_humanize_common_tools_without_dumping_json() {
    for (name, args, expected) in [
        (
            "read",
            json!({"file_path":"/tmp/proof-note.txt"}),
            "Read proof-note.txt",
        ),
        (
            "write",
            json!({"path":"C:\\notes\\proof.txt","content":"body"}),
            "Wrote proof.txt",
        ),
        (
            "edit",
            json!({"filePath":"/tmp/proof.txt","newText":"body"}),
            "Edited proof.txt",
        ),
        ("exec", json!({"command":"echo hi\necho bye"}), "$ echo hi"),
        ("bash", json!({"command":"echo hi"}), "$ echo hi"),
        ("ls", json!({"path":"/tmp/project"}), "Listed project"),
        (
            "grep",
            json!({"pattern":"needle","path":"src"}),
            "Searched needle",
        ),
        (
            "web_search",
            json!({"query":"GPUI layout"}),
            "Searched the web for GPUI layout",
        ),
        (
            "web_fetch",
            json!({"url":"https://example.com/guide"}),
            "Fetched https://example.com/guide",
        ),
        (
            "ask_user",
            json!({"questions":[{"question":"Which task?"}]}),
            "Asked a question",
        ),
        (
            "apply_patch",
            json!({"input":"*** Begin Patch\n*** Update File: /tmp/proof.txt\n@@\n-old\n+new\n*** End Patch"}),
            "Patched proof.txt",
        ),
        (
            "sessions_spawn",
            json!({"label":"Research","task":"many paragraphs"}),
            "Started session Research",
        ),
        (
            "sessions_history",
            json!({"sessionKey":"agent:qa:main"}),
            "Read session agent:qa:main",
        ),
        (
            "sessions_search",
            json!({"query":"release notes"}),
            "Searched sessions for release notes",
        ),
        (
            "custom_tool",
            json!({"nested":{"private":"details"},"target":"concise"}),
            "custom_tool concise",
        ),
        (
            "custom_tool",
            json!({"nested":{"private":"details"},"flag":true}),
            "custom_tool",
        ),
        (
            "tool_call",
            json!({"id":"openclaw:core:ask_user","args":{"questions":[]}}),
            "Asked a question",
        ),
    ] {
        let tool = ToolCall {
            name: name.into(),
            args,
            complete: true,
            ..Default::default()
        };
        assert_eq!(tool.summary(), expected, "{name}");
    }
}

#[test]
fn live_tool_rejects_duplicate_and_late_updates_and_retains_start_identity() {
    let mut calls = Vec::new();
    for (seq, data) in [
        (
            1,
            json!({"phase":"start","name":"read","args":{"path":"/tmp/sample"}}),
        ),
        (
            2,
            json!({"phase":"update","name":"wrong","partialResult":{"content":[{"type":"text","text":"partial"}]}}),
        ),
        (
            3,
            json!({"phase":"result","result":{"content":[{"type":"text","text":"complete"}]},"isError":true}),
        ),
    ] {
        let mut value = json!({"runId":"run","stream":"tool","seq":seq,"ts":seq*100,"data":data});
        value["data"]["toolCallId"] = json!("call");
        let event = serde_json::from_value(value).unwrap();
        assert!(apply_tool_event(&mut calls, &event, seq));
        assert!(!apply_tool_event(&mut calls, &event, seq));
    }
    assert_eq!(calls[0].name, "read");
    assert_eq!(calls[0].summary(), "Read sample");
    assert_eq!(calls[0].output, "complete");
    assert_eq!(
        calls[0].result,
        json!({"content":[{"type":"text","text":"complete"}]})
    );
    assert!(calls[0].is_error);
    assert_eq!(calls[0].duration_ms(), Some(200));
}

#[test]
fn history_pairs_results_and_preserves_ambiguous_reused_call_ids() {
    let fixtures = [
        json!({"role":"assistant","runId":"one","content":[{"type":"toolCall","id":"call","name":"read","arguments":{"path":"a"}}]}),
        json!({"role":"assistant","runId":"two","content":[{"type":"toolUse","id":"call","name":"read","input":{"path":"b"}}]}),
        json!({"role":"toolResult","runId":"two","toolCallId":"call","toolName":"read","content":[{"type":"text","text":"result b"}],"details":{"retained":true}}),
        json!({"role":"toolResult","toolCallId":"unknown","content":"unmatched"}),
    ];
    let mut messages = fixtures
        .iter()
        .filter_map(super::super::chat::Message::from_value)
        .collect();
    pair_history(&mut messages);
    assert_eq!(messages.len(), 3);
    assert!(!messages[0].tools[0].complete);
    assert_eq!(messages[1].tools[0].output, "result b");
    assert_eq!(messages[1].tools[0].result["details"]["retained"], true);
    assert_eq!(messages[2].tools[0].output, "unmatched");
}
