use super::AppView;
use crate::{
    gateway::{
        composer_rpc::AgentRuntime,
        new_session_rpc::{CloudProfile, Environment},
    },
    model::new_session_admission::{DraftAdmission, DraftModel},
};

impl AppView {
    fn draft_model<'a>(&'a self, settings: &'a serde_json::Value) -> DraftModel<'a> {
        DraftModel {
            draft: &self.new_session.draft,
            settings,
            agent: self
                .sidebar_state
                .agents
                .iter()
                .find(|agent| agent.id == self.new_session.draft.agent_id),
            models: &self.model_controls.catalog.models,
            policy: self.model_controls.catalog.model_selection_policy.as_ref(),
        }
    }

    pub(super) fn draft_runtime(&self) -> Option<AgentRuntime> {
        let settings = self.model_controls_draft_patch(&self.new_session.model_target());
        self.draft_model(&settings).runtime()
    }

    pub(super) fn draft_device_reason(&self, environment: &Environment) -> Option<String> {
        let settings = self.model_controls_draft_patch(&self.new_session.model_target());
        self.draft_model(&settings).device_reason(environment)
    }

    pub(super) fn draft_cloud_reason(&self, profile: &CloudProfile) -> Option<String> {
        let settings = self.model_controls_draft_patch(&self.new_session.model_target());
        self.draft_model(&settings).cloud_reason(profile)
    }

    pub(super) fn draft_submit_block(&self) -> Option<String> {
        let state = &self.new_session;
        let settings = self.model_controls_draft_patch(&state.model_target());
        DraftAdmission {
            model: self.draft_model(&settings),
            hello: self.session.as_ref().map(|session| session.hello()),
            submitting: state.submitting,
            submitted: state.submitted.is_some(),
            group_pending: state.group_pending,
            group_failed: state.group_failed,
            attachment_reads: self.composer_state.reading,
            models_loading: self.model_controls.loading,
            models_has_snapshot: self.model_controls.has_snapshot,
            models_error: self.model_controls.error.as_deref(),
            destinations_loading: state.catalog_loading,
            destinations_ready: state.environment_scope.is_some(),
            environments: &state.environments,
            projects: &state.projects,
            branches: &state.branches,
            branches_loading: state.branches_loading,
            message: &state.message,
            has_attachments: !state.attachments.is_empty(),
        }
        .blocked_reason()
    }
}
