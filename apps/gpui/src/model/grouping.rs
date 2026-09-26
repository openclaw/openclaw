use super::chat::Message;

#[derive(Default)]
pub struct GroupMetadata {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
    pub prompt: u64,
    pub model: Option<String>,
}

impl GroupMetadata {
    pub fn from_messages(messages: &[Message]) -> Self {
        let mut meta = Self::default();
        for message in messages
            .iter()
            .filter(|message| message.role == "assistant")
        {
            let usage = &message.usage;
            meta.input += usage.input;
            meta.output += usage.output;
            meta.cache_read += usage.cache_read;
            meta.cache_write += usage.cache_write;
            meta.prompt = meta
                .prompt
                .max(usage.input + usage.cache_read + usage.cache_write);
            meta.cost += usage
                .cost
                .get("total")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(0.);
            if let Some(model) = &message.model
                && model != "gateway-injected"
            {
                meta.model = Some(model.clone());
            }
        }
        meta
    }
}

/// Groups remain separate virtual rows; this flag removes only repeated chrome.
pub fn starts_group(previous: Option<&Message>, message: &Message) -> bool {
    let Some(previous) = previous else {
        return true;
    };
    message.system
        || previous.system
        || message.turn_boundary
        || previous.role != message.role
        || previous.run_id != message.run_id
        || previous.sender != message.sender
        || previous.sender_key != message.sender_key
        || previous.source_clients != message.source_clients
        || previous.phase != message.phase
        || (message.role == "user" && previous.send_id != message.send_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn group_metadata_sums_calls_but_uses_peak_prompt_for_context() {
        let rows = [
            serde_json::json!({"role":"assistant", "content":"a", "model":"provider/first", "usage":{"inputTokens":20,"outputTokens":5,"cache_read_input_tokens":70,"cache_creation_input_tokens":10,"cost":{"total":0.25}}}),
            serde_json::json!({"role":"user", "content":"b", "usage":{"input":999}}),
            serde_json::json!({"role":"assistant", "content":"c", "model":"provider/last", "usage":{"input":15,"output":8,"cacheRead":30,"cost":{"total":0.5}}}),
        ].iter().filter_map(Message::from_value).collect::<Vec<_>>();
        let meta = GroupMetadata::from_messages(&rows);
        assert_eq!(
            (
                meta.input,
                meta.output,
                meta.cache_read,
                meta.cache_write,
                meta.prompt
            ),
            (35, 13, 100, 10, 100)
        );
        assert_eq!(meta.cost, 0.75);
        assert_eq!(meta.model.as_deref(), Some("provider/last"));
    }

    #[test]
    fn role_run_sender_phase_and_explicit_turn_split_groups() {
        let a = Message {
            role: "assistant".into(),
            text: "a".into(),
            run_id: Some("run".into()),
            ..Default::default()
        };
        let b = Message {
            text: "b".into(),
            ..a.clone()
        };
        assert!(!starts_group(Some(&a), &b));
        for changed in [
            Message {
                role: "user".into(),
                ..b.clone()
            },
            Message {
                run_id: Some("other".into()),
                ..b.clone()
            },
            Message {
                sender: Some("Other".into()),
                ..b.clone()
            },
            Message {
                phase: Some("final".into()),
                ..b.clone()
            },
            Message {
                turn_boundary: true,
                ..b.clone()
            },
            Message {
                system: true,
                ..b.clone()
            },
        ] {
            assert!(starts_group(Some(&a), &changed));
        }
    }

    #[test]
    fn assistant_tool_activity_and_reply_share_the_run_avatar() {
        let activity = Message::from_value(&serde_json::json!({
            "role": "assistant",
            "__openclaw": {"runId": "one-turn"},
            "content": [{"type": "toolCall", "id": "read-1", "name": "read", "arguments": {"path": "note.txt"}}]
        }))
        .unwrap();
        let reply = Message::from_value(&serde_json::json!({
            "role": "assistant",
            "__openclaw": {"runId": "one-turn"},
            "content": [{"type": "text", "text": "Here is the result."}]
        }))
        .unwrap();
        assert!(!starts_group(Some(&activity), &reply));
        let independent_reply = Message {
            run_id: Some("another-turn".into()),
            ..reply
        };
        assert!(starts_group(Some(&activity), &independent_reply));
    }
}
