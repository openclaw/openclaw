use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SessionEntry {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sessionFile", skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(rename = "updatedAt")]
    pub updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(rename = "agentId", skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(rename = "chatType", skip_serializing_if = "Option::is_none")]
    pub chat_type: Option<String>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct SessionStore {
    #[serde(flatten)]
    pub sessions: HashMap<String, SessionEntry>,
}
