//! `sessions.get` must serve real stored transcript rows.
//!
//! Documented: `sessions.get` returns `{ messages }` from the OpenClaw-owned stored
//! transcript (`docs/gateway/protocol/rpc-session-control.md:117`). An empty array
//! for a session that has turns would be a silent lie.

use openclaw_core::id::{ChannelId, MessageId, SessionId, UserId};
use openclaw_core::message::{InboundMessage, MessageContent};
use openclaw_core::traits::StateStore;
use openclaw_state::SqliteStateStore;

#[tokio::test]
async fn transcript_messages_are_returned_in_order() {
    let store = SqliteStateStore::in_memory().unwrap();
    let session = SessionId::from_raw("web_main");

    for text in ["first", "second"] {
        let inbound = InboundMessage {
            id: MessageId::new(),
            channel: ChannelId::from_raw("webchat"),
            session: session.clone(),
            author: UserId::from_raw("operator"),
            content: MessageContent::Text {
                text: text.to_owned(),
            },
            timestamp: chrono::Utc::now(),
            raw: None,
            mentions_assistant: true,
            reply_to: None,
        };
        store.save_inbound(&inbound).await.unwrap();
    }

    let messages = store.transcript_messages("web_main", 50);
    assert_eq!(messages.len(), 2, "both stored turns must be returned");
    assert_eq!(messages[0]["text"], "first", "{messages:?}");
    assert_eq!(messages[1]["text"], "second", "{messages:?}");
    assert_eq!(messages[0]["role"], "user", "{messages:?}");
}

#[tokio::test]
async fn limit_keeps_the_newest_turns() {
    let store = SqliteStateStore::in_memory().unwrap();
    let session = SessionId::from_raw("web_main");
    for index in 0..5 {
        let inbound = InboundMessage {
            id: MessageId::new(),
            channel: ChannelId::from_raw("webchat"),
            session: session.clone(),
            author: UserId::from_raw("operator"),
            content: MessageContent::Text {
                text: format!("turn-{index}"),
            },
            timestamp: chrono::Utc::now(),
            raw: None,
            mentions_assistant: true,
            reply_to: None,
        };
        store.save_inbound(&inbound).await.unwrap();
    }

    let messages = store.transcript_messages("web_main", 2);
    assert_eq!(messages.len(), 2, "{messages:?}");
    // Newest two, still chronological.
    assert_eq!(messages[1]["text"], "turn-4", "{messages:?}");
}

#[test]
fn unknown_session_returns_no_messages() {
    let store = SqliteStateStore::in_memory().unwrap();
    assert!(store.transcript_messages("nope", 10).is_empty());
}
