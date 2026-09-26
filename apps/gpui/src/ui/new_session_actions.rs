use super::{AppView, new_session::DraftPicker};
use crate::{
    gateway::{composer_rpc::CommandsResult, new_session_rpc::*},
    model::{
        composer_capabilities::{has_operator_scope, method_available},
        new_session::{Destination, DraftSession},
    },
};
use gpui_kit::{component::input::InputState, *};
use serde_json::{Value, json};

impl AppView {
    pub(super) fn open_new_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.session.is_none() {
            return;
        }
        if self.new_session.active {
            if self.new_session.group_failed {
                self.new_session.group_failed = false;
                self.new_session.group_pending = false;
                self.new_session.draft.category = None;
                self.new_session.error = None;
            }
            self.composer
                .update(cx, |input, cx| input.focus(window, cx));
            return;
        }
        self.composer_save_draft(cx);
        self.web.settings_open = false;
        self.web.picker_open = false;
        self.composer_capabilities.reset();
        self.composer_state.close_popups();
        self.model_controls.close_popups();
        self.composer_state.attachment_generation += 1;
        self.composer_state.reading = 0;
        self.composer_state.error = None;
        self.composer_state.recall.reset();
        self.composer_state.restore_pending = false;
        if !self.new_session.initialized && self.new_session.submitted.is_none() {
            self.new_session.initialized = true;
            self.new_session.completed_key = None;
            self.new_session.error = None;
            self.new_session.generation += 1;
            self.new_session.draft_id = uuid::Uuid::new_v4().to_string();
            self.new_session.draft = DraftSession {
                agent_id: self
                    .sidebar_state
                    .selected_agent
                    .clone()
                    .unwrap_or_else(|| "main".into()),
                ..Default::default()
            };
            self.adopt_draft_agent();
        }
        self.new_session.active = true;
        self.sidebar_state.pending_selection = None;
        self.chat
            .select_context(String::new(), Some(self.new_session.draft.agent_id.clone()));
        self.chat.selected_session = None;
        self.sync_subscription(cx);
        self.composer_state
            .set_attachments(self.new_session.attachments.clone());
        let message = self.new_session.message.clone();
        self.composer.update(cx, |input, cx| {
            input.set_placeholder("What should this session work on?", window, cx);
            input.set_value(message, window, cx);
            input.focus(window, cx);
        });
        self.sync_draft_inputs(window, cx);
        self.load_draft_catalogs(cx);
        cx.notify();
    }

    fn adopt_draft_agent(&mut self) {
        let agent = self
            .sidebar_state
            .agents
            .iter()
            .find(|a| a.id == self.new_session.draft.agent_id);
        let workspace = agent.and_then(|a| a.workspace.clone()).unwrap_or_default();
        self.new_session.draft.workspace = workspace.clone();
        self.new_session.draft.folder = workspace;
        self.sync_draft_toolbar();
    }

    pub(super) fn sync_draft_toolbar(&mut self) {
        self.new_session.sync_toolbar();
    }

    pub(super) fn patch_draft_settings(&mut self, fields: &Value, cx: &mut Context<Self>) {
        if self.new_session.locked() {
            return;
        }
        let draft = &mut self.new_session.draft;
        for (name, target) in [("permissionMode", &mut draft.permission_mode)] {
            if let Some(value) = fields.get(name) {
                *target = value.as_str().map(str::to_owned);
            }
        }
        if let Some(value) = fields.get("toolOverrides") {
            draft.tool_overrides = (!value.is_null()).then(|| value.clone());
        }
        self.sync_draft_toolbar();
        cx.notify();
    }

    pub(super) fn sync_draft_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.new_session.inputs_dirty = false;
        for (input, value) in [
            (
                &self.new_session.base_ref_input,
                &self.new_session.draft.base_ref,
            ),
            (
                &self.new_session.worktree_name_input,
                &self.new_session.draft.worktree_name,
            ),
            (
                &self.new_session.folder_input,
                &self.new_session.draft.folder,
            ),
        ] {
            input.update(cx, |input: &mut InputState, cx| {
                input.set_value(value.clone(), window, cx)
            });
        }
    }

    pub(super) fn choose_draft_agent(
        &mut self,
        id: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.new_session.locked() || self.new_session.draft.agent_id == id {
            return;
        }
        self.discard_new_session_model_settings();
        let visibility = self.new_session.draft.visibility;
        self.new_session.draft = DraftSession {
            agent_id: id,
            visibility,
            ..Default::default()
        };
        self.new_session.generation += 1;
        self.new_session.draft_id = uuid::Uuid::new_v4().to_string();
        self.composer_state.attachment_generation += 1;
        self.composer_state.reading = 0;
        self.composer_state.catalog_generation += 1;
        self.composer_capabilities.reset();
        self.new_session.error = None;
        self.new_session.picker = None;
        self.adopt_draft_agent();
        self.chat.selected_agent = Some(self.new_session.draft.agent_id.clone());
        self.sync_draft_inputs(window, cx);
        self.load_draft_catalogs(cx);
    }

    pub(super) fn draft_method(&self, method: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| method_available(session.hello(), method))
    }

    pub(super) fn draft_admin(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| has_operator_scope(session.hello(), "operator.admin"))
    }

    pub(super) fn load_draft_catalogs(&mut self, cx: &mut Context<Self>) {
        self.new_session.discovery_generation += 1;
        let generation = self.new_session.discovery_generation;
        let agent = self.new_session.draft.agent_id.clone();
        self.new_session.environment_scope = None;
        self.set_model_controls_target(self.new_session.model_target(), cx);
        self.load_draft_destinations(cx);
        if self.draft_method("system.info") {
            self.request("system.info", json!({}), cx, move |this, result, _| {
                if this.new_session.discovery_generation != generation {
                    return;
                }
                if let Ok(value) = result {
                    this.new_session.gateway_name = value["machineName"]
                        .as_str()
                        .or_else(|| value["hostname"].as_str())
                        .unwrap_or("")
                        .split('.')
                        .next()
                        .unwrap_or("")
                        .to_owned();
                }
            });
        }
        self.request("projects.list", json!({}), cx, move |this, result, _| {
            if this.new_session.discovery_generation != generation {
                return;
            }
            match result.and_then(decode::<ProjectsResult>) {
                Ok(result) => this.new_session.projects = result.projects,
                Err(error) => {
                    this.new_session.error = Some(format!("Projects unavailable: {error}"))
                }
            }
        });
        if self.draft_method("sessions.groups.defaults") {
            self.request("sessions.groups.defaults", json!({}), cx, move |this, result, cx| {
                if this.new_session.discovery_generation != generation { return; }
                match result.and_then(decode::<GroupDefaultsResult>) {
                    Ok(result) => {
                        this.new_session.groups = result.defaults;
                        if this.new_session.group_pending {
                            if let Some(group)=this.new_session.groups.iter().find(|g|Some(&g.name)==this.new_session.draft.category.as_ref()).cloned() {
                                this.new_session.draft.apply_group_default(&group);
                                this.new_session.inputs_dirty = true;
                            } else {
                                this.new_session.group_failed=true;
                                this.new_session.error=Some("The selected group is unavailable. Choose New chat to start without its defaults.".into());
                            }
                            this.new_session.group_pending=false;
                            this.load_draft_branches(cx);
                        }
                    },
                    Err(error) => {
                        this.new_session.group_failed=this.new_session.group_pending;
                        this.new_session.group_pending=false;
                        this.new_session.error=Some(format!("Group defaults unavailable: {error}. Retry, or use New chat to start without this group."));
                    },
                }
            });
        } else if self.new_session.group_pending {
            self.new_session.group_pending = false;
            self.new_session.group_failed = true;
            self.new_session.error = Some(
                "Group defaults are unavailable. Use New chat to start without this group.".into(),
            );
        }
        self.composer_state.commands.clear();
        self.request(
            "commands.list",
            json!({"agentId":agent,"scope":"text","includeArgs":true}),
            cx,
            move |this, result, _| {
                if this.new_session.discovery_generation != generation || !this.new_session.active {
                    return;
                }
                match result.and_then(decode::<CommandsResult>) {
                    Ok(result) => this.composer_state.commands = result.commands,
                    Err(error) => {
                        this.new_session.error = Some(format!("Commands unavailable: {error}"))
                    }
                }
            },
        );
        self.load_draft_branches(cx);
    }

    pub(super) fn load_draft_destinations(&mut self, cx: &mut Context<Self>) {
        let runtime = self
            .draft_runtime()
            .map(|runtime| runtime.id.trim().to_owned());
        let scope = (
            self.epoch,
            self.new_session.draft.agent_id.clone(),
            runtime.clone(),
        );
        if self.new_session.environment_scope.as_ref() == Some(&scope) {
            return;
        }
        self.new_session.environment_scope = Some(scope.clone());
        self.new_session.environment_generation += 1;
        let generation = self.new_session.environment_generation;
        self.new_session.catalog_loading = true;
        self.request(
            "environments.list",
            runtime.map_or(json!({}), |id| json!({"runtimeId":id})),
            cx,
            move |this, result, _| {
                if this.new_session.environment_generation != generation
                    || this.new_session.environment_scope.as_ref() != Some(&scope)
                {
                    return;
                }
                this.new_session.catalog_loading = false;
                match result.and_then(decode::<EnvironmentsResult>) {
                    Ok(catalog) => this.new_session.environments = catalog,
                    Err(error) => {
                        this.new_session.environment_scope = None;
                        this.new_session.error = Some(format!("Destinations unavailable: {error}"));
                    }
                }
            },
        );
    }

    pub(super) fn choose_draft_destination(
        &mut self,
        destination: Destination,
        cx: &mut Context<Self>,
    ) {
        if self.new_session.locked() {
            return;
        }
        self.new_session.draft.select_destination(destination);
        self.new_session.picker = None;
        self.new_session.error = None;
        self.load_draft_branches(cx);
        cx.notify();
    }

    pub(super) fn new_chat_in_group(
        &mut self,
        group: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.new_session.submitting || self.new_session.submitted.is_some() {
            self.open_new_session(window, cx);
            return;
        }
        self.open_new_session(window, cx);
        self.new_session.draft.category = group.clone();
        self.new_session.group_pending = false;
        self.new_session.group_failed = false;
        if let Some(group) = group {
            if let Some(defaults) = self
                .new_session
                .groups
                .iter()
                .find(|g| g.name == group)
                .cloned()
            {
                self.new_session.draft.apply_group_default(&defaults);
                self.sync_draft_inputs(window, cx);
                self.load_draft_branches(cx);
            } else {
                self.new_session.group_pending = true;
                self.load_draft_catalogs(cx);
            }
        }
        cx.notify();
    }

    pub(super) fn choose_draft_folder(
        &mut self,
        path: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.new_session.locked() {
            return;
        }
        let draft = &mut self.new_session.draft;
        draft.folder = path;
        draft.project_id.clear();
        draft.project_git_url.clear();
        draft.fresh_workspace = false;
        draft.worktree = draft.destination.is_remote();
        draft.base_ref.clear();
        draft.worktree_name.clear();
        self.new_session.error = None;
        self.new_session.picker = None;
        self.sync_draft_inputs(window, cx);
        self.load_draft_branches(cx);
        cx.notify();
    }

    pub(super) fn choose_draft_project(
        &mut self,
        project: Project,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.choose_draft_folder(project.repo_root.clone().unwrap_or_default(), window, cx);
        self.new_session.draft.project_id = project.id;
        self.load_draft_branches(cx);
    }

    pub(super) fn choose_remote_draft_project(&mut self, url: String, cx: &mut Context<Self>) {
        if self.new_session.locked() {
            return;
        }
        let draft = &mut self.new_session.draft;
        draft.project_git_url = url;
        draft.project_id.clear();
        draft.fresh_workspace = false;
        draft.worktree = draft.destination.is_remote();
        draft.base_ref.clear();
        draft.worktree_name.clear();
        self.new_session.picker = None;
        self.load_draft_branches(cx);
        cx.notify();
    }

    pub(super) fn load_draft_branches(&mut self, cx: &mut Context<Self>) {
        self.new_session.repository_generation += 1;
        let generation = self.new_session.repository_generation;
        self.new_session.branches = BranchesResult::default();
        self.new_session.branches_loading = false;
        if !self.new_session.draft.project_git_url.is_empty()
            || (self.new_session.draft.destination.is_remote()
                && self.new_session.draft.fresh_workspace)
        {
            return;
        }
        let root = self
            .new_session
            .projects
            .iter()
            .find(|p| p.id == self.new_session.draft.project_id)
            .and_then(|p| p.repo_root.clone())
            .unwrap_or_else(|| self.new_session.draft.folder.clone());
        if root.is_empty() {
            return;
        }
        self.new_session.branches_loading = true;
        self.request(
            "worktrees.branches",
            json!({"repoRoot":root,"includeRepositoryStatus":true}),
            cx,
            move |this, result, _| {
                if this.new_session.repository_generation != generation {
                    return;
                }
                this.new_session.branches_loading = false;
                match result.and_then(decode::<BranchesResult>) {
                    Ok(result) => this.new_session.branches = result,
                    Err(error) => {
                        this.new_session.error = Some(format!("Git branches unavailable: {error}"))
                    }
                }
            },
        );
    }

    pub(super) fn browse_draft_folder(&mut self, path: Option<String>, cx: &mut Context<Self>) {
        self.new_session.browsing = true;
        self.new_session.directory_generation += 1;
        let generation = self.new_session.directory_generation;
        self.new_session.directory_loading = true;
        self.request(
            "fs.listDir",
            path.filter(|p| !p.is_empty())
                .map_or(json!({}), |path| json!({"path":path})),
            cx,
            move |this, result, _| {
                if this.new_session.directory_generation != generation {
                    return;
                }
                this.new_session.directory_loading = false;
                match result.and_then(decode::<DirectoryResult>) {
                    Ok(listing) => this.new_session.directory = Some(listing),
                    Err(error) => {
                        this.new_session.error = Some(format!("Could not open folder: {error}"))
                    }
                }
            },
        );
    }

    pub(super) fn search_draft_projects(&mut self, cx: &mut Context<Self>) {
        if self.new_session.picker != Some(DraftPicker::Project) {
            return;
        }
        self.new_session.search_generation += 1;
        let generation = self.new_session.search_generation;
        let query = self.new_session.search.read(cx).value().trim().to_owned();
        self.new_session.remote_projects.clear();
        if query.len() < 2 || !self.draft_method("projects.searchRemote") || clone_url(&query) {
            return;
        }
        self.request(
            "projects.searchRemote",
            json!({"query":query}),
            cx,
            move |this, result, _| {
                if this.new_session.search_generation != generation {
                    return;
                }
                match result {
                    Ok(value) => {
                        this.new_session.remote_projects =
                            value["projects"].as_array().cloned().unwrap_or_default()
                    }
                    Err(error) => {
                        this.new_session.error =
                            Some(format!("Project search unavailable: {error}"))
                    }
                }
            },
        );
    }
}

pub(super) fn clone_url(value: &str) -> bool {
    !value.contains(char::is_whitespace)
        && (value.starts_with("https://")
            || value.starts_with("ssh://git@")
            || (value.starts_with("git@") && value.contains(':')))
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, String> {
    serde_json::from_value(value).map_err(|e| e.to_string())
}
