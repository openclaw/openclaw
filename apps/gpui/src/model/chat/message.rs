use super::notice::SystemNotice;
use crate::model::{
    attachments::Attachment,
    people::{Person, PersonIdentity},
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
    pub content: Vec<MessageContent>,
    pub id: Option<String>,
    pub entry_id: Option<String>,
    pub run_id: Option<String>,
    pub sender: Option<String>,
    pub sender_person: Option<Person>,
    pub sender_agent: Option<String>,
    pub reply_to: Option<String>,
    pub reply_preview: Option<ReplyTarget>,
    pub sender_key: String,
    pub source_clients: Value,
    pub phase: Option<String>,
    pub turn_boundary: bool,
    pub timestamp: Option<u64>,
    pub model: Option<String>,
    pub usage: MessageUsage,
    pub system: bool,
    pub notice: Option<SystemNotice>,
    pub send_id: Option<String>,
    pub pending: bool,
    pub send_error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessageContent {
    Text(String),
    Attachment(usize),
    Media(usize),
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReplyTarget {
    pub id: Option<String>,
    pub text: String,
    pub sender: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MediaRef {
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub path: Option<String>,
    pub artifact_id: Option<String>,
    pub url: Option<String>,
    #[serde(alias = "mimeType")]
    pub content_type: Option<String>,
    pub file_name: Option<String>,
    pub size_bytes: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
    pub alt: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct MessageUsage {
    #[serde(alias = "inputTokens")]
    pub input: u64,
    #[serde(alias = "outputTokens")]
    pub output: u64,
    #[serde(alias = "cache_read_input_tokens")]
    pub cache_read: u64,
    #[serde(alias = "cache_creation_input_tokens")]
    pub cache_write: u64,
    pub total_tokens: u64,
    pub cost: Value,
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
            "user" | "assistant" | "system" | "toolResult" | "tool_result" | "tool" | "custom"
        ) || (role == "custom"
            && value.get("customType").and_then(Value::as_str)
                != Some("openclaw.context-compaction"))
        {
            return None;
        }
        let role = if role == "custom"
            && value.get("customType").and_then(Value::as_str)
                == Some("openclaw.context-compaction")
        {
            "system"
        } else {
            role
        };
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
            sender: string("/senderLabel")
                .or_else(|| string("/__openclaw/senderName"))
                .or_else(|| string("/sender/name")),
            sender_person: sender_person(value),
            sender_agent: string("/senderSession/agentId"),
            reply_to: string("/__openclaw/replyToId")
                .or_else(|| string("/openclawDelivery/replyToId")),
            reply_preview: string("/__openclaw/replyToPreview/text").map(|text| ReplyTarget {
                id: string("/__openclaw/replyToId"),
                text,
                sender: string("/__openclaw/replyToPreview/senderLabel").unwrap_or_default(),
            }),
            sender_key: value
                .pointer("/__openclaw/senderIdentity")
                .or_else(|| value.pointer("/__openclaw/senderId"))
                .or_else(|| value.get("sender"))
                .or_else(|| value.get("senderSession"))
                .map(Value::to_string)
                .unwrap_or_default(),
            source_clients: value
                .pointer("/__openclaw/transport/clients")
                .or_else(|| value.get("sourceClients"))
                .cloned()
                .unwrap_or_default(),
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
            notice: SystemNotice::from_value(value),
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
                            message.content.push(MessageContent::Text(part.to_owned()));
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
                        if let Some(attachment) = block
                            .get("artifactId")
                            .is_none()
                            .then(|| history_attachment(block))
                            .flatten()
                        {
                            message
                                .content
                                .push(MessageContent::Attachment(message.attachments.len()));
                            message.attachments.push(attachment);
                        } else if block.get("artifactId").and_then(Value::as_str).is_some()
                            || block
                                .get("url")
                                .or_else(|| block.pointer("/source/url"))
                                .and_then(Value::as_str)
                                .is_some()
                        {
                            let mut media: MediaRef =
                                serde_json::from_value(block.clone()).unwrap_or_default();
                            media.url = media.url.or_else(|| {
                                block
                                    .pointer("/source/url")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                            });
                            message
                                .content
                                .push(MessageContent::Media(message.media.len()));
                            message.media.push(media);
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
                result: value.clone(),
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
            message.content.clear();
            message.attachments.clear();
            message.media.clear();
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
            || self.notice.is_some()
    }

    pub fn ordered_content(&self) -> Vec<MessageContent> {
        let mut content = self.content.clone();
        if content.is_empty() {
            if !self.text.is_empty() {
                content.push(MessageContent::Text(self.text.clone()));
            }
            content.extend((0..self.attachments.len()).map(MessageContent::Attachment));
        }
        for index in 0..self.media.len() {
            if !content.contains(&MessageContent::Media(index)) {
                content.push(MessageContent::Media(index));
            }
        }
        content
    }

    pub fn is_peer(&self, local_user: Option<&Person>) -> bool {
        self.role == "user"
            && self
                .sender_person
                .as_ref()
                .zip(local_user.and_then(Person::profile_id))
                .is_some_and(|(sender, local)| sender.profile_id() != Some(local))
    }

    pub fn source_label(&self) -> String {
        let mut labels = Vec::new();
        for source in self.source_clients.as_array().into_iter().flatten() {
            let id = source.get("id").and_then(Value::as_str).unwrap_or_default();
            let mode = source
                .get("mode")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let label = match (id, mode) {
                ("openclaw-tui", _) => "TUI",
                (
                    "openclaw-control-ui"
                    | "openclaw-webchat-ui"
                    | "openclaw-webchat"
                    | "openclaw-browser-copilot",
                    _,
                )
                | (_, "webchat") => continue,
                ("cli", _) | (_, "cli") => "CLI",
                (_, "ui") => "App",
                _ => "RPC",
            };
            let label = source
                .get("displayName")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty() && *name != label)
                .map_or_else(|| label.to_owned(), |name| format!("{label} ({name})"));
            if !labels.contains(&label) {
                labels.push(label);
            }
        }
        if labels.is_empty() {
            String::new()
        } else {
            format!("via {}", labels.join(", "))
        }
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
                    && self.media == other.media
                    && self.ordered_content() == other.ordered_content()
                    && self.sender_key == other.sender_key
            }
        }
    }
}

fn sender_person(value: &Value) -> Option<Person> {
    if let Some(meta) = value.get("__openclaw") {
        let identity = meta
            .get("senderIdentity")
            .and_then(|v| serde_json::from_value::<PersonIdentity>(v.clone()).ok());
        let string = |name| meta.get(name).and_then(Value::as_str).map(str::to_owned);
        let id = string("senderId").or_else(|| identity.as_ref().map(|id| id.id.clone()));
        let name = string("senderName").or_else(|| string("senderUsername"));
        if id.is_some() || name.is_some() {
            return Some(Person {
                id: id.unwrap_or_default(),
                name,
                identity,
                avatar_url: string("senderProfileAvatarUrl"),
                ..Default::default()
            });
        }
    }
    value
        .get("sender")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .or_else(|| {
            value
                .get("senderLabel")
                .and_then(Value::as_str)
                .map(|name| Person {
                    name: Some(name.to_owned()),
                    ..Default::default()
                })
        })
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transcript_blocks_keep_media_between_their_surrounding_text() {
        let message = Message::from_value(&json!({
            "role": "assistant",
            "content": [
                {"type":"text", "text":"Before image"},
                {"type":"image", "mimeType":"image/png", "data":"aW1hZ2U="},
                {"type":"text", "text":"Between image and file"},
                {"type":"file", "fileName":"notes.txt", "mimeType":"text/plain", "data":"bm90ZXM="},
                {"type":"text", "text":"After file"}
            ]
        }))
        .unwrap();
        let rendered = message
            .ordered_content()
            .into_iter()
            .map(|part| match part {
                MessageContent::Text(text) => text,
                MessageContent::Attachment(index) => message.attachments[index].file_name.clone(),
                MessageContent::Media(_) => panic!("inline bytes are admitted attachments"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            rendered,
            [
                "Before image",
                "Image",
                "Between image and file",
                "notes.txt",
                "After file"
            ]
        );
        assert_eq!(
            message.text,
            "Before image\nBetween image and file\nAfter file"
        );
        let reordered = Message::from_value(&json!({
            "role": "assistant",
            "content": [
                {"type":"image", "mimeType":"image/png", "data":"aW1hZ2U="},
                {"type":"text", "text":"Before image"},
                {"type":"text", "text":"Between image and file"},
                {"type":"file", "fileName":"notes.txt", "mimeType":"text/plain", "data":"bm90ZXM="},
                {"type":"text", "text":"After file"}
            ]
        }))
        .unwrap();
        assert!(!message.same_message(&reordered));
    }

    #[test]
    fn canonical_artifacts_keep_download_identity_and_layout_metadata() {
        let message = Message::from_value(&json!({
            "role":"assistant", "content":[
                {"type":"text","text":"Generated image:"},
                {"type":"image","artifactId":"image:session:entry:1","url":"/api/media/generated.png","mimeType":"image/png","width":1024,"height":768,"fileName":"landscape.png","sizeBytes":2048,"alt":"Synthetic mountain landscape"},
                {"type":"text","text":"After the image"}
            ]
        })).unwrap();
        assert!(matches!(
            message.ordered_content().as_slice(),
            [
                MessageContent::Text(_),
                MessageContent::Media(0),
                MessageContent::Text(_)
            ]
        ));
        let media = &message.media[0];
        assert_eq!(media.artifact_id.as_deref(), Some("image:session:entry:1"));
        assert_eq!(media.url.as_deref(), Some("/api/media/generated.png"));
        assert_eq!(media.content_type.as_deref(), Some("image/png"));
        assert_eq!(
            (media.width, media.height, media.size_bytes),
            (Some(1024), Some(768), Some(2048))
        );
        assert_eq!(media.file_name.as_deref(), Some("landscape.png"));
        assert_eq!(media.alt.as_deref(), Some("Synthetic mountain landscape"));
        let file = Message::from_value(&json!({"role":"assistant","content":[{"type":"file","artifactId":"artifact-pdf","mimeType":"application/pdf","fileName":"report.pdf"}]})).unwrap();
        assert!(matches!(
            file.ordered_content().as_slice(),
            [MessageContent::Media(0)]
        ));
        assert_eq!(file.media[0].artifact_id.as_deref(), Some("artifact-pdf"));
        assert_eq!(file.media[0].kind.as_deref(), Some("file"));
        assert_eq!(
            file.media[0].content_type.as_deref(),
            Some("application/pdf")
        );
        assert_eq!(file.media[0].file_name.as_deref(), Some("report.pdf"));
        assert_eq!(file.media[0].url, None);
    }

    #[test]
    fn history_sender_identity_reply_and_sources_survive_projection() {
        let message = Message::from_value(&json!({
            "role":"user", "content":"Answering the earlier question",
            "__openclaw": {
                "id":"reply-1", "senderIdentity":{"type":"profile", "id":"alex"},
                "senderId":"alex", "senderName":"Alex Example", "senderProfileAvatarUrl":"/api/users/alex/avatar",
                "replyToId":"question-1", "replyToPreview":{"text":"Which option?", "senderLabel":"Assistant"},
                "transport":{"clients":[{"id":"openclaw-control-ui","mode":"webchat"},{"id":"openclaw-tui","mode":"cli"}]}
            }
        })).unwrap();
        let local = Person {
            identity: Some(PersonIdentity {
                kind: "profile".into(),
                id: "viewer".into(),
            }),
            ..Default::default()
        };
        assert!(message.is_peer(Some(&local)));
        assert!(!message.is_peer(message.sender_person.as_ref()));
        assert!(!message.is_peer(None));
        assert_eq!(message.sender.as_deref(), Some("Alex Example"));
        assert_eq!(
            message
                .sender_person
                .as_ref()
                .and_then(|person| person.avatar_url.as_deref()),
            Some("/api/users/alex/avatar")
        );
        assert_eq!(message.reply_to.as_deref(), Some("question-1"));
        assert_eq!(
            message.reply_preview.as_ref().unwrap().text,
            "Which option?"
        );
        assert_eq!(message.source_label(), "via TUI");
    }
}
