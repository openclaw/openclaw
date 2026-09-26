use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemNotice {
    pub label: String,
    pub body: Option<String>,
    pub collapsed: bool,
    pub compaction: bool,
    pub saved_tokens: Option<u64>,
}

impl SystemNotice {
    pub fn from_value(value: &Value) -> Option<Self> {
        let compaction = value.pointer("/__openclaw/kind").and_then(Value::as_str)
            == Some("compaction")
            || (value.get("role").and_then(Value::as_str) == Some("custom")
                && value.get("customType").and_then(Value::as_str)
                    == Some("openclaw.context-compaction"));
        if compaction {
            let saved_tokens = value
                .pointer("/__openclaw/tokensBefore")
                .and_then(Value::as_u64)
                .zip(
                    value
                        .pointer("/__openclaw/tokensAfter")
                        .and_then(Value::as_u64),
                )
                .and_then(|(before, after)| (before > after).then_some(before - after));
            return Some(Self {
                label: "Context compacted".into(),
                body: Some(String::new()),
                collapsed: false,
                compaction: true,
                saved_tokens,
            });
        }
        let internal =
            value.pointer("/provenance/kind").and_then(Value::as_str) == Some("internal_system");
        if !internal && value.get("role").and_then(Value::as_str) != Some("system") {
            return None;
        }
        let kind = value
            .pointer("/provenance/sourceTool")
            .and_then(Value::as_str);
        let (label, collapsed) = match kind {
            Some("main_session_restart_recovery") => ("System · restart recovery", false),
            Some("restart-sentinel") => ("System · gateway restarted", false),
            Some("cli_harness_context") => ("System · injected context", true),
            Some("claude_cli_task_notification") => ("System · background task", true),
            _ => ("System", false),
        };
        Some(Self {
            label: label.into(),
            body: (kind == Some("main_session_restart_recovery")).then(|| "Turn interrupted by a gateway restart — asked the agent to resume and finish the response.".into()),
            collapsed,
            compaction: false,
            saved_tokens: None,
        })
    }
}
