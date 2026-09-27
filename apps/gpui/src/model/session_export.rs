//! Session-menu export follows session-menu-navigation.ts and chat/export.ts.
use serde_json::Value;
use std::collections::HashMap;

#[derive(Default)]
pub struct TranscriptExport {
    snapshot: Option<Value>,
    pages: Vec<Vec<Value>>,
    counts: HashMap<String, usize>,
    offset: u64,
}

impl TranscriptExport {
    pub const CHANGED: &str = "The conversation changed while copying. Try again.";

    pub fn offset(&self) -> u64 {
        self.offset
    }

    pub fn append(&mut self, page: Value, expected_session: Option<&str>) -> Result<bool, String> {
        if !page.is_object()
            || page
                .get("messages")
                .is_some_and(|messages| !messages.is_null() && !messages.is_array())
            || expected_session
                .filter(|id| !id.is_empty())
                .is_some_and(|id| page["sessionId"].as_str() != Some(id))
            || self.snapshot.as_ref().is_some_and(|snapshot| {
                page.get("sessionId") != snapshot.get("sessionId")
                    || page.get("totalMessages") != snapshot.get("totalMessages")
            })
        {
            return Err(Self::CHANGED.into());
        }
        reject_incomplete_history(&page)?;
        let mut counts = HashMap::<String, usize>::new();
        let mut messages = Vec::new();
        for message in page
            .get("messages")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let keep = if let Some(identity) = projection_identity(message) {
                let count = counts.entry(identity.clone()).or_default();
                *count += 1;
                *count > self.counts.get(&identity).copied().unwrap_or_default()
            } else {
                true
            };
            if keep {
                messages.push(message.clone());
            }
        }
        for (identity, count) in counts {
            let seen = self.counts.entry(identity).or_default();
            *seen = (*seen).max(count);
        }
        let more = page
            .get("hasMore")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if more {
            self.offset = page
                .get("nextOffset")
                .and_then(Value::as_u64)
                .filter(|next| *next > self.offset)
                .ok_or(Self::CHANGED)?;
        }
        self.pages.push(messages);
        self.snapshot.get_or_insert(page);
        Ok(more)
    }

    pub fn needs_tail_verification(&self) -> bool {
        self.pages.len() > 1
    }

    pub fn verify_tail(&self, tail: &Value) -> Result<(), String> {
        let snapshot = self.snapshot.as_ref().ok_or(Self::CHANGED)?;
        if [
            "/sessionId",
            "/totalMessages",
            "/deltaCursor",
            "/sessionInfo/activeLeafEntryId",
        ]
        .iter()
        .any(|field| tail.pointer(field) != snapshot.pointer(field))
        {
            return Err(Self::CHANGED.into());
        }
        reject_incomplete_history(tail)?;
        Ok(())
    }

    pub fn markdown(&self, assistant: &str) -> Option<String> {
        let mut sections = Vec::new();
        for message in self.pages.iter().rev().flatten() {
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let text = extract_text(message);
            if text.trim().is_empty() || hidden(message, role, &text) {
                continue;
            }
            let speaker = if has_tool_envelope(message) {
                "Tool".to_owned()
            } else {
                match role.to_ascii_lowercase().as_str() {
                    "user" => sender_label(message).unwrap_or_else(|| "You".into()),
                    "assistant" => sender_label(message).unwrap_or_else(|| assistant.into()),
                    _ => "Tool".into(),
                }
            };
            let timestamp = message
                .get("timestamp")
                .and_then(iso_timestamp)
                .map(|timestamp| format!(" ({timestamp})"))
                .unwrap_or_default();
            sections.extend([
                format!("## {speaker}{timestamp}"),
                String::new(),
                text,
                String::new(),
            ]);
        }
        (!sections.is_empty())
            .then(|| format!("# Chat with {assistant}\n\n{}", sections.join("\n")))
    }
}

fn reject_incomplete_history(page: &Value) -> Result<(), String> {
    // The budget owner drops all metadata when even its ordinary placeholder
    // exceeds the cap, so that final sentinel needs an exact wire-shape check.
    const UNAVAILABLE: &str = "[chat.history unavailable: transcript too large to display; the full history is preserved on disk]";
    let incomplete = page
        .get("messages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|message| {
            message
                .pointer("/__openclaw/truncated")
                .and_then(Value::as_bool)
                == Some(true)
                || (message.get("role").and_then(Value::as_str) == Some("assistant")
                    && message.get("__openclaw").is_none()
                    && message
                        .get("content")
                        .and_then(Value::as_array)
                        .is_some_and(|content| {
                            matches!(content.as_slice(), [block]
                            if block.get("type").and_then(Value::as_str) == Some("text")
                                && block.get("text").and_then(Value::as_str) == Some(UNAVAILABLE))
                        }))
        });
    if incomplete {
        return Err("Cannot copy the complete conversation because the Gateway returned truncated or omitted messages. Use the web interface to open the full messages.".into());
    }
    Ok(())
}

fn projection_identity(message: &Value) -> Option<String> {
    let source = message
        .pointer("/__openclaw/seq")
        .and_then(Value::as_u64)
        .filter(|seq| *seq > 0 && *seq <= 9_007_199_254_740_991)
        .map(|seq| format!("seq:{seq}"))
        .or_else(|| {
            message
                .pointer("/__openclaw/id")
                .filter(|id| !id.is_null())
                .or_else(|| message.get("messageId"))
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .map(|id| format!("id:{id}"))
        })?;
    let mut projection = message.clone();
    if let Some(metadata) = projection
        .get_mut("__openclaw")
        .and_then(Value::as_object_mut)
    {
        metadata.remove("recordTimestampMs");
    }
    Some(format!("{source}:{projection}"))
}

fn phase(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|phase| matches!(*phase, "final_answer" | "commentary"))
}

fn block_phase(block: &Value) -> Option<String> {
    let signature: Value = serde_json::from_str(block.get("textSignature")?.as_str()?).ok()?;
    (signature.get("v").and_then(Value::as_u64) == Some(1))
        .then(|| phase(signature.get("phase")).map(str::to_owned))
        .flatten()
}

fn extract_text(message: &Value) -> String {
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let content = message.get("content");
    let raw = if role == "assistant" {
        let inline = message
            .get("text")
            .and_then(Value::as_str)
            .or_else(|| content.and_then(Value::as_str));
        if let Some(text) = inline {
            if phase(message.get("phase")) == Some("commentary") {
                String::new()
            } else {
                text.into()
            }
        } else {
            let blocks: Vec<_> = content
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|block| {
                    matches!(
                        block.get("type").and_then(Value::as_str),
                        Some("text" | "input_text" | "output_text")
                    )
                })
                .collect();
            let explicit = blocks.iter().any(|block| block_phase(block).is_some());
            let for_phase = |target: Option<&str>| {
                blocks
                    .iter()
                    .filter_map(|block| {
                        let own_phase = block_phase(block);
                        let resolved = own_phase
                            .as_deref()
                            .or_else(|| (!explicit).then(|| phase(message.get("phase"))).flatten());
                        if resolved != target || (explicit && target.is_none()) {
                            return None;
                        }
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .filter(|text| !text.trim().is_empty())
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let final_text = for_phase(Some("final_answer"));
            if final_text.is_empty() {
                for_phase(None)
            } else {
                final_text
            }
        }
    } else if let Some(content) = content.and_then(Value::as_str) {
        content.into()
    } else {
        let parts: Vec<_> = content
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|block| {
                let kind = block.get("type").and_then(Value::as_str);
                (kind == Some("text")
                    || (role.eq_ignore_ascii_case("user") && kind == Some("input_text"))
                    || (role.eq_ignore_ascii_case("assistant")
                        && matches!(kind, Some("input_text" | "output_text"))))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
            })
            .collect();
        if parts.is_empty() {
            message
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .into()
        } else {
            parts.join("\n")
        }
    };
    strip_runtime_context(&raw)
}

fn strip_runtime_context(text: &str) -> String {
    const BEGIN: &str = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";
    const END: &str = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    let mut result = String::new();
    let mut depth = 0usize;
    for line in text.split_inclusive('\n') {
        match line.trim() {
            BEGIN => {
                depth += 1;
            }
            END if depth > 0 => {
                depth -= 1;
            }
            _ if depth == 0 => result.push_str(line),
            _ => {}
        }
    }
    result
}

fn has_tool_envelope(message: &Value) -> bool {
    [
        "toolCallId",
        "tool_call_id",
        "toolUseId",
        "tool_use_id",
        "toolName",
        "tool_name",
    ]
    .iter()
    .any(|field| message.get(field).is_some_and(Value::is_string))
        || message
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|block| {
                matches!(
                    block
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_ascii_lowercase()
                        .as_str(),
                    "toolcall"
                        | "tool_call"
                        | "tooluse"
                        | "tool_use"
                        | "toolresult"
                        | "tool_result"
                )
            })
}

fn sender_label(message: &Value) -> Option<String> {
    let nonempty = |value: &Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
    };
    if let Some(label) = message.get("senderLabel").and_then(nonempty) {
        if let Some((prefix, suffix)) = label.rsplit_once(" (")
            && suffix
                .strip_suffix(')')
                .is_some_and(|id| id.len() == 36 && uuid::Uuid::parse_str(id).is_ok())
        {
            return Some(prefix.trim().into());
        }
        return Some(label);
    }
    ["senderName", "senderUsername"]
        .iter()
        .find_map(|field| message.get("__openclaw")?.get(field).and_then(nonempty))
        .or_else(|| {
            message
                .pointer("/__openclaw/senderId")
                .and_then(nonempty)
                .map(|id| match id.split_once('@') {
                    Some((name, domain))
                        if !name.is_empty()
                            && !domain.is_empty()
                            && !domain.contains('@')
                            && !id.contains(char::is_whitespace) =>
                    {
                        name.into()
                    }
                    _ => id,
                })
        })
}

fn hidden(message: &Value, role: &str, text: &str) -> bool {
    if role.eq_ignore_ascii_case("toolresult")
        && text.trim()
            == "[openclaw] missing tool result in session history; inserted synthetic error result for transcript repair."
    {
        return true;
    }
    if !role.eq_ignore_ascii_case("assistant") {
        return false;
    }
    if message
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or(text)
        .trim()
        == "NO_REPLY"
    {
        return true;
    }
    if message
        .get("senderLabel")
        .and_then(Value::as_str)
        .is_some_and(|label| !label.trim().is_empty())
    {
        return false;
    }
    if message
        .get("content")
        .and_then(Value::as_array)
        .is_some_and(|blocks| {
            blocks.iter().any(|block| {
                !matches!(
                    block.get("type").and_then(Value::as_str),
                    Some("text" | "thinking" | "reasoning")
                )
            })
        })
    {
        return false;
    }
    let raw = message
        .get("content")
        .and_then(Value::as_str)
        .or_else(|| message.get("text").and_then(Value::as_str))
        .unwrap_or(text);
    let raw = raw.trim().trim_matches(['*', '`', '~', '_']);
    raw == "HEARTBEAT_OK"
        || raw
            .strip_prefix("HEARTBEAT_OK")
            .is_some_and(|tail| tail.trim().encode_utf16().count() <= 300)
}

fn iso_timestamp(value: &Value) -> Option<String> {
    let timestamp = value
        .as_f64()
        .filter(|value| value.abs() <= 8_640_000_000_000_000.)? as i64;
    let seconds = timestamp.div_euclid(1000);
    let days = seconds.div_euclid(86400) + 719468;
    let era = days.div_euclid(146097);
    let day_of_era = days - era * 146097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36524 - day_of_era / 146096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Some(format!(
        "{year}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        seconds.div_euclid(3600).rem_euclid(24),
        seconds.div_euclid(60).rem_euclid(60),
        seconds.rem_euclid(60),
        timestamp.rem_euclid(1000)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn paged_export_preserves_projected_siblings_and_checks_the_final_tail() {
        let first =
            json!({"role":"user", "content":"First", "timestamp":0, "__openclaw":{"seq":1}});
        let answer = json!({"role":"assistant", "content":"Answer", "__openclaw":{"seq":2,"recordTimestampMs":10}});
        let sibling =
            json!({"role":"assistant", "content":"Another projection", "__openclaw":{"seq":2}});
        let mut export = TranscriptExport::default();
        let tail = json!({"sessionId":"s", "totalMessages":3, "deltaCursor":"cursor", "sessionInfo":{"activeLeafEntryId":"leaf"}});
        let mut page = tail.clone();
        page["messages"] = json!([answer.clone(), sibling]);
        page["hasMore"] = json!(true);
        page["nextOffset"] = json!(2);
        assert!(export.append(page, Some("s")).unwrap());
        let mut overlap = answer;
        overlap["__openclaw"]["recordTimestampMs"] = json!(20);
        assert!(
            !export
                .append(
                    json!({"sessionId":"s", "totalMessages":3, "messages":[first,overlap]}),
                    Some("s")
                )
                .unwrap()
        );
        assert!(export.verify_tail(&tail).is_ok());
        assert_eq!(
            export.markdown("Aide").unwrap(),
            "# Chat with Aide\n\n## You (1970-01-01T00:00:00.000Z)\n\nFirst\n\n## Aide\n\nAnswer\n\n## Aide\n\nAnother projection\n"
        );
        for field in [
            "/sessionId",
            "/totalMessages",
            "/deltaCursor",
            "/sessionInfo/activeLeafEntryId",
        ] {
            let mut changed = tail.clone();
            *changed.pointer_mut(field).unwrap() = json!("changed");
            assert!(export.verify_tail(&changed).is_err(), "{field}");
        }
    }

    #[test]
    fn export_rejects_a_growing_or_replaced_transcript_and_stalled_pagination() {
        for second in [
            json!({"sessionId":"other", "totalMessages":2}),
            json!({"sessionId":"s", "totalMessages":3}),
            json!({"sessionId":"s", "totalMessages":2, "hasMore":true, "nextOffset":1}),
            json!({"sessionId":"s", "totalMessages":2, "hasMore":true}),
        ] {
            let mut export = TranscriptExport::default();
            export
                .append(
                    json!({"sessionId":"s", "totalMessages":2, "hasMore":true, "nextOffset":1}),
                    Some("s"),
                )
                .unwrap();
            assert!(export.append(second, Some("s")).is_err());
        }
    }

    #[test]
    fn export_rejects_gateway_display_caps_and_metadata_free_omission_sentinels() {
        // These are the producer shapes in chat-display-projection.sanitize.ts
        // and chat-history-budget.ts; exact tool prefixes need not carry a text marker.
        for message in [
            json!({"role":"toolResult", "content":[{"type":"text","text":"Exact output prefix"}], "__openclaw":{"id":"tool","truncated":true,"reason":"display-cap"}}),
            json!({"role":"assistant", "content":[{"type":"text","text":"[chat.history omitted: message too large]"}], "__openclaw":{"id":"reply","truncated":true,"reason":"oversized"}}),
            json!({"role":"assistant", "timestamp":1, "content":[{"type":"text","text":"[chat.history unavailable: transcript too large to display; the full history is preserved on disk]"}]}),
        ] {
            let mut export = TranscriptExport::default();
            export.append(json!({"sessionId":"s", "totalMessages":2, "messages":[{"role":"assistant","content":"Recent reply"}], "hasMore":true, "nextOffset":1}), Some("s")).unwrap();
            assert_eq!(
                export.append(json!({"sessionId":"s", "totalMessages":2, "messages":[message]}), Some("s")),
                Err("Cannot copy the complete conversation because the Gateway returned truncated or omitted messages. Use the web interface to open the full messages.".into()),
            );
        }

        let mut export = TranscriptExport::default();
        export.append(json!({"messages":[
            {"role":"user", "content":"Example: [chat.history omitted: message too large]"},
            {"role":"assistant", "content":"Literal ...(truncated)... text", "__openclaw":{"truncated":false}}
        ]}), None).unwrap();
        assert_eq!(
            export.markdown("Aide").unwrap(),
            "# Chat with Aide\n\n## You\n\nExample: [chat.history omitted: message too large]\n\n## Aide\n\nLiteral ...(truncated)... text\n"
        );
    }

    #[test]
    fn markdown_uses_visible_phases_senders_and_tool_text_without_a_ui_projection() {
        let mut export = TranscriptExport::default();
        export.append(json!({"messages":[
            {"role":"user", "content":"Question", "__openclaw":{"senderId":"reader@example.invalid"}},
            {"role":"assistant", "content":[
                {"type":"text", "text":"Commentary", "textSignature":"{\"v\":1,\"phase\":\"commentary\"}"},
                {"type":"text", "text":"Final", "textSignature":"{\"v\":1,\"phase\":\"final_answer\"}"}
            ]},
            {"role":"toolResult", "content":"Tool output"},
            {"role":"assistant", "content":"NO_REPLY"}
        ]}), None).unwrap();
        assert_eq!(
            export.markdown("Aide").unwrap(),
            "# Chat with Aide\n\n## reader\n\nQuestion\n\n## Aide\n\nFinal\n\n## Tool\n\nTool output\n"
        );
    }
}
