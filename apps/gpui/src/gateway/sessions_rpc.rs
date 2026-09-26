//! Wire contracts: packages/gateway-protocol/src/schema/sessions-{list,patch,create,delete,search}.ts.
use crate::model::{
    sessions::SessionRow,
    sidebar::{ArchiveFilter, SidebarPreferences},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub limit: usize,
    pub offset: usize,
    pub include_derived_titles: bool,
    pub include_last_message: bool,
    pub sort_by: &'static str,
    pub include_global: bool,
    pub include_unknown: bool,
    pub configured_agents_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_subagents: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub archived: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub involving_me: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_first: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<String>,
}
impl ListParams {
    pub fn page(agent_id: Option<String>, offset: usize) -> Self {
        Self {
            agent_id,
            limit: 200,
            offset,
            include_derived_titles: true,
            include_last_message: true,
            sort_by: "updatedAt",
            include_global: true,
            include_unknown: true,
            configured_agents_only: true,
            exclude_subagents: None,
            archived: None,
            owner_id: None,
            involving_me: None,
            owner_first: None,
            spawned_by: None,
        }
    }
    pub fn with_preferences(mut self, prefs: &SidebarPreferences, self_id: Option<&str>) -> Self {
        self.archived = match prefs.archive {
            ArchiveFilter::Active => None,
            ArchiveFilter::Archived => Some(Value::Bool(true)),
            ArchiveFilter::All => Some(Value::String("all".into())),
        };
        self.owner_id = if prefs.involving_me {
            None
        } else {
            prefs.owner_id.clone()
        };
        self.involving_me = prefs.involving_me.then_some(true);
        self.owner_first = (self.offset == 0
            && self.spawned_by.is_none()
            && !prefs.filtered()
            && self_id.is_some_and(|id| !id.is_empty()))
        .then_some(true);
        self
    }
    pub fn activity() -> Self {
        Self {
            exclude_subagents: Some(true),
            include_derived_titles: false,
            include_last_message: false,
            ..Self::page(None, 0)
        }
    }
    pub fn children(agent_id: Option<String>, key: String) -> Self {
        Self {
            limit: 100,
            spawned_by: Some(key),
            ..Self::page(agent_id, 0)
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdentity {
    pub key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_session_id: Option<String>,
}
impl SessionIdentity {
    pub fn from_row(row: &SessionRow, selected_agent: Option<&str>) -> Self {
        Self {
            key: row.key.clone(),
            agent_id: row.agent().or(selected_agent).map(str::to_owned),
            expected_session_id: row.session_id.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchParams {
    #[serde(flatten)]
    pub identity: SessionIdentity,
    #[serde(flatten)]
    pub fields: Value,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteParams {
    #[serde(flatten)]
    pub identity: SessionIdentity,
    pub delete_transcript: bool,
    pub archived_only: bool,
}
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CreateParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_from: Option<&'static str>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Created {
    pub key: String,
}
#[derive(Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct AgentIdentity {
    pub name: Option<String>,
    pub emoji: Option<String>,
    pub avatar: Option<String>,
    pub avatar_url: Option<String>,
}
#[derive(Clone, Deserialize, Default)]
#[serde(default)]
pub struct Agent {
    pub id: String,
    pub name: Option<String>,
    pub identity: AgentIdentity,
    pub workspace: Option<String>,
    #[serde(rename = "workspaceGit")]
    pub workspace_git: bool,
    pub model: Option<serde_json::Value>,
    #[serde(rename = "agentRuntime")]
    pub agent_runtime: Option<super::composer_rpc::AgentRuntime>,
    #[serde(rename = "defaultPermissionMode")]
    pub default_permission_mode: Option<String>,
}
impl Agent {
    pub fn name(&self) -> &str {
        self.identity
            .name
            .as_deref()
            .or(self.name.as_deref())
            .unwrap_or(&self.id)
    }
    pub fn avatar(&self) -> String {
        self.identity.emoji.clone().unwrap_or_else(|| {
            self.name()
                .chars()
                .next()
                .unwrap_or('◈')
                .to_uppercase()
                .collect()
        })
    }
}
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Agents {
    pub default_id: String,
    pub main_key: String,
    pub scope: String,
    pub agents: Vec<Agent>,
}
#[derive(Deserialize, Clone, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct SearchHit {
    pub session_key: String,
    pub message_id: String,
    pub snippet: String,
    pub role: String,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SearchResults {
    pub results: Vec<SearchHit>,
    pub sessions: Vec<SessionRow>,
    pub indexing: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: String,
    pub limit: usize,
    pub scope: SearchScope,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchScope {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}
pub fn params(value: impl Serialize) -> Value {
    serde_json::to_value(value).expect("typed RPC parameters serialize")
}

#[cfg(test)]
mod sidebar_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn agent_roster_accepts_omitted_optional_capabilities() {
        let roster: Agents = serde_json::from_value(json!({
            "defaultId":"qa", "agents":[{"id":"qa","name":"QA"}]
        }))
        .unwrap();
        assert_eq!(roster.agents[0].name(), "QA");
        assert!(!roster.agents[0].workspace_git);
        assert!(roster.agents[0].workspace.is_none());
        assert!(roster.agents[0].default_permission_mode.is_none());
    }
    #[test]
    fn sidebar_filters_use_gateway_membership_and_archive_wire_contracts() {
        let activity = params(ListParams::activity());
        assert_eq!(activity["excludeSubagents"], true);
        assert_eq!(activity["configuredAgentsOnly"], true);
        assert!(activity.get("agentId").is_none());
        let mut prefs = SidebarPreferences::default();
        let first =
            params(ListParams::page(Some("qa".into()), 0).with_preferences(&prefs, Some("me")));
        assert_eq!(first["limit"], 200);
        assert_eq!(first["ownerFirst"], true);
        assert!(first.get("archived").is_none());
        prefs.archive = ArchiveFilter::Archived;
        prefs.owner_id = Some("me".into());
        let archived = params(ListParams::page(None, 0).with_preferences(&prefs, Some("me")));
        assert_eq!(archived["archived"], true);
        assert_eq!(archived["ownerId"], "me");
        assert!(archived.get("ownerFirst").is_none());
        prefs.archive = ArchiveFilter::All;
        prefs.involving_me = true;
        let all = params(ListParams::page(None, 200).with_preferences(&prefs, Some("me")));
        assert_eq!(all["archived"], json!("all"));
        assert_eq!(all["involvingMe"], true);
        assert!(all.get("ownerId").is_none());
        assert!(all.get("ownerFirst").is_none());
    }
}
