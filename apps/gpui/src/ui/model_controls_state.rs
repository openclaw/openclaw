mod catalog;

use super::AppView;
use crate::{
    gateway::composer_rpc::{
        ChatAccountSelection, ModelAuthStatusResult, ModelsResult, UserModelAccount,
        UsersListModelAccountsResult,
    },
    model::{
        model_controls::{ModelControlsTarget, split_model_auth_profile},
        model_selection::{
            DraftSelections, default_model_reference, model_patch_access_reason, model_reference,
            project_model_controls_row,
        },
        sessions::SessionRow,
    },
};
use gpui_kit::{
    component::input::{InputEvent, InputState},
    *,
};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

struct PendingSelection {
    session_id: Option<String>,
    patch: Value,
    generation: u64,
    in_flight: bool,
    write_confirmed: bool,
}

pub(super) struct ModelControlsUi {
    pub target: Option<ModelControlsTarget>,
    pub search: Entity<InputState>,
    pub model_open: bool,
    pub effort_open: bool,
    pub effort_preview: Option<usize>,
    pub accounts_open: bool,
    pub highlight: usize,
    pub expanded_providers: HashSet<String>,
    pub menu_focus: FocusHandle,
    pub trigger_focus: FocusHandle,
    pub menu_scroll: ScrollHandle,
    pub effort_focus: FocusHandle,
    pub catalog: ModelsResult,
    pub auth: ModelAuthStatusResult,
    pub defaults: Value,
    pub accounts: Vec<UserModelAccount>,
    pub account_next_cursor: Option<String>,
    pub accounts_loading: bool,
    pub accounts_error: Option<String>,
    pub loading: bool,
    pub has_snapshot: bool,
    pub error: Option<String>,
    pub pending: bool,
    epoch: u64,
    generation: u64,
    mutation_generation: u64,
    account_generation: u64,
    session_snapshot: Option<SessionRow>,
    mutations: HashMap<ModelControlsTarget, PendingSelection>,
    drafts: DraftSelections,
    _subscription: Subscription,
}

impl ModelControlsUi {
    pub fn new(window: &mut Window, cx: &mut Context<AppView>) -> Self {
        // Let the picker and its native buttons own activation, not the ancestor popover toggle.
        cx.bind_keys([
            KeyBinding::new("enter", NoAction, Some("ModelPicker")),
            KeyBinding::new("space", NoAction, Some("ModelPicker")),
        ]);
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search models"));
        let subscription = cx.subscribe(&search, |this, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                this.reset_model_picker_highlight(cx);
            }
            cx.notify();
        });
        Self {
            target: None,
            search,
            model_open: false,
            effort_open: false,
            effort_preview: None,
            accounts_open: false,
            highlight: 0,
            expanded_providers: HashSet::new(),
            menu_focus: cx.focus_handle(),
            trigger_focus: cx.focus_handle(),
            menu_scroll: ScrollHandle::new(),
            effort_focus: cx.focus_handle(),
            catalog: ModelsResult::default(),
            auth: ModelAuthStatusResult::default(),
            defaults: Value::Null,
            accounts: Vec::new(),
            account_next_cursor: None,
            accounts_loading: false,
            accounts_error: None,
            loading: false,
            has_snapshot: false,
            error: None,
            pending: false,
            epoch: 0,
            generation: 0,
            mutation_generation: 0,
            account_generation: 0,
            session_snapshot: None,
            mutations: HashMap::new(),
            drafts: DraftSelections::default(),
            _subscription: subscription,
        }
    }

    pub fn close_popups(&mut self) {
        self.model_open = false;
        self.effort_open = false;
        self.effort_preview = None;
        self.accounts_open = false;
    }

    pub fn reset_connection(&mut self) {
        self.mutations.clear();
        self.reset_target();
    }

    fn reset_target(&mut self) {
        self.target = None;
        self.generation += 1;
        self.account_generation += 1;
        self.pending = false;
        self.loading = false;
        self.has_snapshot = false;
        self.catalog = ModelsResult::default();
        self.auth = ModelAuthStatusResult::default();
        self.defaults = Value::Null;
        self.session_snapshot = None;
        self.accounts.clear();
        self.accounts_loading = false;
        self.account_next_cursor = None;
        self.accounts_error = None;
        self.error = None;
        self.close_popups();
    }
}

impl AppView {
    pub(super) fn set_model_controls_target(
        &mut self,
        target: ModelControlsTarget,
        cx: &mut Context<Self>,
    ) {
        if self.model_controls.target.as_ref() == Some(&target)
            && self.model_controls.epoch == self.epoch
        {
            return;
        }
        if self.model_controls.epoch == self.epoch {
            self.model_controls.reset_target();
        } else {
            self.model_controls.reset_connection();
        }
        self.model_controls.epoch = self.epoch;
        self.model_controls.target = Some(target.clone());
        self.model_controls.highlight = 0;
        self.model_controls.expanded_providers.clear();
        self.sync_model_controls();
        self.load_model_controls(target, cx);
    }

    fn model_controls_saved_row(&self, target: &ModelControlsTarget) -> Option<&SessionRow> {
        let key = target.session_key.as_deref()?;
        let roster = self
            .rows
            .iter()
            .chain(self.sidebar_state.children.values().flatten())
            .chain(self.sidebar_state.search_rows.iter())
            .chain(self.sidebar_state.selected_descriptor.iter())
            .filter(|row| {
                row.key == key
                    && row
                        .agent()
                        .map(|id| id == target.agent_id)
                        .unwrap_or_else(|| {
                            self.sidebar_state.selected_agent.as_deref()
                                == Some(target.agent_id.as_str())
                        })
            });
        let snapshot = self.model_controls.session_snapshot.iter().filter(|row| {
            self.model_controls.target.as_ref() == Some(target)
                && row.key == key
                && row.agent().is_none_or(|id| id == target.agent_id)
        });
        roster.chain(snapshot).max_by(|a, b| {
            a.snapshot_at
                .or(a.updated_at)
                .unwrap_or(0.)
                .total_cmp(&b.snapshot_at.or(b.updated_at).unwrap_or(0.))
        })
    }

    pub(super) fn model_controls_row(&self) -> Option<SessionRow> {
        let target = self.model_controls.target.as_ref()?;
        Some(project_model_controls_row(
            target,
            self.model_controls_saved_row(target),
            self.model_controls.catalog.model_selection_policy.as_ref(),
            &self.model_controls.defaults,
            &self.model_controls_patch(),
        ))
    }

    pub(super) fn model_controls_patch(&self) -> Value {
        let Some(target) = &self.model_controls.target else {
            return json!({});
        };
        if target.session_key.is_none() {
            return self.model_controls_draft_patch(target);
        }
        self.model_controls
            .mutations
            .get(target)
            .filter(|selection| {
                self.model_controls_saved_row(target)
                    .and_then(|row| row.session_id.as_ref())
                    == selection.session_id.as_ref()
            })
            .map(|selection| selection.patch.clone())
            .unwrap_or_else(|| json!({}))
    }

    pub(super) fn model_controls_draft_patch(&self, target: &ModelControlsTarget) -> Value {
        self.composer_state
            .drafts
            .gateway()
            .map(|gateway| self.model_controls.drafts.read(gateway, target))
            .unwrap_or_else(|| json!({}))
    }

    fn apply_draft_model_control_patch(
        &mut self,
        target: ModelControlsTarget,
        patch: Value,
        cx: &mut Context<Self>,
    ) {
        let Some(gateway) = self.composer_state.drafts.gateway().map(str::to_owned) else {
            return;
        };
        let previous = self.model_controls.drafts.read(&gateway, &target);
        let previous_ref = previous.get("model").and_then(Value::as_str).unwrap_or("");
        let previous_account = split_model_auth_profile(previous_ref).1.map(str::to_owned);
        let fields = patch.as_object().expect("validated model patch");
        let model_change = fields.contains_key("model");
        let default_reference = self.model_controls_default_reference();
        let current =
            self.model_controls
                .drafts
                .apply(&gateway, target.clone(), fields, &default_reference);
        let account = current
            .get("model")
            .and_then(Value::as_str)
            .and_then(|model| split_model_auth_profile(model).1)
            .map(str::to_owned);
        if account != previous_account {
            let selected = account.as_ref().and_then(|profile| {
                self.model_controls
                    .accounts
                    .iter()
                    .find(|account| &account.auth_profile_id == profile)
            });
            let selection = selected.map(|account| ChatAccountSelection {
                kind: "personal".into(),
                label: account.label.clone(),
                auth_profile_id: Some(account.auth_profile_id.clone()),
                source: Some("user".into()),
            });
            self.model_controls.catalog = ModelsResult {
                account_selection: selection,
                ..Default::default()
            };
            self.model_controls.has_snapshot = false;
            self.model_controls.accounts.clear();
            self.model_controls.accounts_loading = false;
            self.model_controls.account_next_cursor = None;
            self.model_controls.account_generation += 1;
            self.load_model_controls(target.clone(), cx);
        } else if model_change {
            self.reconcile_draft_model_controls(&target);
        }
        if model_change {
            self.model_controls.close_popups();
        }
        self.refresh_draft_model_destinations(&target, cx);
        cx.notify();
    }

    fn reconcile_draft_model_controls(&mut self, target: &ModelControlsTarget) {
        if !self.model_controls.has_snapshot {
            return;
        }
        let Some(gateway) = self.composer_state.drafts.gateway().map(str::to_owned) else {
            return;
        };
        let default_reference = self.model_controls_default_reference();
        self.model_controls.drafts.reconcile(
            &gateway,
            target,
            &self.model_controls.catalog,
            &self.model_controls.defaults,
            &default_reference,
        );
    }

    pub(super) fn discard_new_session_model_settings(&mut self) {
        let target = self.new_session.model_target();
        if let Some(gateway) = self.composer_state.drafts.gateway() {
            self.model_controls.drafts.remove(gateway, &target);
        }
        if self.model_controls.target.as_ref() == Some(&target) {
            self.model_controls.reset_target();
        }
    }

    fn refresh_draft_model_destinations(
        &mut self,
        target: &ModelControlsTarget,
        cx: &mut Context<Self>,
    ) {
        if self.new_session.active && &self.new_session.model_target() == target {
            self.load_draft_destinations(cx);
        }
    }

    pub(super) fn clear_draft_model_account(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self
            .model_controls
            .target
            .clone()
            .filter(|target| target.session_key.is_none())
        else {
            return;
        };
        let Some(gateway) = self.composer_state.drafts.gateway().map(str::to_owned) else {
            return;
        };
        if !self.model_controls.drafts.clear_account(&gateway, &target) {
            return;
        }
        self.model_controls.catalog = ModelsResult::default();
        self.model_controls.has_snapshot = false;
        self.model_controls.accounts.clear();
        self.model_controls.account_next_cursor = None;
        self.model_controls.account_generation += 1;
        self.model_controls.accounts_loading = false;
        self.load_model_controls(target, cx);
    }

    pub(super) fn model_controls_default_reference(&self) -> String {
        default_model_reference(&self.model_controls.catalog, &self.model_controls.defaults)
    }

    pub(super) fn model_controls_model_reference(&self) -> String {
        self.model_controls_row()
            .map(|row| {
                model_reference(
                    row.model.as_deref(),
                    row.model_provider.as_deref(),
                    &self.model_controls.catalog,
                )
            })
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| self.model_controls_default_reference())
    }

    pub(super) fn model_controls_disabled_reason(&self) -> Option<String> {
        if self.session.is_none() {
            return Some("Reconnect to change model settings.".into());
        }
        if let Some(reason) = self.model_controls_access_reason(&json!({"model": null})) {
            return Some(reason);
        }
        if self.model_controls.pending {
            return Some("Applying model settings…".into());
        }
        let target = self.model_controls.target.as_ref()?;
        if target.session_key.is_none() && self.new_session.active && self.new_session.locked() {
            return Some("Wait for the new chat to finish preparing.".into());
        }
        if target.session_key.is_some()
            && self
                .model_controls_saved_row(target)
                .is_some_and(SessionRow::running)
        {
            return Some("Wait for the current response to finish.".into());
        }
        if target.session_key == self.chat.selected_session
            && (self.chat.loading || self.chat.active_run.is_some())
        {
            return Some("Wait for the current response to finish.".into());
        }
        None
    }

    pub(super) fn model_controls_access_reason(&self, patch: &Value) -> Option<String> {
        let session = self.session.as_ref()?;
        let target = self.model_controls.target.as_ref()?;
        target.session_key.as_ref()?;
        model_patch_access_reason(
            session.hello(),
            target,
            self.model_controls_saved_row(target),
            patch,
        )
    }

    pub(super) fn apply_model_control_patch(
        &mut self,
        target: ModelControlsTarget,
        patch: Value,
        cx: &mut Context<Self>,
    ) {
        if self.model_controls.target.as_ref() != Some(&target) {
            return;
        }
        let Some(fields) = patch.as_object() else {
            return;
        };
        if fields.is_empty()
            || fields.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "model" | "agentRuntime" | "thinkingLevel" | "fastMode" | "contextWindow"
                )
            })
        {
            return;
        }
        if let Some(reason) = self.model_controls_disabled_reason() {
            self.mutation_error(reason);
            cx.notify();
            return;
        }
        if let Some(reason) = self.model_controls_access_reason(&patch) {
            self.mutation_error(reason);
            cx.notify();
            return;
        }
        if target.session_key.is_none() {
            self.apply_draft_model_control_patch(target, patch, cx);
            return;
        }
        let Some(row) = self.model_controls_saved_row(&target).cloned() else {
            self.mutation_error(
                "The session is still loading. Refresh before changing its settings.".into(),
            );
            cx.notify();
            return;
        };
        if (fields.contains_key("model") && row.model_selection_locked)
            || (fields.contains_key("agentRuntime")
                && row.runtime_selection_locked
                && !patch["agentRuntime"].is_null())
        {
            self.mutation_error("This session's model or runtime is locked.".into());
            cx.notify();
            return;
        }
        let mut patch = patch;
        if row.runtime_selection_locked {
            patch
                .as_object_mut()
                .expect("patch object")
                .remove("agentRuntime");
        }
        let mut params = patch.clone();
        params["key"] = json!(row.key);
        params["agentId"] = json!(target.agent_id);
        if let Some(id) = &row.session_id {
            params["expectedSessionId"] = json!(id);
        }
        self.model_controls.mutation_generation += 1;
        let generation = self.model_controls.mutation_generation;
        self.model_controls.mutations.insert(
            target.clone(),
            PendingSelection {
                session_id: row.session_id.clone(),
                patch,
                generation,
                in_flight: true,
                write_confirmed: false,
            },
        );
        self.model_controls.pending = true;
        if params.get("model").is_some() {
            self.model_controls.close_popups();
        }
        self.request("sessions.patch", params, cx, move |this, result, cx| {
            if !this.owns_model_mutation(&target, &row.session_id, generation) {
                return;
            }
            match result {
                Ok(_) => {
                    if let Some(mutation) = this.model_controls.mutations.get_mut(&target) {
                        mutation.write_confirmed = true;
                    }
                    this.reconcile_model_control_patch(target, row.session_id, generation, cx);
                }
                Err(error) => {
                    // Only the local projection is rolled back; unrelated row mutations remain intact.
                    this.model_controls.mutations.remove(&target);
                    this.sync_model_controls();
                    if this.model_controls.target.as_ref() == Some(&target) {
                        this.mutation_error(format!("Could not update model settings: {error}"));
                        this.load_model_controls(target, cx);
                    }
                }
            }
        });
        cx.notify();
    }

    pub(super) fn sync_model_controls(&mut self) {
        if self.model_controls.epoch != self.epoch {
            self.model_controls.reset_connection();
            self.model_controls.epoch = self.epoch;
            return;
        }
        let replaced: Vec<_> = self
            .model_controls
            .mutations
            .iter()
            .filter(|(target, selection)| {
                self.model_controls_saved_row(target)
                    .is_some_and(|row| row.session_id != selection.session_id)
            })
            .map(|(target, _)| target.clone())
            .collect();
        for target in replaced {
            self.model_controls.mutations.remove(&target);
        }
        self.model_controls.pending = self
            .model_controls
            .target
            .as_ref()
            .and_then(|target| self.model_controls.mutations.get(target))
            .is_some_and(|mutation| mutation.in_flight);
    }

    fn owns_model_mutation(
        &mut self,
        target: &ModelControlsTarget,
        session_id: &Option<String>,
        generation: u64,
    ) -> bool {
        self.sync_model_controls();
        self.model_controls
            .mutations
            .get(target)
            .is_some_and(|selection| {
                selection.generation == generation && &selection.session_id == session_id
            })
    }

    fn reconcile_model_control_patch(
        &mut self,
        target: ModelControlsTarget,
        session_id: Option<String>,
        generation: u64,
        cx: &mut Context<Self>,
    ) {
        self.request("sessions.describe", json!({"agentId": target.agent_id, "key": target.session_key}), cx, move |this, result, cx| {
            if !this.owns_model_mutation(&target, &session_id, generation) { return; }
            let active = this.model_controls.target.as_ref() == Some(&target);
            if let Some(mutation) = this.model_controls.mutations.get_mut(&target) {
                mutation.in_flight = false;
            }
            match result.and_then(|value| value.get("session").cloned().ok_or_else(|| "Session description is unavailable".to_owned()))
                .and_then(|value| serde_json::from_value::<SessionRow>(value).map_err(|error| error.to_string())) {
                Ok(row) if row.session_id == session_id => {
                    if active { this.model_controls.session_snapshot = Some(row); }
                    this.model_controls.mutations.remove(&target);
                }
                Ok(_) => {
                    this.model_controls.mutations.remove(&target);
                    if active { this.mutation_error("The session changed while applying model settings. Refresh and try again.".into()); }
                }
                Err(error) => if active { this.mutation_error(format!("Model settings saved, but their refreshed state is unavailable: {error}")); },
            }
            this.sync_model_controls();
            if active {
                this.model_controls.accounts.clear();
                this.model_controls.account_next_cursor = None;
                this.model_controls.account_generation += 1;
                this.model_controls.accounts_loading = false;
                this.refresh_sessions(cx);
                this.load_model_controls(target, cx);
            }
        });
    }

    fn retire_confirmed_model_overlay(
        &mut self,
        target: &ModelControlsTarget,
        row: &SessionRow,
        generation: Option<u64>,
    ) {
        if self
            .model_controls
            .mutations
            .get(target)
            .is_some_and(|mutation| {
                mutation.write_confirmed
                    && Some(mutation.generation) == generation
                    && mutation.session_id == row.session_id
            })
        {
            self.model_controls.mutations.remove(target);
        }
    }
}
