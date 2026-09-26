use super::AppView;
use crate::{
    gateway::{
        composer_rpc::AgentRuntime,
        new_session_rpc::{CloudProfile, Environment},
    },
    model::new_session_admission::{DraftAdmission, DraftModel},
};

impl AppView {
    fn draft_model(&self) -> DraftModel<'_> {
        DraftModel {
            draft: &self.new_session.draft,
            agent: self
                .sidebar_state
                .agents
                .iter()
                .find(|agent| agent.id == self.new_session.draft.agent_id),
            models: &self.composer_state.models,
            policy: self.composer_state.model_selection_policy.as_ref(),
        }
    }

    pub(super) fn draft_runtime(&self) -> Option<&AgentRuntime> {
        self.draft_model().runtime()
    }

    pub(super) fn draft_device_reason(&self, environment: &Environment) -> Option<String> {
        self.draft_model().device_reason(environment)
    }

    pub(super) fn draft_cloud_reason(&self, profile: &CloudProfile) -> Option<String> {
        self.draft_model().cloud_reason(profile)
    }

    pub(super) fn draft_submit_block(&self) -> Option<String> {
        let state = &self.new_session;
        DraftAdmission {
            model: self.draft_model(),
            hello: self.session.as_ref().map(|session| session.hello()),
            submitting: state.submitting,
            submitted: state.submitted.is_some(),
            group_pending: state.group_pending,
            group_failed: state.group_failed,
            attachment_reads: self.composer_state.reading,
            models_loading: self.composer_state.catalogs_loading,
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
