//! Draft admission consumes the same model catalog snapshot as the composer picker.
use super::{
    composer_capabilities::{draft_visibility_available, has_operator_scope, method_available},
    new_session::{Destination, DraftSession, Visibility, is_worktree_name_valid},
};
use crate::gateway::{
    composer_rpc::{AgentRuntime, ModelChoice, ModelSelectionPolicy},
    new_session_rpc::{BranchesResult, CloudProfile, Environment, EnvironmentsResult, Project},
    sessions_rpc::Agent,
};
use serde_json::Value;

pub struct DraftModel<'a> {
    pub draft: &'a DraftSession,
    pub agent: Option<&'a Agent>,
    pub models: &'a [ModelChoice],
    pub policy: Option<&'a ModelSelectionPolicy>,
}

struct RuntimeEntry<'a> {
    available: Option<bool>,
    unavailable_reason: Option<&'a str>,
    runtime: Option<&'a AgentRuntime>,
}

impl<'a> DraftModel<'a> {
    fn entry(&self, model: &str, runtime_id: Option<&str>) -> Option<RuntimeEntry<'a>> {
        let model = model.trim();
        let entry = self
            .models
            .iter()
            .find(|entry| entry.reference().eq_ignore_ascii_case(model))
            .or_else(|| {
                // Unqualified defaults resolve only when the catalog has one matching model.
                let mut matches = self
                    .models
                    .iter()
                    .filter(|entry| entry.id.eq_ignore_ascii_case(model));
                let candidate = matches.next()?;
                matches.next().is_none().then_some(candidate)
            })?;
        let runtime_id = runtime_id.filter(|id| !id.is_empty());
        if runtime_id.is_none()
            || entry
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str())
                == runtime_id
        {
            return Some(RuntimeEntry {
                available: entry.available,
                unavailable_reason: entry.unavailable_reason.as_deref(),
                runtime: entry.agent_runtime.as_ref(),
            });
        }
        // A choice owns its complete runtime capabilities; omissions cannot inherit its sibling.
        let choice = entry.runtime_choices.iter().find(|choice| {
            choice
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str())
                == runtime_id
        })?;
        Some(RuntimeEntry {
            available: choice.available,
            unavailable_reason: choice.unavailable_reason.as_deref(),
            runtime: choice.agent_runtime.as_ref(),
        })
    }

    fn restricted(&self) -> bool {
        self.policy.is_some_and(|policy| policy.restricted)
    }

    fn explicit_model(&self) -> Option<&str> {
        self.draft
            .model
            .as_deref()
            .filter(|model| !model.trim().is_empty())
    }

    fn default_model(&self) -> Option<&str> {
        if self.restricted() {
            self.policy
                .and_then(|policy| policy.default_model.as_deref())
        } else {
            self.agent
                .and_then(|agent| agent.model.as_ref())
                .and_then(|model| model["primary"].as_str())
        }
    }

    pub fn runtime(&self) -> Option<&'a AgentRuntime> {
        let explicit = self.explicit_model().or(if self.restricted() {
            self.default_model()
        } else {
            None
        });
        let runtime = if let Some(model) = explicit {
            self.entry(model, self.draft.agent_runtime.as_deref())?
                .runtime
        } else if !self.restricted() {
            self.default_model()
                .and_then(|model| self.entry(model, None))
                .and_then(|entry| entry.runtime)
                .or_else(|| self.agent.and_then(|agent| agent.agent_runtime.as_ref()))
        } else {
            None
        }?;
        let id = runtime.id.trim();
        (!id.is_empty() && !matches!(id, "auto" | "default")).then_some(runtime)
    }

    fn blocked_reason(&self, loading: bool) -> Option<String> {
        let explicit = self.explicit_model();
        if (explicit.is_some() || self.draft.agent_runtime.is_some()) && loading {
            return Some("Loading models…".into());
        }
        if self.restricted() && explicit.is_none() && self.default_model().is_none_or(str::is_empty)
        {
            return Some(
                if self.models.is_empty() {
                    "No permitted models are available."
                } else {
                    "Select a model to start this chat."
                }
                .into(),
            );
        }
        let entry = explicit
            .or_else(|| self.default_model())
            .and_then(|model| self.entry(model, self.draft.agent_runtime.as_deref()));
        if self.draft.agent_runtime.is_some() && entry.is_none() {
            return Some("The selected model runtime is unavailable.".into());
        }
        if let Some(entry) = entry
            && (self.draft.agent_runtime.is_some() || entry.available == Some(false))
        {
            return match entry.unavailable_reason {
                Some("missing-auth") => Some("Connect an account for the selected model.".into()),
                Some("auth-failed") => {
                    Some("Model authentication failed. Reconnect its account.".into())
                }
                Some("unsupported-runtime") => {
                    Some("The selected model runtime is unavailable.".into())
                }
                _ => None,
            };
        }
        None
    }

    pub fn device_reason(&self, environment: &Environment) -> Option<String> {
        let runtime = self.runtime();
        let requirement = runtime.and_then(|runtime| runtime.device_placement.as_ref());
        if runtime.is_some() && requirement.is_none() {
            return Some("This runtime does not support paired devices".into());
        }
        environment.device_disabled_reason(
            requirement.is_some_and(|requirement| !requirement.required_node_commands.is_empty()),
            requirement.is_none_or(|requirement| requirement.consumes_worker_slot),
        )
    }

    pub fn cloud_reason(&self, profile: &CloudProfile) -> Option<String> {
        let runtime = self.runtime()?;
        let id = runtime.id.trim();
        if runtime.cloud_placement_supported == Some(false) {
            return Some(format!("The {id} runtime does not support cloud workers."));
        }
        runtime.cloud_placement_execution_mode.as_ref()
            .filter(|mode| !profile.execution_modes.contains(mode))
            .map(|_| format!("The {id} runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally."))
    }
}

pub struct DraftAdmission<'a> {
    pub model: DraftModel<'a>,
    pub hello: Option<&'a Value>,
    pub submitting: bool,
    pub submitted: bool,
    pub group_pending: bool,
    pub group_failed: bool,
    pub attachment_reads: usize,
    pub models_loading: bool,
    pub destinations_loading: bool,
    pub destinations_ready: bool,
    pub environments: &'a EnvironmentsResult,
    pub projects: &'a [Project],
    pub branches: &'a BranchesResult,
    pub branches_loading: bool,
    pub message: &'a str,
    pub has_attachments: bool,
}

impl DraftAdmission<'_> {
    pub fn blocked_reason(&self) -> Option<String> {
        let draft = self.model.draft;
        if self.submitting {
            return Some("Starting chat…".into());
        }
        let Some(hello) = self.hello else {
            return Some("Reconnect before starting this chat.".into());
        };
        // The submission owner validates its frozen request and recovery scope.
        if self.submitted {
            return None;
        }
        if self.group_pending {
            return Some("Loading group defaults…".into());
        }
        if self.group_failed {
            return Some("Group defaults could not be loaded. Retry, or use New chat to start without this group.".into());
        }
        if self.attachment_reads > 0 {
            return Some("Reading attachment…".into());
        }
        if !method_available(hello, "sessions.create") {
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
        if !has_operator_scope(hello, required_scope) {
            return Some(format!("This action requires {required_scope}."));
        }
        if draft.visibility == Visibility::Draft && !draft_visibility_available(hello) {
            return Some("This Gateway does not offer private drafts.".into());
        }
        if self.model.agent.is_none() {
            return Some("The selected agent is unavailable. Select an available agent.".into());
        }
        if !draft.project_id.is_empty()
            && !self
                .projects
                .iter()
                .any(|project| project.id == draft.project_id)
        {
            return Some(
                "The selected project is unavailable. Choose an available project.".into(),
            );
        }
        if let Some(reason) = self.model.blocked_reason(self.models_loading) {
            return Some(reason);
        }
        if draft.destination.is_remote() {
            if self.destinations_loading
                || self.models_loading
                || !self.destinations_ready
                || hello["auth"]["recoveryScope"]
                    .as_str()
                    .is_none_or(str::is_empty)
            {
                return Some("The selected runner isn't ready yet. Try again in a moment.".into());
            }
            if !method_available(hello, "sessions.dispatch")
                || !method_available(hello, "sessions.send")
            {
                return Some("This Gateway does not support remote session placement.".into());
            }
            let scope = if matches!(draft.destination, Destination::Cloud { .. }) {
                "operator.admin"
            } else {
                "operator.write"
            };
            if !has_operator_scope(hello, scope) {
                return Some(format!("This destination requires {scope}."));
            }
        }
        match &draft.destination {
            Destination::Local => {}
            Destination::Device { device_id } => {
                let Some(environment) = self
                    .environments
                    .environments
                    .iter()
                    .find(|environment| environment.device_id() == Some(device_id.as_str()))
                else {
                    return Some("The selected device is unavailable.".into());
                };
                if let Some(reason) = self.model.device_reason(environment) {
                    return Some(reason);
                }
            }
            Destination::AutomaticDevice => {
                let mut reasons = self
                    .environments
                    .environments
                    .iter()
                    .filter(|environment| environment.device_id().is_some())
                    .map(|environment| self.model.device_reason(environment));
                let first = reasons.next();
                if first.as_ref().is_none_or(Option::is_some)
                    && reasons.all(|reason| reason.is_some())
                {
                    return Some(
                        first
                            .flatten()
                            .unwrap_or_else(|| "No devices are hosting sessions.".into()),
                    );
                }
            }
            Destination::Cloud {
                profile_id,
                os,
                machine_class,
            } => {
                let Some(profile) = self
                    .environments
                    .profiles
                    .iter()
                    .find(|profile| &profile.id == profile_id)
                else {
                    return Some("The selected cloud worker is unavailable.".into());
                };
                if let Some(reason) = self.model.cloud_reason(profile) {
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
            if self.branches_loading {
                return Some("Checking Git checkout…".into());
            }
            if self.branches.repository_status.as_deref() != Some("git") {
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
        if self.message.trim().is_empty() && !self.has_attachments {
            return Some("Write a message or attach a file to start.".into());
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::composer_rpc::ModelsResult;
    use serde_json::json;

    struct Fixture {
        draft: DraftSession,
        agent: Agent,
        catalog: ModelsResult,
        hello: Value,
        environments: EnvironmentsResult,
        branches: BranchesResult,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                draft: DraftSession::default(),
                agent: serde_json::from_value(json!({
                    "id":"main", "model":{"primary":"example/shared"},
                    "agentRuntime":{"id":"agent-default"}
                })).unwrap(),
                catalog: serde_json::from_value(json!({"models":[{
                    "id":"shared", "provider":"example", "available":true,
                    "agentRuntime":{"id":"catalog-default", "cloudPlacementSupported":false,
                        "devicePlacement":{"requiredNodeCommands":[],"consumesWorkerSlot":true}},
                    "runtimeChoices":[
                        {"agentRuntime":{"id":"remote", "cloudPlacementExecutionMode":"remote-exec",
                            "devicePlacement":{"requiredNodeCommands":["runtime.exec"],"consumesWorkerSlot":false}}},
                        {"agentRuntime":{"id":"local-only"}},
                        {"available":false,"unavailableReason":"missing-auth","agentRuntime":{"id":"needs-account"}}
                    ]
                }]})).unwrap(),
                hello: json!({
                    "auth":{"role":"operator","scopes":["operator.admin"],"recoveryScope":"test-scope"},
                    "features":{"methods":["sessions.create","sessions.dispatch","sessions.send"]}
                }),
                environments: serde_json::from_value(json!({
                    "environments":[{"id":"node:device-1","type":"node","status":"available","sessionHost":true,
                        "workerSlots":{"total":1,"available":0},"requiredNodeCommand":{"command":"runtime.exec","state":"invocable"}}],
                    "profiles":[{"id":"cloud-1","providerId":"example","executionModes":["remote-exec"]}]
                })).unwrap(),
                branches: BranchesResult::default(),
            }
        }

        fn admission(&self) -> DraftAdmission<'_> {
            DraftAdmission {
                model: DraftModel {
                    draft: &self.draft,
                    agent: Some(&self.agent),
                    models: &self.catalog.models,
                    policy: self.catalog.model_selection_policy.as_ref(),
                },
                hello: Some(&self.hello),
                submitting: false,
                submitted: false,
                group_pending: false,
                group_failed: false,
                attachment_reads: 0,
                models_loading: false,
                destinations_loading: false,
                destinations_ready: true,
                environments: &self.environments,
                projects: &[],
                branches: &self.branches,
                branches_loading: false,
                message: "Start work",
                has_attachments: false,
            }
        }
    }

    #[test]
    fn catalog_runtime_provenance_controls_placement_without_borrowing_agent_defaults() {
        let mut fixture = Fixture::new();
        assert_eq!(
            fixture.admission().model.runtime().unwrap().id,
            "catalog-default"
        );
        fixture.draft.model = Some("unknown/model".into());
        assert!(fixture.admission().model.runtime().is_none());
        fixture.draft.model = None;
        fixture.agent.model = Some(json!({"primary":"missing"}));
        assert_eq!(
            fixture.admission().model.runtime().unwrap().id,
            "agent-default"
        );
        fixture.agent.model = Some(json!({"primary":"shared"}));
        let mut duplicate = fixture.catalog.models[0].clone();
        duplicate.provider = "another-provider".into();
        fixture.catalog.models.push(duplicate);
        assert_eq!(
            fixture.admission().model.runtime().unwrap().id,
            "agent-default"
        );
        fixture.catalog.model_selection_policy = Some(ModelSelectionPolicy {
            restricted: true,
            default_model: Some("EXAMPLE/SHARED".into()),
        });
        assert_eq!(
            fixture.admission().model.runtime().unwrap().id,
            "catalog-default"
        );
        fixture
            .catalog
            .model_selection_policy
            .as_mut()
            .unwrap()
            .default_model = None;
        assert!(fixture.admission().model.runtime().is_none());
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("Select a model to start this chat.")
        );
        fixture.catalog.models.clear();
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("No permitted models are available.")
        );
    }

    #[test]
    fn selected_runtime_owns_device_requirements_cloud_support_and_authentication() {
        let mut fixture = Fixture::new();
        fixture.draft.model = Some("example/shared".into());
        fixture.draft.select_destination(Destination::Device {
            device_id: "device-1".into(),
        });
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("Device has no available slots")
        );
        fixture.draft.agent_runtime = Some("remote".into());
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture.environments.environments[0]
            .required_node_command
            .as_mut()
            .unwrap()
            .state = "pending-approval".into();
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("runtime.exec is waiting for approval")
        );
        fixture.draft.agent_runtime = Some("local-only".into());
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("This runtime does not support paired devices")
        );
        fixture
            .draft
            .select_destination(fixture.environments.profiles[0].default_destination());
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture.draft.agent_runtime = None;
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("The catalog-default runtime does not support cloud workers.")
        );
        fixture.draft.agent_runtime = Some("remote".into());
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture.environments.profiles[0].execution_modes.clear();
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some(
                "The remote runtime cannot use this cloud worker. Choose a compatible cloud worker or run locally."
            )
        );
        fixture.draft.select_destination(Destination::Local);
        fixture.draft.agent_runtime = Some("needs-account".into());
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("Connect an account for the selected model.")
        );
        fixture.draft.agent_runtime = Some("retired-runtime".into());
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("The selected model runtime is unavailable.")
        );
    }

    #[test]
    fn remote_admission_requires_ready_scope_and_authority_and_auto_device_accepts_any_eligible_host()
     {
        let mut fixture = Fixture::new();
        fixture.draft.model = Some("example/shared".into());
        fixture.draft.agent_runtime = Some("remote".into());
        fixture
            .draft
            .select_destination(Destination::AutomaticDevice);
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture.hello["auth"]["role"] = json!("node");
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("This action requires operator.sessions.write.")
        );
        fixture.hello["auth"]
            .as_object_mut()
            .unwrap()
            .remove("role");
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture.environments.environments[0].status = "offline".into();
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("Device is unavailable")
        );
        let mut eligible = fixture.environments.environments[0].clone();
        eligible.id = "node:device-2".into();
        eligible.status = "available".into();
        fixture.environments.environments.push(eligible);
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture.hello["auth"]["scopes"] = json!(["operator.sessions.write"]);
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("This destination requires operator.write.")
        );
        fixture.draft.select_destination(Destination::Local);
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture
            .draft
            .select_destination(Destination::AutomaticDevice);
        fixture.hello["auth"]["scopes"] = json!(["operator.write"]);
        assert_eq!(fixture.admission().blocked_reason(), None);
        fixture.hello["auth"]["recoveryScope"] = Value::Null;
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("The selected runner isn't ready yet. Try again in a moment.")
        );
        fixture.hello["auth"]["recoveryScope"] = json!("test-scope");
        fixture.hello["features"]["methods"] = json!(["sessions.create", "sessions.dispatch"]);
        assert_eq!(
            fixture.admission().blocked_reason().as_deref(),
            Some("This Gateway does not support remote session placement.")
        );
    }
}
