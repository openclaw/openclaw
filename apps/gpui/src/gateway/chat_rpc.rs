use serde::{Deserialize, Serialize};

/// packages/gateway-protocol/src/schema/logs-chat.ts:36; older pages use offset, not cursor.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryParams {
    pub session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub limit: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset: Option<usize>,
}

/// sessions.ts:590 creates a fork before the persisted user entry.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkParams {
    pub session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub entry_id: String,
}
#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ForkResult {
    pub session_key: String,
    pub editor_text: Option<String>,
    pub editor_attachments: Vec<EditorAttachment>,
}

#[derive(Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EditorAttachment {
    pub mime_type: String,
    pub data: String,
}
