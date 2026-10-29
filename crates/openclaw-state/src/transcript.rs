//! Stored-transcript reader for the Gateway `sessions.get` contract.
//!
//! Documented: `sessions.get` returns `{ messages }` from the OpenClaw-owned
//! stored transcript (`docs/gateway/protocol/rpc-session-control.md:117`). The
//! Gateway reaches this through the `TranscriptReader` trait so it does not depend
//! on the concrete SQLite store.

use crate::SqliteStateStore;
use openclaw_core::id::SessionId;
use serde_json::{json, Value};

impl SqliteStateStore {
    /// Recent transcript messages in chronological order, shaped for the wire.
    ///
    /// Returns `role`, `text`, and `timestamp` per message; older rows are dropped
    /// first so a long session cannot blow the frame budget.
    #[must_use]
    pub fn transcript_messages(&self, session_id: &str, limit: usize) -> Vec<Value> {
        let session = SessionId::from_raw(session_id);
        let Ok(turns) = self.load_conversation_turns(&session, limit) else {
            return Vec::new();
        };
        turns
            .into_iter()
            .map(|(role, text, timestamp)| {
                json!({
                    "role": role,
                    "text": text,
                    "timestamp": timestamp,
                })
            })
            .collect()
    }
}
