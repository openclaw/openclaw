use crate::model::{
    attachments::Attachment,
    tools::{ToolCall, history_call, output_text},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Message {
    pub role: String,
    pub text: String,
    pub thinking: String,
    pub tools: Vec<ToolCall>,
    pub attachments: Vec<Attachment>,
    pub media: Vec<MediaRef>,
    pub id: Option<String>,
    pub entry_id: Option<String>,
    pub run_id: Option<String>,
    pub sender: Option<String>,
    pub sender_key: String,
    pub source_clients: Value,
    pub phase: Option<String>,
    pub turn_boundary: bool,
    pub timestamp: Option<u64>,
    pub model: Option<String>,
    pub usage: MessageUsage,
    pub system: bool,
    pub send_id: Option<String>,
    pub pending: bool,
    pub send_error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaRef {
    pub path: Option<String>,
    pub url: Option<String>,
    pub content_type: Option<String>,
    pub file_name: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MessageUsage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
}

impl Message {
    pub fn from_value(value: &Value) -> Option<Self> {
        let role = value
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or_else(|| {
                if value.pointer("/__openclaw/kind").and_then(Value::as_str) == Some("compaction") {
                    "system"
                } else {
                    ""
                }
            });
        if !matches!(
            role,
            "user" | "assistant" | "system" | "toolResult" | "tool_result" | "tool"
        ) {
            return None;
        }
        let string = |name: &str| {
            value
                .pointer(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let mut message = Self {
            role: role.to_owned(),
            id: string("/__openclaw/id")
                .or_else(|| string("/messageId"))
                .or_else(|| string("/id")),
            entry_id: string("/__openclaw/id")
                .or_else(|| string("/__openclaw/entryId"))
                .or_else(|| string("/entryId")),
            run_id: string("/__openclaw/runId")
                .or_else(|| string("/runId"))
                .or_else(|| {
                    string("/__openclaw/idempotencyKey")
                        .map(|id| id.strip_suffix(":user").unwrap_or(&id).to_owned())
                }),
            send_id: (role == "user")
                .then(|| {
                    string("/__openclaw/idempotencyKey")
                        .or_else(|| string("/idempotencyKey"))
                        .map(|id| id.strip_suffix(":user").unwrap_or(&id).to_owned())
                })
                .flatten(),
            sender: string("/senderLabel").or_else(|| string("/sender/name")),
            sender_key: value
                .get("sender")
                .or_else(|| value.get("senderSession"))
                .map(Value::to_string)
                .unwrap_or_default(),
            source_clients: value.get("sourceClients").cloned().unwrap_or_default(),
            phase: string("/phase").or_else(|| string("/__openclaw/assistantPhase")),
            turn_boundary: value
                .pointer("/__openclaw/turnBoundary")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            timestamp: value.get("timestamp").and_then(Value::as_u64),
            model: string("/model"),
            usage: value
                .get("usage")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default(),
            system: role == "system"
                || string("/provenance/kind").as_deref() == Some("internal_system"),
            media: value
                .pointer("/__openclaw/media")
                .and_then(|value| serde_json::from_value(value.clone()).ok())
                .unwrap_or_default(),
            ..Default::default()
        };
        if let Some(text) = value.get("content").and_then(Value::as_str) {
            message.text = text.to_owned();
        } else if let Some(blocks) = value.get("content").and_then(Value::as_array) {
            let mut text = Vec::new();
            let mut thinking = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text" | "input_text" | "output_text") => {
                        if let Some(part) = block.get("text").and_then(Value::as_str) {
                            text.push(part);
                        }
                    }
                    Some("thinking" | "reasoning") => {
                        if let Some(part) = block
                            .get("thinking")
                            .or_else(|| block.get("text"))
                            .and_then(Value::as_str)
                        {
                            thinking.push(part);
                        }
                    }
                    Some("image" | "file") => {
                        if let Some(attachment) = history_attachment(block) {
                            message.attachments.push(attachment);
                        }
                    }
                    _ => {
                        if let Some(tool) =
                            history_call(block, message.run_id.clone(), message.timestamp)
                        {
                            message.tools.push(tool);
                        }
                    }
                }
            }
            message.text = text.join("\n");
            message.thinking = thinking.join("\n");
        } else if let Some(text) = value.get("text").and_then(Value::as_str) {
            message.text = text.to_owned();
        }
        if matches!(role, "toolResult" | "tool_result" | "tool") {
            message.tools = vec![ToolCall {
                id: string("/toolCallId")
                    .or_else(|| string("/tool_call_id"))
                    .or_else(|| string("/tool_use_id"))
                    .or_else(|| string("/toolUseId"))
                    .unwrap_or_default(),
                run_id: message.run_id.clone(),
                parent_tool_call_id: string("/parentToolCallId"),
                name: string("/toolName")
                    .or_else(|| string("/tool_name"))
                    .or_else(|| string("/name"))
                    .unwrap_or_else(|| "Tool".into()),
                output: output_text(value),
                complete: true,
                is_error: value
                    .get("isError")
                    .or_else(|| value.get("is_error"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                ended_at: message.timestamp,
                ..Default::default()
            }];
            message.text.clear();
        }
        if string("/__openclaw/kind").as_deref() == Some("compaction") {
            message.system = true;
            message.text = match (
                value
                    .pointer("/__openclaw/tokensBefore")
                    .and_then(Value::as_u64),
                value
                    .pointer("/__openclaw/tokensAfter")
                    .and_then(Value::as_u64),
            ) {
                (Some(before), Some(after)) => format!(
                    "Conversation compacted · {} tokens saved",
                    before.saturating_sub(after)
                ),
                _ => "Conversation compacted".into(),
            };
        }
        Some(message)
    }

    pub fn visible(&self) -> bool {
        !self.text.is_empty()
            || !self.thinking.is_empty()
            || !self.tools.is_empty()
            || !self.attachments.is_empty()
            || !self.media.is_empty()
    }
    pub fn same_message(&self, other: &Self) -> bool {
        if let (Some(left), Some(right)) = (&self.send_id, &other.send_id) {
            return left == right;
        }
        if self
            .run_id
            .as_ref()
            .zip(other.run_id.as_ref())
            .is_some_and(|(left, right)| left != right)
        {
            return false;
        }
        match (&self.id, &other.id) {
            (Some(a), Some(b)) => a == b,
            _ => {
                self.role == other.role
                    && self.text == other.text
                    && self.thinking == other.thinking
                    && self.tools == other.tools
                    && self.attachments == other.attachments
            }
        }
    }
}

fn history_attachment(block: &Value) -> Option<Attachment> {
    use crate::model::attachments::AttachmentOrigin;
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use sha2::{Digest, Sha256};
    let content = block
        .get("data")
        .or_else(|| block.pointer("/source/data"))
        .or_else(|| block.get("content"))?
        .as_str()?;
    let mime = block
        .get("mimeType")
        .or_else(|| block.pointer("/source/media_type"))
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let bytes = STANDARD.decode(content).ok()?;
    Some(Attachment {
        id: format!("history:{:x}", Sha256::digest(&bytes)),
        file_name: block
            .get("fileName")
            .or_else(|| block.get("name"))
            .and_then(Value::as_str)
            .unwrap_or(if mime.starts_with("image/") {
                "Image"
            } else {
                "Attachment"
            })
            .to_owned(),
        mime_type: mime.to_owned(),
        origin: AttachmentOrigin::File,
        bytes: bytes.into(),
    })
}
