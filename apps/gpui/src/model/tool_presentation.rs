use super::ToolCall;
use crate::model::chat::Message;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ToolKind {
    Command,
    Read,
    Edit,
    Write,
    Search,
    Fetch,
    Generic,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DiffKind {
    Add,
    Delete,
    Context,
    File,
    Skip,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffLine {
    pub kind: DiffKind,
    pub number: Option<usize>,
    pub text: String,
}

fn argument<'a>(args: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| args.get(key)?.as_str())
}

impl ToolCall {
    pub fn kind(&self) -> ToolKind {
        let (name, args) = self.display_target();
        match name.trim().to_lowercase().as_str() {
            "bash" | "exec" | "shell" | "run_command" | "run_terminal_cmd" | "exec_command" => {
                ToolKind::Command
            }
            "read" | "read_file" | "readfile" | "notebookread" | "notebook_read" => ToolKind::Read,
            "edit" | "edit_file" | "multiedit" | "multi_edit" | "notebookedit"
            | "notebook_edit" | "apply_patch" | "applypatch" | "patch" => ToolKind::Edit,
            "write" | "write_file" | "create_file" => ToolKind::Write,
            "grep" | "find" | "glob" | "ls" | "list" | "search" | "codebase_search"
            | "web_search" | "websearch" => ToolKind::Search,
            "web_fetch" | "webfetch" | "fetch" => ToolKind::Fetch,
            "str_replace_editor" | "str_replace_based_edit_tool" => {
                match argument(args, &["command"]) {
                    Some("view") => ToolKind::Read,
                    Some("str_replace" | "insert" | "undo_edit") => ToolKind::Edit,
                    Some("create") => ToolKind::Write,
                    _ => ToolKind::Generic,
                }
            }
            _ if args.as_object().is_some_and(|args| {
                args.len() <= 3 && args.get("command").is_some_and(Value::is_string)
            }) =>
            {
                ToolKind::Command
            }
            _ => ToolKind::Generic,
        }
    }

    pub fn command(&self) -> Option<&str> {
        (self.kind() == ToolKind::Command)
            .then(|| argument(self.display_target().1, &["command", "cmd"]))
            .flatten()
    }

    pub fn code(&self) -> Option<&str> {
        (self.kind() == ToolKind::Command)
            .then(|| argument(self.display_target().1, &["code", "input"]))
            .flatten()
    }

    pub fn workspace_path(&self) -> Option<&str> {
        if !matches!(
            self.kind(),
            ToolKind::Read | ToolKind::Edit | ToolKind::Write
        ) {
            return None;
        }
        argument(
            self.display_target().1,
            &[
                "path",
                "file_path",
                "filePath",
                "file",
                "filepath",
                "filename",
                "notebook_path",
            ],
        )
    }

    pub fn rich_result(&self) -> Option<Message> {
        let mut value = self.result.clone();
        value
            .as_object_mut()?
            .insert("role".into(), Value::String("assistant".into()));
        let message = Message::from_value(&value)?;
        (!message.attachments.is_empty() || !message.media.is_empty()).then_some(message)
    }

    pub fn exit_code(&self) -> Option<i64> {
        self.result
            .get("exitCode")
            .or_else(|| self.result.pointer("/details/exitCode"))
            .and_then(Value::as_i64)
    }

    pub fn failed(&self) -> bool {
        !self.interrupted() && (self.is_error || self.exit_code().is_some_and(|code| code != 0))
    }

    pub fn outcome(&self) -> String {
        if self.running() {
            "Running".into()
        } else if self.interrupted() {
            "Interrupted".into()
        } else if let Some(code) = self.exit_code().filter(|code| *code != 0) {
            format!("Exit code {code}")
        } else if self.failed() {
            "Failed".into()
        } else {
            "Completed".into()
        }
    }

    pub fn extra_args(&self) -> Vec<(String, String)> {
        let (_, args) = self.display_target();
        let kind = self.kind();
        args.as_object()
            .into_iter()
            .flatten()
            .filter(|(key, _)| !match kind {
                ToolKind::Command => matches!(key.as_str(), "command" | "cmd" | "code" | "input"),
                ToolKind::Read => matches!(
                    key.as_str(),
                    "path" | "file_path" | "filePath" | "notebook_path"
                ),
                ToolKind::Search => matches!(key.as_str(), "pattern" | "query" | "glob" | "path"),
                ToolKind::Fetch => key.as_str() == "url",
                _ => false,
            })
            .map(|(key, value)| {
                (
                    key.clone(),
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                )
            })
            .collect()
    }

    pub fn diff(&self) -> Vec<DiffLine> {
        if !matches!(self.kind(), ToolKind::Edit | ToolKind::Write) {
            return Vec::new();
        }
        if let Some(diff) = self
            .result
            .pointer("/details/diff")
            .or_else(|| self.result.get("diff"))
            .and_then(Value::as_str)
            && let Some(lines) = parse_numbered_diff(diff)
        {
            return lines;
        }
        let args = self.display_target().1;
        if self.kind() == ToolKind::Write {
            if self.result.pointer("/details/changed") == Some(&Value::Bool(false)) {
                return Vec::new();
            }
            return argument(args, &["content", "file_text"])
                .map(|text| {
                    bound_diff(
                        lines(text)
                            .into_iter()
                            .enumerate()
                            .map(|(i, text)| DiffLine {
                                kind: DiffKind::Add,
                                number: Some(i + 1),
                                text: text.into(),
                            })
                            .take(401)
                            .collect::<Vec<_>>(),
                    )
                })
                .unwrap_or_default();
        }
        if let Some(patch) = args
            .as_str()
            .or_else(|| argument(args, &["input", "patch", "patchText"]))
        {
            let parsed: Vec<_> = patch
                .lines()
                .filter_map(|line| {
                    let kind = match line.as_bytes().first()? {
                        b'+' => DiffKind::Add,
                        b'-' => DiffKind::Delete,
                        b' ' => DiffKind::Context,
                        _ if line.starts_with("*** Update File: ")
                            || line.starts_with("*** Add File: ")
                            || line.starts_with("*** Delete File: ") =>
                        {
                            return Some(DiffLine {
                                kind: DiffKind::File,
                                number: None,
                                text: line.split_once(": ")?.1.into(),
                            });
                        }
                        _ => return None,
                    };
                    Some(DiffLine {
                        kind,
                        number: None,
                        text: line[1..].into(),
                    })
                })
                .take(401)
                .collect();
            if !parsed.is_empty() {
                return bound_diff(parsed);
            }
        }
        let edits: Vec<_> = args
            .get("edits")
            .and_then(Value::as_array)
            .map(|edits| edits.iter().collect())
            .unwrap_or_else(|| vec![args]);
        let mut result = Vec::new();
        for edit in edits.into_iter().take(8) {
            let old = argument(edit, &["oldText", "old_string", "oldString", "old_str"]);
            let new = argument(edit, &["newText", "new_string", "newString", "new_str"]);
            let pair = old
                .zip(new)
                .or_else(|| argument(edit, &["insert_text"]).map(|text| ("", text)));
            if let Some((old, new)) = pair {
                if !result.is_empty() {
                    result.push(DiffLine {
                        kind: DiffKind::Skip,
                        number: None,
                        text: String::new(),
                    });
                }
                result.extend(line_diff(old, new));
            }
        }
        if result.len() > 400 {
            result.truncate(400);
            result.push(DiffLine {
                kind: DiffKind::Skip,
                number: None,
                text: String::new(),
            });
        }
        result
    }
}

fn lines(source: &str) -> Vec<&str> {
    source.lines().collect()
}

fn bound_diff(mut lines: Vec<DiffLine>) -> Vec<DiffLine> {
    if lines.len() > 400 {
        lines.truncate(400);
        lines.push(DiffLine {
            kind: DiffKind::Skip,
            number: None,
            text: "More changes in Raw".into(),
        });
    }
    lines
}

fn parse_numbered_diff(source: &str) -> Option<Vec<DiffLine>> {
    let mut lines = Vec::new();
    for line in source.lines().take(401) {
        if line.trim().starts_with("...") {
            lines.push(DiffLine {
                kind: DiffKind::Skip,
                number: None,
                text: String::new(),
            });
            continue;
        }
        let kind = match line.as_bytes().first()? {
            b'+' => DiffKind::Add,
            b'-' => DiffKind::Delete,
            b' ' => DiffKind::Context,
            _ => return None,
        };
        let rest = line[1..].trim_start();
        let split = rest
            .find(|ch: char| !ch.is_ascii_digit())
            .unwrap_or(rest.len());
        let number = rest[..split].parse().ok()?;
        lines.push(DiffLine {
            kind,
            number: Some(number),
            text: rest[split..]
                .strip_prefix(' ')
                .unwrap_or(&rest[split..])
                .into(),
        });
    }
    (!lines.is_empty()).then(|| bound_diff(lines))
}

fn line_diff(old: &str, new: &str) -> Vec<DiffLine> {
    if old.len().saturating_add(new.len()) > 120_000 {
        return vec![DiffLine {
            kind: DiffKind::Skip,
            number: None,
            text: "Diff too large; view raw arguments".into(),
        }];
    }
    let old = lines(old);
    let new = lines(new);
    if old == new {
        return Vec::new();
    }
    if old.len() > 600 || new.len() > 600 {
        return vec![DiffLine {
            kind: DiffKind::Skip,
            number: None,
            text: "Diff too large; view raw arguments".into(),
        }];
    }
    let stride = new.len() + 1;
    let mut lcs = vec![0u16; (old.len() + 1) * stride];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            lcs[i * stride + j] = if old[i] == new[j] {
                lcs[(i + 1) * stride + j + 1] + 1
            } else {
                lcs[(i + 1) * stride + j].max(lcs[i * stride + j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let mut result = Vec::new();
    while i < old.len() || j < new.len() {
        let (kind, text) = if i < old.len() && j < new.len() && old[i] == new[j] {
            i += 1;
            j += 1;
            (DiffKind::Context, old[i - 1])
        } else if i < old.len()
            && (j == new.len() || lcs[(i + 1) * stride + j] >= lcs[i * stride + j + 1])
        {
            i += 1;
            (DiffKind::Delete, old[i - 1])
        } else {
            j += 1;
            (DiffKind::Add, new[j - 1])
        };
        result.push(DiffLine {
            kind,
            number: None,
            text: text.into(),
        });
    }
    result
}

pub fn group_summary(tools: &[ToolCall]) -> String {
    let mut parts = Vec::new();
    for (kind, label) in [
        (ToolKind::Command, "command"),
        (ToolKind::Read, "read"),
        (ToolKind::Edit, "edit"),
        (ToolKind::Write, "write"),
        (ToolKind::Search, "search"),
        (ToolKind::Fetch, "fetch"),
        (ToolKind::Generic, "tool"),
    ] {
        let count = tools.iter().filter(|tool| tool.kind() == kind).count();
        if count > 0 {
            parts.push(format!(
                "{count} {label}{}",
                if count == 1 {
                    ""
                } else if matches!(kind, ToolKind::Search | ToolKind::Fetch) {
                    "es"
                } else {
                    "s"
                }
            ));
        }
    }
    for (count, label) in [
        (tools.iter().filter(|tool| tool.failed()).count(), "failed"),
        (
            tools.iter().filter(|tool| tool.interrupted()).count(),
            "interrupted",
        ),
        (
            tools.iter().filter(|tool| tool.running()).count(),
            "running",
        ),
    ] {
        if count > 0 {
            parts.push(format!("{count} {label}"));
        }
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tool_group_keeps_failure_and_interruption_visible_before_expansion() {
        let tools = [
            ToolCall {
                name: "exec".into(),
                complete: true,
                ..Default::default()
            },
            ToolCall {
                name: "read".into(),
                complete: true,
                ..Default::default()
            },
            ToolCall {
                name: "web_fetch".into(),
                complete: true,
                is_error: true,
                ..Default::default()
            },
        ];
        assert_eq!(
            group_summary(&tools),
            "1 command · 1 read · 1 fetch · 1 failed"
        );
        let mut interrupted = tools.to_vec();
        interrupted[2].is_error = false;
        interrupted[2].inactive = true;
        assert_eq!(
            group_summary(&interrupted),
            "1 command · 1 read · 1 fetch · 1 interrupted"
        );
    }

    #[test]
    fn terminal_and_edit_results_keep_authoritative_details_through_live_events() {
        let mut calls = Vec::new();
        for (seq, data) in [
            (
                1,
                json!({"toolCallId":"cmd","phase":"start","name":"exec","args":{"command":"exit 7","timeout":10}}),
            ),
            (
                2,
                json!({"toolCallId":"cmd","phase":"result","result":{"content":[{"type":"text","text":"failed"}],"details":{"exitCode":7}},"isError":true}),
            ),
            (
                3,
                json!({"toolCallId":"edit","phase":"start","name":"edit","args":{"path":"src/app.rs","oldText":"wrong","newText":"wrong too"}}),
            ),
            (
                4,
                json!({"toolCallId":"edit","phase":"result","result":{"content":[{"type":"text","text":"edited"}],"details":{"diff":"-12 old\n+12 new"}}}),
            ),
        ] {
            let event = serde_json::from_value(
                json!({"runId":"proof","stream":"tool","seq":seq,"ts":seq*100,"data":data}),
            )
            .unwrap();
            assert!(super::super::apply_tool_event(&mut calls, &event, seq));
        }
        assert_eq!(calls[0].command(), Some("exit 7"));
        assert_eq!(calls[0].extra_args(), [("timeout".into(), "10".into())]);
        assert_eq!(calls[0].outcome(), "Exit code 7");
        assert_eq!(calls[1].workspace_path(), Some("src/app.rs"));
        assert_eq!(
            calls[1].diff(),
            [
                DiffLine {
                    kind: DiffKind::Delete,
                    number: Some(12),
                    text: "old".into()
                },
                DiffLine {
                    kind: DiffKind::Add,
                    number: Some(12),
                    text: "new".into()
                },
            ]
        );
    }

    #[test]
    fn live_url_only_tool_result_reaches_ordered_media_projection() {
        use crate::model::chat::MessageContent;
        let mut calls = Vec::new();
        let event = serde_json::from_value(json!({
            "runId":"media-proof", "stream":"tool", "seq":1, "ts":100,
            "data":{"toolCallId":"image", "name":"web_fetch", "phase":"result", "result":{
                "content":[{"type":"image", "url":"https://example.invalid/landscape.png", "mimeType":"image/png"}]
            }}
        })).unwrap();
        assert!(super::super::apply_tool_event(&mut calls, &event, 1));
        assert!(
            calls[0].output.is_empty(),
            "image-only results have no terminal text"
        );
        let message = calls[0]
            .rich_result()
            .expect("URL media must remain renderable without decoded attachments");
        assert!(message.attachments.is_empty());
        assert_eq!(
            message.media[0].url.as_deref(),
            Some("https://example.invalid/landscape.png")
        );
        assert_eq!(message.ordered_content(), [MessageContent::Media(0)]);
        let plain = ToolCall {
            result: json!({"content":[{"type":"text","text":"terminal output"}]}),
            ..Default::default()
        };
        assert!(
            plain.rich_result().is_none(),
            "plain tool output stays terminal text"
        );
    }

    #[test]
    fn edits_preserve_context_and_empty_sides_without_inventing_rows() {
        for (old, new, expected) in [
            (
                "a\nb\nc\n",
                "a\nx\nc\n",
                vec![
                    (DiffKind::Context, "a"),
                    (DiffKind::Delete, "b"),
                    (DiffKind::Add, "x"),
                    (DiffKind::Context, "c"),
                ],
            ),
            ("delete\n", "", vec![(DiffKind::Delete, "delete")]),
            ("", "insert\n", vec![(DiffKind::Add, "insert")]),
            ("same\n", "same\n", vec![]),
        ] {
            let tool = ToolCall {
                name: "edit".into(),
                args: json!({"path":"a","oldText":old,"newText":new}),
                ..Default::default()
            };
            assert_eq!(
                tool.diff()
                    .into_iter()
                    .map(|line| (line.kind, line.text))
                    .collect::<Vec<_>>(),
                expected
                    .into_iter()
                    .map(|(kind, text)| (kind, text.into()))
                    .collect::<Vec<_>>()
            );
        }
        let tool = ToolCall {
            name: "write".into(),
            args: json!({"path":"a","content":"existing"}),
            result: json!({"details":{"changed":false}}),
            ..Default::default()
        };
        assert!(tool.diff().is_empty());
    }
}
