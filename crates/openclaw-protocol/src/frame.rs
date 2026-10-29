use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Error shape returned in a failed response.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ErrorShape {
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
}

/// An incoming frame from a client.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum IncomingFrame {
    #[serde(rename = "req")]
    Request {
        id: String,
        method: String,
        #[serde(default)]
        params: Value,
    },
}

/// An outgoing frame to a client.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum OutgoingFrame {
    Response {
        #[serde(rename = "type")]
        kind: &'static str,
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        payload: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<ErrorShape>,
    },
    Event {
        #[serde(rename = "type")]
        kind: &'static str,
        event: String,
        payload: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        seq: Option<u64>,
    },
}

impl OutgoingFrame {
    /// Build a successful response.
    #[must_use]
    pub fn ok(id: impl Into<String>, payload: Value) -> Self {
        Self::Response {
            kind: "res",
            id: id.into(),
            ok: true,
            payload: Some(payload),
            error: None,
        }
    }

    /// Build a failed response.
    #[must_use]
    pub fn err(id: impl Into<String>, error: ErrorShape) -> Self {
        Self::Response {
            kind: "res",
            id: id.into(),
            ok: false,
            payload: None,
            error: Some(error),
        }
    }

    /// Build a server-pushed event.
    #[must_use]
    pub fn event(event: impl Into<String>, payload: Value) -> Self {
        Self::Event {
            kind: "event",
            event: event.into(),
            payload,
            seq: None,
        }
    }

    /// Build a server-pushed event with a sequence number.
    #[must_use]
    pub fn event_seq(event: impl Into<String>, payload: Value, seq: u64) -> Self {
        Self::Event {
            kind: "event",
            event: event.into(),
            payload,
            seq: Some(seq),
        }
    }
}

/// Convenience alias matching the TypeScript `Frame` union.
pub type Frame = IncomingFrame;
