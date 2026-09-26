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
    pub alias: Option<String>,
    pub tags: Vec<String>,
    pub available: Option<bool>,
    pub unavailable_reason: Option<String>,
    pub manual_selection_allowed: Option<bool>,
    pub context_window: Option<u64>,
    pub context_tokens: Option<u64>,
    pub context_windows: Vec<ContextWindowOption>,
    pub context_window_default: Option<String>,
    pub reasoning: Option<bool>,
    pub thinking_levels: Option<Vec<ThinkingLevel>>,
    pub thinking_default: Option<String>,
    pub effective_fast_mode: Option<FastMode>,
    pub supports_fast_mode: Option<bool>,
    pub supports_tools: Option<bool>,
    pub agent_runtime: Option<AgentRuntime>,
    pub runtime_choices: Vec<ModelRuntimeChoice>,
}

impl ModelChoice {
    pub fn reference(&self) -> String {
        let id = self.id.trim();
        let provider = self.provider.trim();
        if provider.is_empty()
            || id
                .to_lowercase()
                .starts_with(&format!("{}/", provider.to_lowercase()))
        {
            id.to_owned()
        } else {
            format!("{provider}/{id}")
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentRuntime {
    pub id: String,
    pub source: String,
    pub device_placement: Option<DevicePlacement>,
    pub cloud_placement_supported: Option<bool>,
    pub cloud_placement_execution_mode: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevicePlacement {
    pub required_node_commands: Vec<String>,
    pub consumes_worker_slot: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelRuntimeChoice {
    pub agent_runtime: AgentRuntime,
    pub available: Option<bool>,
    pub manual_selection_allowed: Option<bool>,
    pub unavailable_reason: Option<String>,
    pub context_window: Option<u64>,
    pub context_tokens: Option<u64>,
    pub context_windows: Vec<ContextWindowOption>,
    pub context_window_default: Option<String>,
    pub reasoning: Option<bool>,
    pub thinking_levels: Option<Vec<ThinkingLevel>>,
    pub thinking_default: Option<String>,
    pub effective_fast_mode: Option<FastMode>,
    pub supports_fast_mode: Option<bool>,
    pub supports_tools: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default)]
pub struct ThinkingLevel {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct ContextWindowOption {
    pub id: String,
    pub label: String,
    pub context_window: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FastMode {
    On,
    Off,
    Auto,
}

impl Serialize for FastMode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::On => serializer.serialize_bool(true),
            Self::Off => serializer.serialize_bool(false),
            Self::Auto => serializer.serialize_str("auto"),
        }
    }
}

impl<'de> Deserialize<'de> for FastMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match serde_json::Value::deserialize(deserializer)? {
            serde_json::Value::Bool(true) => Ok(Self::On),
            serde_json::Value::Bool(false) => Ok(Self::Off),
            serde_json::Value::String(value) if value == "auto" => Ok(Self::Auto),
            _ => Err(serde::de::Error::custom("expected boolean or auto")),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelsResult {
    pub models: Vec<ModelChoice>,
    pub model_selection_policy: Option<ModelSelectionPolicy>,
    pub account_selection: Option<ChatAccountSelection>,
    pub pending_providers: Vec<String>,
    pub refresh_failed: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelSelectionPolicy {
    pub restricted: bool,
    pub default_model: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ChatAccountSelection {
    pub kind: String,
    pub label: String,
    pub auth_profile_id: Option<String>,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UserModelAccount {
    pub auth_profile_id: String,
    pub provider: String,
    pub label: String,
    pub auth_type: String,
    pub selected: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct UsersListModelAccountsResult {
    pub profile_id: String,
    pub accounts: Vec<UserModelAccount>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelAuthStatusResult {
    pub providers: Vec<ModelAuthStatusProvider>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelAuthStatusProvider {
    pub provider: String,
    pub auth_provider: Option<String>,
    pub display_name: String,
    pub status: String,
    pub profiles: Vec<ModelAuthStatusProfile>,
    pub api_key: Option<ModelAuthApiKey>,
    pub usage: Option<ModelAuthUsage>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelAuthStatusProfile {
    pub profile_id: String,
    #[serde(rename = "type")]
    pub auth_type: String,
    pub status: String,
    pub email: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelAuthApiKey {
    pub source: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ModelAuthUsage {
    pub plan: Option<String>,
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
