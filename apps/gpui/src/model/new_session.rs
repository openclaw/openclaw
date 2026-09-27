//! Draft selections follow ui/src/pages/new-session/create-params.ts.
use crate::gateway::new_session_rpc::{
    CloudProfile, CreateDraftParams, DispatchParams, Environment, GroupDefault, RepositorySource,
};
use crate::model::attachments::AttachmentPayload;
use serde_json::Value;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Destination {
    #[default]
    Local,
    Device {
        device_id: String,
    },
    AutomaticDevice,
    Cloud {
        profile_id: String,
        os: String,
        machine_class: String,
    },
}

impl Destination {
    pub fn is_remote(&self) -> bool {
        !matches!(self, Self::Local)
    }

    pub fn dispatch_params(&self, key: &str, agent_id: &str) -> Option<DispatchParams> {
        let mut params = DispatchParams {
            key: key.into(),
            agent_id: normalize_agent_id(agent_id),
            ..Default::default()
        };
        match self {
            Self::Local => return None,
            Self::Device { device_id } => params.device_id = Some(device_id.clone()),
            Self::AutomaticDevice => params.auto_device = Some(true),
            Self::Cloud {
                profile_id,
                os,
                machine_class,
            } => {
                params.profile_id = Some(profile_id.clone());
                params.os = optional(os);
                params.machine_class = optional(machine_class);
            }
        }
        Some(params)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Visibility {
    #[default]
    Normal,
    Incognito,
    Draft,
}

#[derive(Clone, Debug)]
pub struct DraftSession {
    pub agent_id: String,
    pub destination: Destination,
    pub visibility: Visibility,
    pub folder: String,
    pub workspace: String,
    pub project_id: String,
    pub project_git_url: String,
    pub worktree: bool,
    pub fresh_workspace: bool,
    pub base_ref: String,
    pub worktree_name: String,
    pub catalog_id: Option<String>,
    pub category: Option<String>,
    pub display_name: Option<String>,
    pub permission_mode: Option<String>,
    pub tool_overrides: Option<Value>,
}

impl Default for DraftSession {
    fn default() -> Self {
        Self {
            agent_id: "main".into(),
            destination: Destination::Local,
            visibility: Visibility::Normal,
            folder: String::new(),
            workspace: String::new(),
            project_id: String::new(),
            project_git_url: String::new(),
            worktree: false,
            fresh_workspace: true,
            base_ref: String::new(),
            worktree_name: String::new(),
            catalog_id: None,
            category: None,
            display_name: None,
            permission_mode: None,
            tool_overrides: None,
        }
    }
}

impl DraftSession {
    pub fn select_destination(&mut self, destination: Destination) {
        self.worktree = destination.is_remote();
        self.destination = destination;
    }

    pub fn apply_group_default(&mut self, group: &GroupDefault) {
        self.category = Some(group.name.clone());
        self.folder = group.cwd.clone().unwrap_or_else(|| self.workspace.clone());
        self.worktree = group.worktree;
        self.destination = Destination::Local;
        self.fresh_workspace = false;
        self.project_id.clear();
        self.project_git_url.clear();
        self.base_ref.clear();
        self.worktree_name.clear();
    }

    pub fn create_params(
        &self,
        message: &str,
        attachments: Vec<AttachmentPayload>,
        model_settings: &Value,
    ) -> Result<CreateDraftParams, String> {
        let setting = |name: &str| {
            model_settings
                .get(name)
                .and_then(Value::as_str)
                .and_then(optional)
        };
        let remote = self.destination.is_remote();
        let empty_workspace = remote && self.fresh_workspace;
        let repository = if remote && !empty_workspace {
            optional(&self.project_git_url).map(|url| RepositorySource {
                url,
                reference: optional(&self.base_ref),
            })
        } else {
            None
        };
        let worktree = (self.worktree || remote) && !empty_workspace && repository.is_none();
        if worktree && !is_worktree_name_valid(&self.worktree_name) {
            return Err(
                "Use 1–64 lowercase letters, numbers, or hyphens, starting with a letter or number."
                    .into(),
            );
        }
        let project_id = if empty_workspace || repository.is_some() {
            None
        } else {
            optional(&self.project_id)
        };
        let project_git_url = if !remote
            && !empty_workspace
            && project_id.is_none()
            && (!message.trim().is_empty() || !attachments.is_empty())
        {
            optional(&self.project_git_url)
        } else {
            None
        };
        let folder = optional(&self.folder);
        let cwd = if !empty_workspace
            && repository.is_none()
            && project_id.is_none()
            && project_git_url.is_none()
            && folder != optional(&self.workspace)
        {
            folder
        } else {
            None
        };
        let catalog_id = option_text(&self.catalog_id);
        let model = if catalog_id.is_none() {
            setting("model")
        } else {
            None
        };
        let title_source = (remote && self.visibility != Visibility::Incognito)
            .then(|| truncate_utf16(message.trim(), 1_000))
            .filter(|value| !value.is_empty());
        let params = CreateDraftParams {
            agent_id: normalize_agent_id(&self.agent_id),
            message: if remote {
                String::new()
            } else {
                message.into()
            },
            attachments: if remote { Vec::new() } else { attachments },
            display_name: option_text(&self.display_name),
            title_source,
            category: option_text(&self.category),
            agent_runtime: model.as_ref().and_then(|_| setting("agentRuntime")),
            model,
            context_window: catalog_id
                .is_none()
                .then(|| setting("contextWindow"))
                .flatten(),
            thinking_level: catalog_id
                .is_none()
                .then(|| setting("thinkingLevel"))
                .flatten(),
            fast_mode: catalog_id
                .is_none()
                .then(|| {
                    model_settings
                        .get("fastMode")
                        .filter(|value| !value.is_null())
                        .cloned()
                })
                .flatten(),
            permission_mode: option_text(&self.permission_mode),
            tool_overrides: self.tool_overrides.clone().filter(|value| !value.is_null()),
            incognito: (self.visibility == Visibility::Incognito).then_some(true),
            visibility: (self.visibility == Visibility::Draft).then_some("draft"),
            catalog_id,
            project_id,
            project_git_url,
            repository,
            worktree: (worktree || empty_workspace).then_some(true),
            worktree_source: empty_workspace.then_some("empty"),
            worktree_base_ref: worktree.then(|| optional(&self.base_ref)).flatten(),
            worktree_name: worktree.then(|| optional(&self.worktree_name)).flatten(),
            cwd,
            ..Default::default()
        };
        Ok(params)
    }
}

/// Empty input lets the Gateway derive a name from the submitted topic.
pub fn is_worktree_name_valid(value: &str) -> bool {
    let name = value.trim().as_bytes();
    name.is_empty()
        || (name.len() <= 64
            && name[0].is_ascii_alphanumeric()
            && name
                .iter()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || *byte == b'-'))
}

pub fn worktree_branch_name(value: &str) -> Option<String> {
    (is_worktree_name_valid(value) && !value.trim().is_empty())
        .then(|| format!("openclaw/{}", value.trim()))
}

impl Environment {
    pub fn device_id(&self) -> Option<&str> {
        (self.kind == "node")
            .then(|| self.id.strip_prefix("node:"))
            .flatten()
            .map(str::trim)
            .filter(|id| !id.is_empty())
    }

    pub fn device_disabled_reason(
        &self,
        requires_node_command: bool,
        consumes_worker_slot: bool,
    ) -> Option<String> {
        if self
            .issues
            .iter()
            .any(|issue| issue.code == "update-required")
        {
            return Some("Update with openclaw update, then openclaw node restart.".into());
        }
        if self.status != "available" {
            return Some("Device is unavailable".into());
        }
        if self.session_host != Some(true) {
            return Some(
                "Enable session hosting with openclaw connect --service --session-host".into(),
            );
        }
        if requires_node_command {
            let Some(command) = &self.required_node_command else {
                return Some("Session placement is not ready".into());
            };
            match command.state.as_str() {
                "invocable" => {}
                "pending-approval" => {
                    return Some(format!("{} is waiting for approval", command.command));
                }
                "undeclared" => {
                    return Some(format!("Device does not support {}", command.command));
                }
                _ => return Some(format!("{} is not authorized", command.command)),
            }
        }
        if consumes_worker_slot {
            return match &self.worker_slots {
                None => Some("Device capacity is unavailable".into()),
                Some(slots) if slots.total == 0 || slots.available > slots.total => {
                    Some("Device capacity is unavailable".into())
                }
                Some(slots) if slots.available == 0 => Some("Device has no available slots".into()),
                Some(_) => None,
            };
        }
        None
    }
}

impl CloudProfile {
    pub fn default_destination(&self) -> Destination {
        let os = self
            .operating_systems
            .iter()
            .find(|os| os.default)
            .or_else(|| self.operating_systems.first())
            .map(|os| os.id.clone())
            .or_else(|| self.machines.iter().find_map(|machine| machine.os.clone()))
            .unwrap_or_default();
        let machines = || {
            self.machines.iter().filter(|machine| {
                machine
                    .os
                    .as_deref()
                    .is_none_or(|candidate| candidate == os)
            })
        };
        let machine_class = machines()
            .find(|machine| machine.default)
            .or_else(|| machines().next())
            .map(|machine| machine.id.clone())
            .unwrap_or_default();
        Destination::Cloud {
            profile_id: self.id.clone(),
            os,
            machine_class,
        }
    }
}

fn optional(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn option_text(value: &Option<String>) -> Option<String> {
    value.as_deref().and_then(optional)
}

fn truncate_utf16(value: &str, limit: usize) -> String {
    let mut units = 0;
    value
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= limit
        })
        .collect()
}

fn normalize_agent_id(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if !normalized.is_empty()
        && normalized.len() <= 64
        && normalized.as_bytes()[0].is_ascii_alphanumeric()
        && normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return normalized;
    }
    let mut id = String::new();
    let mut invalid = false;
    for character in normalized.chars() {
        if character.is_ascii_lowercase()
            || character.is_ascii_digit()
            || matches!(character, '_' | '-')
        {
            if invalid {
                id.push('-');
                invalid = false;
            }
            id.push(character);
        } else {
            invalid = true;
        }
    }
    let id: String = id.trim_matches('-').chars().take(64).collect();
    if id.is_empty() { "main".into() } else { id }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::attachments::AttachmentOrigin;
    use serde_json::json;

    fn attachment() -> AttachmentPayload {
        AttachmentPayload {
            kind: "file",
            mime_type: "text/plain".into(),
            file_name: "note.txt".into(),
            origin: AttachmentOrigin::File,
            content: "aGk=".into(),
        }
    }

    #[test]
    fn local_create_preserves_initial_turn_and_selected_controls() {
        let draft = DraftSession {
            agent_id: "Main".into(),
            folder: "/workspace".into(),
            workspace: "/workspace".into(),
            permission_mode: Some("workspace".into()),
            category: Some(" Project A ".into()),
            tool_overrides: Some(json!({"webSearch": false})),
            ..Default::default()
        };
        let params = serde_json::to_value(
            draft
                .create_params("  Keep bytes  ", vec![attachment()], &json!({"model":" openai/gpt-5.5@work ","agentRuntime":"codex","thinkingLevel":" high ","fastMode":false,"contextWindow":"1m"}))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            params,
            json!({
                "agentId":"main", "message":"  Keep bytes  ",
                "attachments":[{"type":"file","mimeType":"text/plain","fileName":"note.txt","origin":"file","content":"aGk="}],
                "model":"openai/gpt-5.5@work","agentRuntime":"codex","thinkingLevel":"high","fastMode":false,"contextWindow":"1m",
                "permissionMode":"workspace","category":"Project A","toolOverrides":{"webSearch":false}
            })
        );
    }

    #[test]
    fn all_remote_destinations_defer_initial_turn_and_flatten_dispatch() {
        let destinations = [
            (
                Destination::Device {
                    device_id: "device-1".into(),
                },
                json!({"deviceId":"device-1"}),
            ),
            (Destination::AutomaticDevice, json!({"autoDevice":true})),
            (
                Destination::Cloud {
                    profile_id: "cloud-1".into(),
                    os: "linux".into(),
                    machine_class: "large".into(),
                },
                json!({"profileId":"cloud-1","os":"linux","machineClass":"large"}),
            ),
        ];
        for (destination, fields) in destinations {
            let mut draft = DraftSession::default();
            draft.select_destination(destination);
            let params = serde_json::to_value(
                draft
                    .create_params("  first turn  ", vec![attachment()], &json!({}))
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(
                params,
                json!({"agentId":"main","message":"","titleSource":"first turn","worktree":true,"worktreeSource":"empty"})
            );
            let dispatch = serde_json::to_value(
                draft
                    .destination
                    .dispatch_params("session-1", "Main")
                    .unwrap(),
            )
            .unwrap();
            let mut expected = fields;
            expected["key"] = json!("session-1");
            expected["agentId"] = json!("main");
            assert_eq!(dispatch, expected);
        }
        assert!(
            Destination::Local
                .dispatch_params("session-1", "main")
                .is_none()
        );
    }

    #[test]
    fn worktree_wire_uses_base_ref_and_unprefixed_validated_name() {
        let mut draft = DraftSession {
            project_id: "project-1".into(),
            folder: "/private/project".into(),
            workspace: "/workspace".into(),
            worktree: true,
            worktree_name: " bug-fix ".into(),
            base_ref: " origin/main ".into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(draft.create_params("Fix", vec![], &json!({})).unwrap()).unwrap(),
            json!({
                "agentId":"main","message":"Fix","projectId":"project-1","worktree":true,
                "worktreeBaseRef":"origin/main","worktreeName":"bug-fix"
            })
        );
        assert_eq!(
            worktree_branch_name(&draft.worktree_name).as_deref(),
            Some("openclaw/bug-fix")
        );
        for invalid in [
            "Upper",
            "-leading",
            "has/slash",
            "has space",
            "under_score",
            "é",
            &"a".repeat(65),
        ] {
            draft.worktree_name = invalid.into();
            assert!(
                draft.create_params("Fix", vec![], &json!({})).is_err(),
                "{invalid}"
            );
        }
        for valid in ["", "   ", "a", "0-", &"a".repeat(64)] {
            draft.worktree_name = valid.into();
            assert!(
                draft.create_params("Fix", vec![], &json!({})).is_ok(),
                "{valid}"
            );
        }
    }

    #[test]
    fn remote_repository_and_fresh_workspace_retire_previous_checkout_fields() {
        let mut draft = DraftSession {
            destination: Destination::AutomaticDevice,
            fresh_workspace: false,
            project_git_url: "https://example.com/repo.git".into(),
            project_id: "old-project".into(),
            folder: "/old/checkout".into(),
            base_ref: "release".into(),
            worktree_name: "ignored-name".into(),
            worktree: true,
            ..Default::default()
        };
        let message = format!("{}🦞 more", "x".repeat(999));
        assert_eq!(
            serde_json::to_value(draft.create_params(&message, vec![], &json!({})).unwrap())
                .unwrap(),
            json!({
                "agentId":"main","message":"","titleSource":"x".repeat(999),
                "repository":{"url":"https://example.com/repo.git","ref":"release"}
            })
        );
        draft.fresh_workspace = true;
        draft.visibility = Visibility::Incognito;
        assert_eq!(
            serde_json::to_value(
                draft
                    .create_params("Private topic", vec![], &json!({}))
                    .unwrap()
            )
            .unwrap(),
            json!({
                "agentId":"main","message":"","incognito":true,"worktree":true,"worktreeSource":"empty"
            })
        );
    }

    #[test]
    fn catalog_owns_model_controls_and_local_remote_projects_need_an_initial_turn() {
        let mut draft = DraftSession {
            catalog_id: Some("terminal".into()),
            project_git_url: "https://example.com/repo.git".into(),
            ..Default::default()
        };
        assert_eq!(
            serde_json::to_value(draft.create_params("", vec![], &json!({"model":"openai/gpt-5.5@work","agentRuntime":"codex","thinkingLevel":"high","fastMode":true,"contextWindow":"200k"})).unwrap()).unwrap(),
            json!({"agentId":"main","message":"","catalogId":"terminal"})
        );
        draft.visibility = Visibility::Draft;
        let params = serde_json::to_value(draft.create_params("Clone", vec![], &json!({"model":"openai/gpt-5.5@work","agentRuntime":"codex","thinkingLevel":"high","fastMode":true,"contextWindow":"200k"})).unwrap()).unwrap();
        assert_eq!(
            params,
            json!({"agentId":"main","message":"Clone","catalogId":"terminal","visibility":"draft","projectGitUrl":"https://example.com/repo.git"})
        );
    }
}
