use super::AppView;
use crate::{
    gateway::new_session_rpc::{
        BranchesResult, DirectoryResult, EnvironmentsResult, GroupDefault, Project,
    },
    model::{
        attachments::Attachment, model_controls::ModelControlsTarget, new_session::DraftSession,
        sessions::SessionRow,
    },
};
use gpui_kit::{
    component::input::{InputEvent, InputState},
    *,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum DraftPicker {
    Agent,
    Destination,
    Project,
    Checkout,
}

pub(super) struct NewSessionUi {
    gateway: Option<String>,
    retained: std::collections::HashMap<String, RetainedDraft>,
    pub active: bool,
    pub generation: u64,
    pub discovery_generation: u64,
    pub environment_generation: u64,
    pub environment_scope: Option<(u64, String, Option<String>)>,
    pub directory_generation: u64,
    pub repository_generation: u64,
    pub draft: DraftSession,
    pub draft_id: String,
    pub gateway_name: String,
    pub group_pending: bool,
    pub group_failed: bool,
    pub initialized: bool,
    // The existing model toolbar consumes a row-shaped, in-memory projection.
    // It never enters the roster or carries a real session identity.
    pub toolbar_row: SessionRow,
    pub message: String,
    pub attachments: Vec<Attachment>,
    pub picker: Option<DraftPicker>,
    pub submitting: bool,
    pub error: Option<String>,
    pub submitted: Option<super::new_session_submit::PendingDraftSubmission>,
    pub completed_key: Option<String>,
    pub pending_open: Option<String>,
    pub inputs_dirty: bool,
    pub environments: EnvironmentsResult,
    pub projects: Vec<Project>,
    pub groups: Vec<GroupDefault>,
    pub branches: BranchesResult,
    pub branches_loading: bool,
    pub branch_suggestions: bool,
    pub catalog_loading: bool,
    pub directory_loading: bool,
    pub directory: Option<DirectoryResult>,
    pub browsing: bool,
    pub search: Entity<InputState>,
    pub folder_input: Entity<InputState>,
    pub base_ref_input: Entity<InputState>,
    pub worktree_name_input: Entity<InputState>,
    pub remote_projects: Vec<serde_json::Value>,
    pub search_generation: u64,
    _subscriptions: Vec<Subscription>,
}

#[derive(Default)]
struct RetainedDraft {
    draft: DraftSession,
    draft_id: String,
    message: String,
    attachments: Vec<Attachment>,
    submitted: Option<super::new_session_submit::PendingDraftSubmission>,
    completed_key: Option<String>,
    error: Option<String>,
    initialized: bool,
    group_unresolved: bool,
}

impl NewSessionUi {
    pub fn new(window: &mut Window, cx: &mut Context<AppView>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search…"));
        let folder_input = cx.new(|cx| InputState::new(window, cx).placeholder("Folder path"));
        let base_ref_input = cx.new(|cx| InputState::new(window, cx).placeholder("Default branch"));
        let worktree_name_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Named from the session title"));
        let subscriptions = vec![
            cx.subscribe(&search, |this, _, event, cx| {
                if matches!(event, InputEvent::Change) {
                    this.search_draft_projects(cx);
                }
                cx.notify();
            }),
            cx.subscribe(&folder_input, |this, _, event, cx| {
                if matches!(event, InputEvent::PressEnter { .. }) {
                    let path = this.new_session.folder_input.read(cx).value().to_string();
                    this.browse_draft_folder(Some(path), cx);
                }
            }),
            cx.subscribe(&base_ref_input, |this, _, event, cx| {
                if matches!(event, InputEvent::Focus) {
                    this.new_session.branch_suggestions = true;
                }
                if matches!(event, InputEvent::Blur) {
                    this.new_session.branch_suggestions = false;
                }
                if matches!(event, InputEvent::Change) && !this.new_session.locked() {
                    let value = this.new_session.base_ref_input.read(cx).value().to_string();
                    if value != this.new_session.draft.base_ref
                        && this.new_session.picker == Some(DraftPicker::Checkout)
                    {
                        this.new_session.branch_suggestions = true;
                    }
                    this.new_session.draft.base_ref = value;
                }
                cx.notify();
            }),
            cx.subscribe(&worktree_name_input, |this, _, event, cx| {
                if matches!(event, InputEvent::Change) && !this.new_session.locked() {
                    this.new_session.draft.worktree_name = this
                        .new_session
                        .worktree_name_input
                        .read(cx)
                        .value()
                        .to_string();
                }
                cx.notify();
            }),
        ];
        Self {
            gateway: None,
            retained: Default::default(),
            active: false,
            generation: 0,
            discovery_generation: 0,
            environment_generation: 0,
            environment_scope: None,
            directory_generation: 0,
            repository_generation: 0,
            draft: DraftSession::default(),
            draft_id: String::new(),
            gateway_name: String::new(),
            group_pending: false,
            group_failed: false,
            initialized: false,
            toolbar_row: SessionRow::default(),
            message: String::new(),
            attachments: Vec::new(),
            picker: None,
            submitting: false,
            error: None,
            submitted: None,
            completed_key: None,
            pending_open: None,
            inputs_dirty: false,
            environments: EnvironmentsResult::default(),
            projects: Vec::new(),
            groups: Vec::new(),
            branches: BranchesResult::default(),
            branches_loading: false,
            branch_suggestions: false,
            catalog_loading: false,
            directory_loading: false,
            directory: None,
            browsing: false,
            search,
            folder_input,
            base_ref_input,
            worktree_name_input,
            remote_projects: Vec::new(),
            search_generation: 0,
            _subscriptions: subscriptions,
        }
    }

    pub fn locked(&self) -> bool {
        self.submitting || self.submitted.is_some() || self.group_pending
    }

    pub fn bind_gateway(&mut self, gateway: &str) {
        if self.gateway.as_deref() == Some(gateway) {
            return;
        }
        if let Some(previous) = self.gateway.replace(gateway.to_owned()) {
            self.retained.insert(
                previous,
                RetainedDraft {
                    draft: std::mem::take(&mut self.draft),
                    draft_id: std::mem::take(&mut self.draft_id),
                    message: std::mem::take(&mut self.message),
                    attachments: std::mem::take(&mut self.attachments),
                    submitted: self.submitted.take(),
                    completed_key: self.completed_key.take(),
                    error: self.error.take(),
                    initialized: self.initialized,
                    group_unresolved: self.group_pending || self.group_failed,
                },
            );
        }
        let saved = self.retained.remove(gateway).unwrap_or_default();
        self.draft = saved.draft;
        self.draft_id = saved.draft_id;
        self.message = saved.message;
        self.attachments = saved.attachments;
        self.submitted = saved.submitted;
        self.completed_key = saved.completed_key;
        self.error = saved.error;
        self.initialized = saved.initialized;
        self.pending_open = None;
        self.inputs_dirty = false;
        self.group_pending = false;
        self.group_failed = saved.group_unresolved;
        self.environments = Default::default();
        self.projects.clear();
        self.groups.clear();
        self.directory = None;
        self.sync_toolbar();
    }

    pub fn model_target(&self) -> ModelControlsTarget {
        ModelControlsTarget {
            agent_id: self.draft.agent_id.clone(),
            session_key: None,
            draft_id: Some(self.draft_id.clone()),
        }
    }

    pub fn sync_toolbar(&mut self) {
        self.toolbar_row = SessionRow {
            agent_id: Some(self.draft.agent_id.clone()),
            display_name: Some("New chat".into()),
            permission_mode: self.draft.permission_mode.clone(),
            tool_overrides: self.draft.tool_overrides.clone(),
            ..Default::default()
        };
    }
}
