#[path = "tool_presentation.rs"]
mod presentation;
pub use presentation::{DiffKind, ToolKind, group_summary};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolCall {
    pub id: String,
    pub run_id: Option<String>,
    pub parent_tool_call_id: Option<String>,
    pub name: String,
    pub args: Value,
    pub output: String,
    pub result: Value,
    pub complete: bool,
    pub inactive: bool,
    pub is_error: bool,
    pub started_at: Option<u64>,
    pub ended_at: Option<u64>,
    pub(super) receipt: u64,
    pub(super) sequence: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolEvent {
    pub run_id: String,
    pub session_key: Option<String>,
    pub agent_id: Option<String>,
    pub seq: u64,
    pub ts: u64,
    pub stream: String,
    pub data: ToolData,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ToolData {
    pub tool_call_id: String,
    pub parent_tool_call_id: Option<String>,
    pub name: String,
    pub phase: String,
    pub args: Value,
    pub partial_result: Value,
    pub result: Value,
    pub is_error: bool,
    pub output_tokens: Option<u64>,
    pub text: Option<String>,
    pub delta: Option<String>,
}

impl ToolCall {
    pub fn same_identity(&self, other: &Self) -> bool {
        !self.id.is_empty() && self.id == other.id && self.run_id == other.run_id
    }
    pub fn running(&self) -> bool {
        !self.complete && !self.inactive
    }
    pub fn interrupted(&self) -> bool {
        self.inactive || self.complete && self.output.trim().eq_ignore_ascii_case("aborted")
    }
    pub fn status(&self) -> &'static str {
        if self.running() {
            "Running"
        } else if self.interrupted() {
            "Interrupted"
        } else if self.failed() {
            "Error"
        } else {
            "Done"
        }
    }
    pub fn display_target(&self) -> (&str, &Value) {
        if self.name == "tool_call"
            && let Some(target) = self.args.get("id").and_then(Value::as_str)
            && let Some(args) = self.args.get("args")
        {
            // The bridge's args.id names the tool; the block/event id remains the invocation.
            let name = if target.starts_with("openclaw:") || target.starts_with("mcp:") {
                target.splitn(3, ':').nth(2).unwrap_or(target)
            } else {
                target
            };
            return (name, args);
        }
        (&self.name, &self.args)
    }
    pub fn summary(&self) -> String {
        let (name, args) = self.display_target();
        let arg = |keys: &[&str]| {
            keys.iter()
                .find_map(|key| args.get(key).and_then(Value::as_str))
        };
        let path = || {
            arg(&[
                "path",
                "file_path",
                "filePath",
                "file",
                "filename",
                "notebook_path",
            ])
        };
        let (label, detail) = match name.to_lowercase().as_str() {
            "read" | "read_file" | "readfile" | "notebook_read" => ("Read", path().map(basename)),
            "write" | "write_file" | "create_file" => (
                if self.running() {
                    "Writing"
                } else if self.failed() || self.interrupted() {
                    "Write"
                } else {
                    "Wrote"
                },
                path().map(basename),
            ),
            "edit" | "edit_file" | "multiedit" | "multi_edit" => (
                if self.running() {
                    "Editing"
                } else if self.failed() || self.interrupted() {
                    "Edit"
                } else {
                    "Edited"
                },
                path().map(basename),
            ),
            "exec" | "bash" | "shell" | "run_command" | "run_terminal_cmd" | "exec_command" => {
                if let Some(title) = arg(&["title"]).filter(|title| !title.trim().is_empty()) {
                    return compact(title);
                }
                ("$", arg(&["command", "cmd"]).map(compact))
            }
            "ls" | "list" | "list_dir" => ("Listed", path().map(basename)),
            "grep" | "search" | "find" | "glob" | "codebase_search" => (
                "Searched",
                arg(&["query", "pattern", "search", "glob", "path"]).map(compact),
            ),
            "web_search" | "websearch" => (
                "Searched the web for",
                arg(&["query", "q", "search", "objective"]).map(compact),
            ),
            "web_fetch" | "webfetch" | "fetch" => ("Fetched", arg(&["url"]).map(compact)),
            "ask_user" => ("Asked a question", None),
            "apply_patch" | "applypatch" | "patch" => {
                let patch = args
                    .as_str()
                    .or_else(|| arg(&["input", "patch", "patchText"]));
                let file = patch.and_then(|patch| {
                    patch.lines().find_map(|line| {
                        ["*** Update File: ", "*** Add File: ", "*** Delete File: "]
                            .iter()
                            .find_map(|prefix| line.strip_prefix(prefix))
                    })
                });
                ("Patched", file.map(basename))
            }
            "sessions_list" => (
                "Listed sessions",
                arg(&["label", "agentId", "search"]).map(compact),
            ),
            "sessions_history" => ("Read session", arg(&["label", "sessionKey"]).map(compact)),
            "sessions_search" => ("Searched sessions for", arg(&["query"]).map(compact)),
            "sessions_send" => (
                "Sent to session",
                arg(&["label", "sessionKey", "agentId"]).map(compact),
            ),
            "sessions_spawn" | "sessions_create" => (
                "Started session",
                arg(&["label", "taskName", "agentId", "task"]).map(compact),
            ),
            "sessions_yield" => ("Yielded to sessions", None),
            _ => (
                name,
                args.as_str()
                    .or_else(|| args.as_object()?.values().find_map(Value::as_str))
                    .map(compact),
            ),
        };
        match detail.filter(|detail| !detail.is_empty()) {
            Some(detail) => format!("{label} {detail}"),
            None if label.is_empty() => "Tool".into(),
            None => label.into(),
        }
    }

    pub fn duration_ms(&self) -> Option<u64> {
        Some(self.ended_at?.saturating_sub(self.started_at?))
    }
}

fn compact(text: &str) -> String {
    let first = text.trim().lines().next().unwrap_or_default().trim();
    let mut chars = first.chars();
    let prefix: String = chars.by_ref().take(160).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn basename(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    compact(trimmed.rsplit(['/', '\\']).next().unwrap_or(path))
}

pub fn bridge_has_child<'a>(
    parent: &ToolCall,
    calls: impl Iterator<Item = &'a ToolCall> + Clone,
) -> bool {
    calls.clone().any(|child| {
        matches_bridge_child(parent, child)
            && (child.parent_tool_call_id.is_some()
                || !calls
                    .clone()
                    .any(|other| other.id != parent.id && matches_bridge_child(other, child)))
    })
}

fn matches_bridge_child(parent: &ToolCall, child: &ToolCall) -> bool {
    if parent.name != "tool_call"
        || parent.run_id != child.run_id
        || parent.display_target().0 != child.name
    {
        return false;
    }
    if let Some(id) = &child.parent_tool_call_id {
        return id == &parent.id;
    }
    // Gateway progress snapshots omit parentToolCallId. Recover only the exact
    // tool-search-runtime.ts generated ID, with collision rejection above.
    let mut encoded = String::new();
    let mut replacing = false;
    for character in parent.id.trim().chars() {
        if character.is_ascii_alphanumeric() || "_.:-".contains(character) {
            encoded.push(character);
            replacing = false;
        } else if !replacing {
            encoded.push('_');
            replacing = true;
        }
    }
    encoded.truncate(120);
    if encoded.is_empty() {
        encoded.push_str("call");
    }
    child
        .id
        .strip_prefix(&format!("tool_search_code:{encoded}:{}:", child.name))
        .is_some_and(|sequence| {
            !sequence.is_empty()
                && sequence.bytes().all(|byte| byte.is_ascii_digit())
                && sequence.parse::<u64>().is_ok_and(|sequence| sequence > 0)
        })
}

pub fn apply_tool_event(calls: &mut Vec<ToolCall>, event: &ToolEvent, receipt: u64) -> bool {
    let data = &event.data;
    if event.stream != "tool"
        || data.tool_call_id.is_empty()
        || !matches!(data.phase.as_str(), "start" | "update" | "result")
    {
        return false;
    }
    let index = calls.iter().position(|call| {
        call.id == data.tool_call_id && call.run_id.as_deref() == Some(event.run_id.as_str())
    });
    let call = if let Some(index) = index {
        &mut calls[index]
    } else {
        calls.push(ToolCall {
            id: data.tool_call_id.clone(),
            run_id: Some(event.run_id.clone()),
            started_at: Some(event.ts),
            ..Default::default()
        });
        calls.last_mut().expect("just inserted")
    };
    // A result is terminal even when the producer's sequence restarts during abort recovery.
    if call.complete
        || data.phase != "result" && call.sequence.is_some_and(|previous| previous >= event.seq)
    {
        return false;
    }
    call.parent_tool_call_id = call
        .parent_tool_call_id
        .take()
        .or_else(|| data.parent_tool_call_id.clone());
    call.sequence = Some(event.seq);
    call.receipt = receipt;
    if call.name.is_empty() || call.name.eq_ignore_ascii_case("tool") {
        call.name = data.name.clone();
    }
    match data.phase.as_str() {
        "start" => {
            call.args = data.args.clone();
            call.inactive = false;
            call.started_at = Some(event.ts);
        }
        "update" => {
            call.output = output_text(&data.partial_result);
            call.result = data.partial_result.clone();
        }
        "result" => {
            call.output = output_text(&data.result);
            call.result = data.result.clone();
            call.complete = true;
            call.inactive = false;
            call.is_error = data.is_error || call.exit_code().is_some_and(|code| code != 0);
            call.ended_at = Some(event.ts);
        }
        _ => unreachable!(),
    }
    true
}

pub fn settle_history_tools(messages: &mut [super::chat::Message], active_run: Option<&str>) {
    for message in messages {
        for tool in &mut message.tools {
            tool.inactive =
                !tool.complete && (active_run.is_none() || tool.run_id.as_deref() != active_run);
        }
    }
}

pub fn output_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    if let Some(text) = value.get("text").and_then(Value::as_str) {
        return text.to_owned();
    }
    if let Some(content) = value.get("content") {
        if let Some(text) = content.as_str() {
            return text.to_owned();
        }
        if let Some(blocks) = content.as_array() {
            return blocks
                .iter()
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
        }
    }
    if value.is_null() {
        String::new()
    } else {
        serde_json::to_string_pretty(value).unwrap_or_default()
    }
}

pub fn history_call(
    block: &Value,
    run_id: Option<String>,
    timestamp: Option<u64>,
) -> Option<ToolCall> {
    let kind = block.get("type")?.as_str()?.to_lowercase();
    let result = matches!(kind.as_str(), "toolresult" | "tool_result");
    if !result
        && !matches!(
            kind.as_str(),
            "toolcall" | "tooluse" | "tool_call" | "tool_use"
        )
    {
        return None;
    }
    let id = [
        "id",
        "toolCallId",
        "tool_use_id",
        "tool_call_id",
        "toolUseId",
        "callId",
    ]
    .iter()
    .find_map(|key| {
        block
            .get(key)
            .and_then(Value::as_str)
            .filter(|id| !id.trim().is_empty())
    })
    .unwrap_or_default()
    .to_owned();
    let args = block
        .get("arguments")
        .or_else(|| block.get("input"))
        .or_else(|| block.get("args"))
        .cloned()
        .unwrap_or_default();
    let args = args
        .as_str()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or(args);
    Some(ToolCall {
        id,
        run_id: block
            .get("runId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or(run_id),
        parent_tool_call_id: block
            .get("parentToolCallId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        name: block
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Tool")
            .to_owned(),
        args,
        complete: result,
        result: if result { block.clone() } else { Value::Null },
        output: if result {
            output_text(block)
        } else {
            String::new()
        },
        is_error: block
            .get("isError")
            .or_else(|| block.get("is_error"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        started_at: (!result).then_some(timestamp).flatten(),
        ended_at: result.then_some(timestamp).flatten(),
        ..Default::default()
    })
}

fn merge_call(held: &mut ToolCall, next: &ToolCall, prefer_next_on_tie: bool) {
    if held.name.is_empty() || held.name.eq_ignore_ascii_case("tool") {
        held.name = next.name.clone();
    }
    if held.args.is_null() {
        held.args = next.args.clone();
    }
    held.parent_tool_call_id = held
        .parent_tool_call_id
        .take()
        .or_else(|| next.parent_tool_call_id.clone());
    held.started_at = match (held.started_at, next.started_at) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    // Request receipts, not remote timestamps/sequences, order history and live results.
    let newer = next.receipt > held.receipt || prefer_next_on_tie && next.receipt == held.receipt;
    if !held.complete && next.complete || newer && held.complete == next.complete {
        if !next.output.is_empty() || next.complete {
            held.output = next.output.clone();
            held.result = next.result.clone();
        }
        held.complete = next.complete;
        held.is_error = next.is_error;
        held.inactive = next.inactive;
        held.ended_at = next.ended_at;
        held.receipt = next.receipt;
    }
    held.sequence = held.sequence.max(next.sequence);
}

fn unique_runs<'a>(
    calls: impl Iterator<Item = &'a ToolCall>,
) -> std::collections::HashMap<String, Option<String>> {
    let mut runs = std::collections::HashMap::new();
    for call in calls {
        if let Some(run) = &call.run_id {
            for id in std::iter::once(&call.id).chain(call.parent_tool_call_id.as_ref()) {
                let entry = runs.entry(id.clone()).or_insert_with(|| Some(run.clone()));
                if entry.as_ref() != Some(run) {
                    *entry = None;
                }
            }
        }
    }
    runs
}

/// Coalesce identified calls/results across blocks and snapshots; ambiguous run-less IDs stay separate.
pub fn pair_history(messages: &mut Vec<super::chat::Message>) {
    let runs = unique_runs(messages.iter().flat_map(|message| &message.tools));
    let mut owners: std::collections::HashMap<(Option<String>, String), (usize, usize)> =
        std::collections::HashMap::new();
    for index in 0..messages.len() {
        for mut tool in std::mem::take(&mut messages[index].tools) {
            if tool.run_id.is_none() {
                tool.run_id = runs.get(&tool.id).cloned().flatten();
            }
            let ambiguous = tool.run_id.is_none() && runs.get(&tool.id) == Some(&None);
            let key = (tool.run_id.clone(), tool.id.clone());
            if !tool.id.is_empty() && !ambiguous {
                if let Some(&(message, call)) = owners.get(&key) {
                    merge_call(&mut messages[message].tools[call], &tool, true);
                    continue;
                }
                owners.insert(key, (index, messages[index].tools.len()));
            }
            messages[index].tools.push(tool);
        }
    }
    messages.retain(super::chat::Message::visible);
    let mut index = 1;
    while index < messages.len() {
        let previous = &messages[index - 1];
        let current = &messages[index];
        if previous.role == "assistant"
            && current.role == "assistant"
            && previous.text.is_empty()
            && current.text.is_empty()
            && !previous.tools.is_empty()
            && !current.tools.is_empty()
            && previous.run_id == current.run_id
            && !current.turn_boundary
        {
            let mut next = messages.remove(index);
            messages[index - 1].tools.append(&mut next.tools);
            if !next.thinking.is_empty() {
                if !messages[index - 1].thinking.is_empty() {
                    messages[index - 1].thinking.push('\n');
                }
                messages[index - 1].thinking.push_str(&next.thinking);
            }
        } else {
            index += 1;
        }
    }
}

pub fn reconcile_live_history(
    messages: &mut [super::chat::Message],
    live: &mut Vec<ToolCall>,
) -> bool {
    let runs = unique_runs(
        messages
            .iter()
            .flat_map(|message| &message.tools)
            .chain(live.iter()),
    );
    let mut changed = false;
    for held in messages.iter_mut().flat_map(|message| &mut message.tools) {
        if held.run_id.is_none() {
            held.run_id = runs.get(&held.id).cloned().flatten();
        }
    }
    live.retain(|tool| {
        if let Some(held) = messages
            .iter_mut()
            .flat_map(|message| &mut message.tools)
            .find(|held| held.same_identity(tool))
        {
            merge_call(held, tool, false);
            changed = true;
            false
        } else {
            true
        }
    });
    changed
}

#[cfg(test)]
mod tests;
