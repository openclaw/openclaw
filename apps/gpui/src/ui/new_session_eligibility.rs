use super::AppView;
use crate::{
    gateway::new_session_rpc::{CloudProfile, Environment},
    model::new_session::{Destination, Visibility, is_worktree_name_valid},
};
use serde_json::Value;

impl AppView {
    pub(super) fn draft_runtime(&self) -> Option<&Value> {
        let draft = &self.new_session.draft;
        let policy = self.new_session.model_policy.as_ref();
        let restricted = policy.is_some_and(|policy| policy["restricted"] == true);
        let explicit = draft
            .model
            .as_deref()
            .filter(|model| !model.trim().is_empty());
        let policy_model = policy.and_then(|policy| policy["defaultModel"].as_str());
        let runtime = if let Some(model) = explicit.or(if restricted { policy_model } else { None })
        {
            self.draft_model_entry(model, draft.agent_runtime.as_deref())?
                .get("agentRuntime")
        } else if !restricted {
            let agent = self
                .sidebar_state
                .agents
                .iter()
                .find(|agent| agent.id == draft.agent_id)?;
            agent
                .model
                .as_ref()
                .and_then(|model| model["primary"].as_str())
                .and_then(|model| self.draft_model_entry(model, None))
                .and_then(|entry| entry.get("agentRuntime"))
                .filter(|runtime| !runtime.is_null())
                .or(agent.agent_runtime.as_ref())
        } else {
            None
        }?;
        let id = runtime["id"].as_str()?.trim();
        (!id.is_empty() && !matches!(id, "auto" | "default")).then_some(runtime)
    }

    fn draft_model_entry(&self, model: &str, runtime_id: Option<&str>) -> Option<&Value> {
        let model = model.trim().to_lowercase();
        let entry = self.new_session.model_metadata.get(&model).or_else(|| {
            // An unqualified server default resolves only when the catalog owns
            // a unique matching model, just like the web model-ref resolver.
            let mut matches = self.new_session.model_metadata.values().filter(|entry| {
                entry["id"]
                    .as_str()
                    .is_some_and(|id| id.eq_ignore_ascii_case(&model))
            });
            let candidate = matches.next()?;
            matches.next().is_none().then_some(candidate)
        })?;
        let Some(runtime_id) = runtime_id.filter(|id| !id.is_empty()) else {
            return Some(entry);
        };
        if entry["agentRuntime"]["id"].as_str() == Some(runtime_id) {
            return Some(entry);
        }
        // A runtime choice is complete metadata, never an overlay on its sibling.
        entry["runtimeChoices"]
            .as_array()?
            .iter()
            .find(|choice| choice["agentRuntime"]["id"].as_str() == Some(runtime_id))
    }

    pub(super) fn draft_device_reason(&self, environment: &Environment) -> Option<String> {
        let runtime = self.draft_runtime();
        let requirement = runtime
            .and_then(|runtime| runtime.get("devicePlacement"))
            .filter(|value| value.is_object());
        if runtime.is_some() && requirement.is_none() {
            return Some("This runtime does not support paired devices".into());
        }
        let requires_command = requirement
            .and_then(|requirement| requirement["requiredNodeCommands"].as_array())
            .is_some_and(|commands| !commands.is_empty());
        let consumes_slot = requirement
            .and_then(|requirement| requirement["consumesWorkerSlot"].as_bool())
            .unwrap_or(true);
        environment.device_disabled_reason(requires_command, consumes_slot)
    }

    pub(super) fn draft_cloud_reason(&self, profile: &CloudProfile) -> Option<String> {
        let runtime = self.draft_runtime()?;
        let id = runtime["id"].as_str().unwrap_or_default().trim();
        if runtime["cloudPlacementSupported"] == false {
            return Some(format!("The {id} runtime does not support cloud workers."));
        }
        runtime["cloudPlacementExecutionMode"].as_str()
            .filter(|mode| !profile.execution_modes.iter().any(|supported| supported == mode))
            .map(|_| format!("The {id} runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally."))
    }

    pub(super) fn draft_submit_block(&self) -> Option<String> {
        let state = &self.new_session;
        let draft = &state.draft;
        if state.submitting {
            return Some("Starting chat…".into());
        }
        let Some(session) = &self.session else {
            return Some("Reconnect before starting this chat.".into());
        };
        // The submission owner validates its frozen request and recovery scope.
        if state.submitted.is_some() {
            return None;
        }
        if state.group_pending {
            return Some("Loading group defaults…".into());
        }
        if state.group_failed {
            return Some("Group defaults could not be loaded. Retry, or use New chat to start without this group.".into());
        }
        if self.composer_state.reading > 0 {
            return Some("Reading attachment…".into());
        }
        if !self.draft_method("sessions.create") {
            return Some("This Gateway does not support creating chats.".into());
        }
        let required_scope = if draft.visibility == Visibility::Incognito
            || draft.permission_mode.as_deref() == Some("full")
            || draft
                .tool_overrides
                .as_ref()
                .is_some_and(|value| !value.is_null())
        {
            "operator.admin"
        } else {
            "operator.sessions.write"
        };
        if !self.draft_has_scope(required_scope) {
            return Some(format!("This action requires {required_scope}."));
        }
        if draft.visibility == Visibility::Draft {
            let policy = &session.hello()["policy"];
            if policy["hasMultipleSessionSharingIdentities"] != true
                || !policy["allowedSessionVisibilities"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|value| value == "draft"))
            {
                return Some("This Gateway does not offer private drafts.".into());
            }
        }
        let Some(agent) = self
            .sidebar_state
            .agents
            .iter()
            .find(|agent| agent.id == draft.agent_id)
        else {
            return Some("The selected agent is unavailable. Select an available agent.".into());
        };
        if !draft.project_id.is_empty()
            && !state
                .projects
                .iter()
                .any(|project| project.id == draft.project_id)
        {
            return Some(
                "The selected project is unavailable. Choose an available project.".into(),
            );
        }
        let explicit = draft
            .model
            .as_deref()
            .filter(|model| !model.trim().is_empty());
        if (explicit.is_some() || draft.agent_runtime.is_some())
            && self.composer_state.catalogs_loading
        {
            return Some("Loading models…".into());
        }
        let restricted = state
            .model_policy
            .as_ref()
            .is_some_and(|policy| policy["restricted"] == true);
        let policy_model = state
            .model_policy
            .as_ref()
            .and_then(|policy| policy["defaultModel"].as_str());
        if restricted && explicit.is_none() && policy_model.is_none_or(str::is_empty) {
            return Some(
                if state.model_metadata.is_empty() {
                    "No permitted models are available."
                } else {
                    "Select a model to start this chat."
                }
                .into(),
            );
        }
        let selected_model = explicit.or(if restricted {
            policy_model
        } else {
            agent
                .model
                .as_ref()
                .and_then(|model| model["primary"].as_str())
        });
        let model_entry = selected_model
            .and_then(|model| self.draft_model_entry(model, draft.agent_runtime.as_deref()));
        if draft.agent_runtime.is_some() && model_entry.is_none() {
            return Some("The selected model runtime is unavailable.".into());
        }
        if let Some(entry) = model_entry {
            let reason = entry["unavailableReason"].as_str();
            if draft.agent_runtime.is_some() || entry["available"] == false {
                match reason {
                    Some("missing-auth") => {
                        return Some("Connect an account for the selected model.".into());
                    }
                    Some("auth-failed") => {
                        return Some("Model authentication failed. Reconnect its account.".into());
                    }
                    Some("unsupported-runtime") => {
                        return Some("The selected model runtime is unavailable.".into());
                    }
                    _ => {}
                }
            }
        }
        if draft.destination.is_remote() {
            if state.catalog_loading
                || self.composer_state.catalogs_loading
                || state.environment_scope.is_none()
                || session.hello()["auth"]["recoveryScope"]
                    .as_str()
                    .is_none_or(str::is_empty)
            {
                return Some("The selected runner isn't ready yet. Try again in a moment.".into());
            }
            if !self.draft_method("sessions.dispatch") || !self.draft_method("sessions.send") {
                return Some("This Gateway does not support remote session placement.".into());
            }
            let scope = if matches!(draft.destination, Destination::Cloud { .. }) {
                "operator.admin"
            } else {
                "operator.write"
            };
            if !self.draft_has_scope(scope) {
                return Some(format!("This destination requires {scope}."));
            }
        }
        match &draft.destination {
            Destination::Local => {}
            Destination::Device { device_id } => {
                let Some(environment) = state
                    .environments
                    .environments
                    .iter()
                    .find(|environment| environment.device_id() == Some(device_id.as_str()))
                else {
                    return Some("The selected device is unavailable.".into());
                };
                if let Some(reason) = self.draft_device_reason(environment) {
                    return Some(reason);
                }
            }
            Destination::AutomaticDevice => {
                let devices: Vec<_> = state
                    .environments
                    .environments
                    .iter()
                    .filter(|environment| environment.device_id().is_some())
                    .collect();
                if !devices
                    .iter()
                    .any(|device| self.draft_device_reason(device).is_none())
                {
                    return Some(
                        devices
                            .iter()
                            .find_map(|device| self.draft_device_reason(device))
                            .unwrap_or_else(|| "No devices are hosting sessions.".into()),
                    );
                }
            }
            Destination::Cloud {
                profile_id,
                os,
                machine_class,
            } => {
                let Some(profile) = state
                    .environments
                    .profiles
                    .iter()
                    .find(|profile| &profile.id == profile_id)
                else {
                    return Some("The selected cloud worker is unavailable.".into());
                };
                if let Some(reason) = self.draft_cloud_reason(profile) {
                    return Some(reason);
                }
                if !profile.operating_systems.is_empty()
                    && !profile
                        .operating_systems
                        .iter()
                        .any(|candidate| &candidate.id == os)
                {
                    return Some("Select an available operating system.".into());
                }
                if let Some(reason) = profile
                    .operating_systems
                    .iter()
                    .find(|candidate| &candidate.id == os)
                    .and_then(|candidate| candidate.disabled_reason.clone())
                {
                    return Some(reason);
                }
                if !profile.machines.is_empty()
                    && !profile.machines.iter().any(|machine| {
                        &machine.id == machine_class
                            && machine
                                .os
                                .as_deref()
                                .is_none_or(|candidate| candidate == os)
                    })
                {
                    return Some("Select an available machine for this operating system.".into());
                }
            }
        }
        let fresh = draft.destination.is_remote() && draft.fresh_workspace;
        let repository = !draft.project_git_url.trim().is_empty();
        let worktree = draft.worktree || draft.destination.is_remote();
        if worktree && !fresh && !repository {
            if state.branches_loading {
                return Some("Checking Git checkout…".into());
            }
            if state.branches.repository_status.as_deref() != Some("git") {
                return Some(if draft.destination.is_remote() {
                    "This folder cannot provide a Git checkout. Select New workspace to start empty, or choose a repository."
                } else { "Selected folder is not a Git checkout" }.into());
            }
        }
        if worktree
            && !fresh
            && !(draft.destination.is_remote() && repository)
            && !is_worktree_name_valid(&draft.worktree_name)
        {
            return Some(
                "Use 1–64 lowercase letters, numbers, or hyphens for the worktree name.".into(),
            );
        }
        if state.message.trim().is_empty() && state.attachments.is_empty() {
            return Some("Write a message or attach a file to start.".into());
        }
        None
    }

    fn draft_has_scope(&self, requested: &str) -> bool {
        let Some(auth) = self
            .session
            .as_ref()
            .and_then(|session| session.hello().get("auth"))
        else {
            return false;
        };
        if auth["role"].as_str().unwrap_or("operator") != "operator" {
            return false;
        }
        let Some(scopes) = auth["scopes"].as_array() else {
            return false;
        };
        scopes.iter().any(|scope| {
            scope.as_str() == Some(requested)
                || scope == "operator.admin"
                || (requested == "operator.sessions.write" && scope == "operator.write")
        })
    }
}
