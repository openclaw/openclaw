//! New-session wire contracts from packages/gateway-protocol/src/schema.
use crate::model::{attachments::AttachmentPayload, sessions::SessionRow};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraftParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
    pub agent_id: String,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_runtime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fast_mode: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_overrides: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incognito: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visibility: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_git_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<RepositorySource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_source: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_base_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RepositorySource {
    pub url: String,
    #[serde(rename = "ref", skip_serializing_if = "Option::is_none")]
    pub reference: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDraftResult {
    pub key: String,
    pub session_id: Option<String>,
    #[serde(default, deserialize_with = "read_created_entry")]
    pub entry: Option<SessionRow>,
    #[serde(default)]
    pub run_started: bool,
    pub run_id: Option<String>,
    pub run_error: Option<InitialRunError>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct InitialRunError {
    pub message: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchParams {
    pub key: String,
    pub agent_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_device: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine_class: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DispatchResult {
    pub key: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub placement: Placement,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Placement {
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DescribedSessionResult {
    pub session: Option<SessionRow>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInitialTurnParams {
    pub key: String,
    pub agent_id: String,
    pub message: String,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<AttachmentPayload>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct EnvironmentsResult {
    pub environments: Vec<Environment>,
    pub profiles: Vec<CloudProfile>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: Option<String>,
    pub status: String,
    pub platform: Option<String>,
    pub session_host: Option<bool>,
    pub worker_slots: Option<WorkerSlots>,
    pub required_node_command: Option<RequiredNodeCommand>,
    #[serde(default)]
    pub issues: Vec<RuntimeTargetIssue>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct WorkerSlots {
    pub total: u32,
    pub available: u32,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RequiredNodeCommand {
    pub command: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct RuntimeTargetIssue {
    pub code: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudProfile {
    pub id: String,
    pub provider_id: String,
    #[serde(default)]
    pub execution_modes: Vec<String>,
    #[serde(default)]
    pub machines: Vec<MachineOption>,
    #[serde(default)]
    pub operating_systems: Vec<OperatingSystem>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineOption {
    pub id: String,
    pub label: String,
    pub os: Option<String>,
    pub cpu: Option<u32>,
    pub memory_gb: Option<u32>,
    #[serde(default)]
    pub default: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatingSystem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub default: bool,
    pub disabled_reason: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct ProjectsResult {
    pub projects: Vec<Project>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub display_name: String,
    pub repo_root: Option<String>,
    pub origin_url: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BranchesResult {
    pub branches: Vec<Branch>,
    pub default_branch: Option<String>,
    pub head_branch: Option<String>,
    pub repository_status: Option<String>,
    pub branches_unavailable: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Branch {
    pub name: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DirectoryResult {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirectoryEntry>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub hidden: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
pub struct GroupDefaultsResult {
    pub defaults: Vec<GroupDefault>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct GroupDefault {
    pub name: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub worktree: bool,
}

fn read_created_entry<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<SessionRow>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    // The entry is an additive projection. A newer field shape must not erase
    // the authoritative key/sessionId receipt and permit duplicate creation.
    Ok(serde_json::from_value(value).ok())
}
