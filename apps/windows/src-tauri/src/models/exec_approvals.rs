use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecSecurity {
    Deny,
    Allow,
    Allowlist,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecAsk {
    Never,
    New,
    Always,
}

#[derive(Debug, Serialize, Deserialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExecApprovalDecision {
    Deny,
    AllowOnce,
    AllowAlways,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecAllowlistEntry {
    pub pattern: String,
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub use_count: u32,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecAgentSettings {
    pub security: ExecSecurity,
    pub ask: ExecAsk,
    #[serde(default)]
    pub auto_allow_skills: bool,
}

impl Default for ExecAgentSettings {
    fn default() -> Self {
        Self {
            security: ExecSecurity::Allowlist,
            ask: ExecAsk::New,
            auto_allow_skills: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecApprovalsFile {
    pub global: ExecAgentSettings,
    #[serde(default)]
    pub agents: HashMap<String, ExecAgentSettings>,
    #[serde(default)]
    pub allowlist: Vec<ExecAllowlistEntry>,
    #[serde(default)]
    pub global_allowlist: Vec<ExecAllowlistEntry>,
}

impl Default for ExecApprovalsFile {
    fn default() -> Self {
        Self {
            global: ExecAgentSettings::default(),
            agents: HashMap::new(),
            allowlist: Vec::new(),
            global_allowlist: Vec::new(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExecApprovalsSnapshot {
    pub path: String,
    pub exists: bool,
    pub hash: String,
    pub file: ExecApprovalsFile,
}
