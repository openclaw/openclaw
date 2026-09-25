use super::chat::Message;

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
