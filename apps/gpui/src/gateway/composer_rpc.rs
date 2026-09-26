use crate::model::{attachments::AttachmentPayload, commands::Command};
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogScope {
    pub session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandsList {
    #[serde(flatten)]
    pub context: CatalogScope,
    pub scope: &'static str,
    pub include_args: bool,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct CommandsResult {
    pub commands: Vec<Command>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelChoice {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub available: Option<bool>,
    pub manual_selection_allowed: Option<bool>,
    pub thinking_levels: Vec<ThinkingLevel>,
    pub thinking_default: Option<String>,
}

impl ModelChoice {
    pub fn reference(&self) -> String {
        if self.id.starts_with(&format!("{}/", self.provider)) {
            self.id.clone()
        } else {
            format!("{}/{}", self.provider, self.id)
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ThinkingLevel {
    pub id: String,
    pub label: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct ModelsResult {
    pub models: Vec<ModelChoice>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSend {
    pub session_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub message: String,
    pub deliver: bool,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_id: Option<String>,
}
