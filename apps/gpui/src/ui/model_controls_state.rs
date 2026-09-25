use super::AppView;
use crate::{
    gateway::composer_rpc::{
        ChatAccountSelection, ModelAuthStatusResult, ModelsResult, UserModelAccount,
        UsersListModelAccountsResult,
    },
    model::{
        model_controls::{
            ModelControlsTarget, fast_mode_state, find_catalog_entry, normalize_provider,
            normalize_thinking, resolve_runtime_entry, split_model_auth_profile,
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

#[derive(Default)]
struct DraftSelections(HashMap<(String, ModelControlsTarget), Value>);

impl DraftSelections {
    fn read(&self, gateway: &str, target: &ModelControlsTarget) -> Value {
        self.0
            .get(&(gateway.to_owned(), target.clone()))
            .cloned()
            .unwrap_or_else(|| json!({}))
    }

    fn apply(
        &mut self,
        gateway: &str,
        target: ModelControlsTarget,
        fields: &serde_json::Map<String, Value>,
        default_reference: &str,
    ) -> Value {
        let draft = self
            .0
            .entry((gateway.to_owned(), target))
            .or_insert_with(|| json!({}));
        let previous_ref = draft.get("model").and_then(Value::as_str).unwrap_or("");
        let mut next = fields.clone();
        let mut ordinary_model_choice = false;
        if let Some(value) = fields.get("model") {
            let (model, explicit_account) = split_model_auth_profile(value.as_str().unwrap_or(""));
            ordinary_model_choice = explicit_account.is_none();
            let reference = if model.is_empty() {
                default_reference
            } else {
                model
            };
            let previous_account = split_model_auth_profile(previous_ref).1.filter(|_| {
                previous_ref.split_once('/').map(|(provider, _)| provider)
                    == reference.split_once('/').map(|(provider, _)| provider)
            });
            if let Some(account) = explicit_account.or(previous_account) {
                next.insert("model".into(), json!(format!("{reference}@{account}")));
            }
        }
        let draft_fields = draft.as_object_mut().expect("draft patch is an object");
        draft_fields.extend(next);
        if ordinary_model_choice {
            draft_fields.remove("contextWindow");
            if !fields.contains_key("agentRuntime") {
                draft_fields.remove("agentRuntime");
            }
        }
        draft.clone()
    }
}

pub(super) struct ModelControlsUi {
    pub target: Option<ModelControlsTarget>,
    pub search: Entity<InputState>,
    pub model_open: bool,
    pub effort_open: bool,
    pub effort_preview: Option<usize>,
    pub effort_dragging: bool,
    pub effort_bounds: std::rc::Rc<std::cell::Cell<Bounds<Pixels>>>,
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
            effort_dragging: false,
            effort_bounds: Default::default(),
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
        self.effort_dragging = false;
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

    pub(super) fn load_model_controls(
        &mut self,
        target: ModelControlsTarget,
        cx: &mut Context<Self>,
    ) {
        if self.session.is_none() || self.model_controls.target.as_ref() != Some(&target) {
            return;
        }
        self.model_controls.generation += 1;
        let generation = self.model_controls.generation;
        self.model_controls.loading = true;
        self.model_controls.error = None;
        let mut params = json!({"agentId": target.agent_id});
        if let Some(key) = &target.session_key {
            params["sessionKey"] = json!(key);
        } else if let Some(profile) = self
            .model_controls_draft_patch(&target)
            .get("model")
            .and_then(Value::as_str)
            .and_then(|model| split_model_auth_profile(model).1)
        {
            params["authProfileId"] = json!(profile);
        }
        let catalog_target = target.clone();
        self.request("models.list", params, cx, move |this, result, _| {
            if !this.model_controls_owns_read(&catalog_target, generation) {
                return;
            }
            this.model_controls.loading = false;
            match result.and_then(|value| {
                serde_json::from_value::<ModelsResult>(value).map_err(|e| e.to_string())
            }) {
                Ok(catalog) => {
                    this.model_controls.catalog = catalog;
                    this.model_controls.has_snapshot = true;
                    if catalog_target.session_key.is_none() {
                        this.reconcile_draft_model_controls(&catalog_target);
                    }
                }
                Err(error) => {
                    this.model_controls.error = Some(format!("Models unavailable: {error}"))
                }
            }
        });
        let auth_target = target.clone();
        self.request(
            "models.authStatus",
            json!({"agentId": target.agent_id}),
            cx,
            move |this, result, _| {
                if !this.model_controls_owns_read(&auth_target, generation) {
                    return;
                }
                if let Ok(auth) = result
                    .and_then(|value| serde_json::from_value(value).map_err(|e| e.to_string()))
                {
                    this.model_controls.auth = auth;
                }
            },
        );
        let defaults_target = target.clone();
        self.request(
            "sessions.list",
            json!({"agentId": target.agent_id, "limit": 1, "includeGlobal": true}),
            cx,
            move |this, result, _| {
                if !this.model_controls_owns_read(&defaults_target, generation) {
                    return;
                }
                if let Ok(value) = result {
                    this.model_controls.defaults =
                        value.get("defaults").cloned().unwrap_or(Value::Null);
                    if defaults_target.session_key.is_none() {
                        this.reconcile_draft_model_controls(&defaults_target);
                    }
                }
            },
        );
        if let Some(key) = &target.session_key {
            let confirmed_generation = self
                .model_controls
                .mutations
                .get(&target)
                .filter(|mutation| mutation.write_confirmed)
                .map(|mutation| mutation.generation);
            self.request(
                "sessions.describe",
                json!({"agentId": target.agent_id, "key": key}),
                cx,
                move |this, result, _| {
                    if !this.model_controls_owns_read(&target, generation) {
                        return;
                    }
                    if let Ok(value) = result {
                        let snapshot: Option<SessionRow> = value
                            .get("session")
                            .filter(|v| !v.is_null())
                            .cloned()
                            .and_then(|value| serde_json::from_value(value).ok());
                        if let Some(row) = &snapshot {
                            this.retire_confirmed_model_overlay(&target, row, confirmed_generation);
                        }
                        this.model_controls.session_snapshot = snapshot;
                        this.sync_model_controls();
                    }
                },
            );
        }
        cx.notify();
    }

    fn model_controls_owns_read(&self, target: &ModelControlsTarget, generation: u64) -> bool {
        self.model_controls.target.as_ref() == Some(target)
            && self.model_controls.generation == generation
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
        let mut defaults = self.model_controls.defaults.clone();
        if let Some(policy) = &self.model_controls.catalog.model_selection_policy
            && policy.restricted
        {
            defaults["model"] = json!(policy.default_model);
            defaults["modelProvider"] = Value::Null;
        }
        Some(project_model_controls_row(
            target,
            self.model_controls_saved_row(target),
            &defaults,
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
        cx.notify();
    }

    fn reconcile_draft_model_controls(&mut self, target: &ModelControlsTarget) {
        if !self.model_controls.has_snapshot {
            return;
        }
        let Some(gateway) = self.composer_state.drafts.gateway().map(str::to_owned) else {
            return;
        };
        let mut patch = self.model_controls.drafts.read(&gateway, target);
        reconcile_draft_selection(
            &mut patch,
            &self.model_controls.catalog,
            &self.model_controls.defaults,
            &self.model_controls_default_reference(),
        );
        self.model_controls
            .drafts
            .0
            .insert((gateway, target.clone()), patch);
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
        let mut patch = self.model_controls.drafts.read(&gateway, &target);
        let Some(value) = patch.get("model").and_then(Value::as_str) else {
            return;
        };
        let (model, account) = split_model_auth_profile(value);
        if account.is_none() {
            return;
        }
        patch["model"] = json!(model);
        self.model_controls
            .drafts
            .0
            .insert((gateway, target.clone()), patch);
        self.model_controls.catalog = ModelsResult::default();
        self.model_controls.has_snapshot = false;
        self.model_controls.accounts.clear();
        self.model_controls.account_next_cursor = None;
        self.model_controls.account_generation += 1;
        self.model_controls.accounts_loading = false;
        self.load_model_controls(target, cx);
    }

    pub(super) fn model_controls_default_reference(&self) -> String {
        if let Some(policy) = &self.model_controls.catalog.model_selection_policy
            && policy.restricted
        {
            return policy.default_model.clone().unwrap_or_default();
        }
        model_reference(
            self.model_controls
                .defaults
                .get("model")
                .and_then(Value::as_str),
            self.model_controls
                .defaults
                .get("modelProvider")
                .and_then(Value::as_str),
            &self.model_controls.catalog,
        )
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

    pub(super) fn load_model_control_accounts(&mut self, more: bool, cx: &mut Context<Self>) {
        let Some(target) = self.model_controls.target.clone() else {
            return;
        };
        if self.session.is_none() || self.model_controls.accounts_loading {
            return;
        }
        let cursor = more
            .then(|| self.model_controls.account_next_cursor.clone())
            .flatten();
        if more && cursor.is_none() {
            return;
        }
        self.model_controls.account_generation += 1;
        let generation = self.model_controls.account_generation;
        self.model_controls.accounts_loading = true;
        self.model_controls.accounts_error = None;
        self.request(
            "users.listModelAccounts",
            cursor
                .as_ref()
                .map(|cursor| json!({"cursor": cursor}))
                .unwrap_or_else(|| json!({})),
            cx,
            move |this, result, _| {
                if this.model_controls.target.as_ref() != Some(&target)
                    || this.model_controls.account_generation != generation
                {
                    return;
                }
                this.model_controls.accounts_loading = false;
                match result.and_then(|value| {
                    serde_json::from_value::<UsersListModelAccountsResult>(value)
                        .map_err(|e| e.to_string())
                }) {
                    Ok(result) => {
                        if cursor.is_none() {
                            this.model_controls.accounts.clear();
                        }
                        for account in result.accounts {
                            if !this
                                .model_controls
                                .accounts
                                .iter()
                                .any(|old| old.auth_profile_id == account.auth_profile_id)
                            {
                                this.model_controls.accounts.push(account);
                            }
                        }
                        this.model_controls.account_next_cursor = result.next_cursor;
                    }
                    Err(error) => {
                        this.model_controls.accounts_error =
                            Some(format!("Could not load model accounts: {error}"))
                    }
                }
            },
        );
        cx.notify();
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

fn model_reference(model: Option<&str>, provider: Option<&str>, catalog: &ModelsResult) -> String {
    let model = model.unwrap_or_default().trim();
    if model.is_empty() {
        return String::new();
    }
    let normalized_model = model.to_lowercase();
    let unique_catalog_value = || {
        let mut matched: Option<String> = None;
        for entry in &catalog.models {
            if entry.id.trim().to_lowercase() != normalized_model {
                continue;
            }
            let candidate = entry.reference();
            if let Some(previous) = &matched {
                if previous.to_lowercase() != candidate.to_lowercase() {
                    return None;
                }
            } else {
                matched = Some(candidate);
            }
        }
        matched
    };
    let Some(provider) = provider
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
    else {
        return if model.contains('/') {
            model.to_owned()
        } else {
            unique_catalog_value().unwrap_or_else(|| model.to_owned())
        };
    };
    let qualified = if normalized_model.starts_with(&format!("{}/", provider.to_lowercase())) {
        model.to_owned()
    } else {
        format!("{provider}/{model}")
    };
    if !model.contains('/') {
        return unique_catalog_value()
            .filter(|value| value != model)
            .unwrap_or(qualified);
    }
    let contains = |value: &str| {
        catalog
            .models
            .iter()
            .any(|entry| entry.reference().to_lowercase() == value.to_lowercase())
    };
    let provider_owns_raw_id = catalog.models.iter().any(|entry| {
        entry.id.trim().to_lowercase() == normalized_model
            && normalize_provider(&entry.provider) == normalize_provider(provider)
    });
    if provider_owns_raw_id && contains(&qualified) {
        return qualified;
    }
    if contains(model) {
        return model.to_owned();
    }
    if contains(&qualified) {
        return qualified;
    }
    unique_catalog_value().unwrap_or_else(|| model.to_owned())
}

fn reconcile_draft_selection(
    patch: &mut Value,
    catalog: &ModelsResult,
    defaults: &Value,
    default_reference: &str,
) {
    let requested = patch.get("model").and_then(Value::as_str).unwrap_or("");
    let (model, account) = split_model_auth_profile(requested);
    let reference = if model.is_empty() {
        default_reference
    } else {
        model
    };
    let runtime = patch.get("agentRuntime").and_then(Value::as_str);
    let entry = find_catalog_entry(&catalog.models, reference)
        .and_then(|entry| resolve_runtime_entry(entry, runtime));
    if !model.is_empty()
        && entry.as_ref().is_none_or(|entry| {
            entry.available == Some(false) || entry.manual_selection_allowed == Some(false)
        })
    {
        // An explicit account remains visible for correction if its scoped catalog cannot serve it.
        if account.is_none() {
            for field in [
                "model",
                "agentRuntime",
                "thinkingLevel",
                "fastMode",
                "contextWindow",
            ] {
                patch
                    .as_object_mut()
                    .expect("draft patch object")
                    .remove(field);
            }
        }
        return;
    }
    let provider = reference
        .split_once('/')
        .map(|(provider, _)| provider)
        .unwrap_or("");
    let fast_supported =
        provider.is_empty() || fast_mode_state(entry.as_ref(), provider, None, None).supported;
    let default_profile = model.is_empty()
        && runtime.is_none()
        && ["thinkingLevels", "thinkingOptions", "thinkingDefault"]
            .iter()
            .any(|key| defaults.get(key).is_some_and(|value| !value.is_null()));
    let levels: Option<Vec<String>> = if default_profile {
        defaults
            .get("thinkingLevels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|level| level.get("id").and_then(Value::as_str))
                    .map(normalize_thinking)
                    .collect()
            })
            .or_else(|| {
                defaults
                    .get("thinkingOptions")
                    .and_then(Value::as_array)
                    .map(|levels| {
                        levels
                            .iter()
                            .filter_map(Value::as_str)
                            .map(normalize_thinking)
                            .collect()
                    })
            })
    } else {
        entry
            .as_ref()
            .and_then(|entry| entry.thinking_levels.as_ref())
            .map(|levels| {
                levels
                    .iter()
                    .map(|level| normalize_thinking(&level.id))
                    .collect()
            })
    };
    let clear_thinking = entry
        .as_ref()
        .is_some_and(|entry| entry.reasoning == Some(false))
        || patch
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                levels
                    .as_ref()
                    .is_some_and(|levels| !levels.contains(&normalize_thinking(value)))
            });
    let clear_context = patch
        .get("contextWindow")
        .and_then(Value::as_str)
        .is_some_and(|selected| {
            entry.as_ref().is_some_and(|entry| {
                !entry
                    .context_windows
                    .iter()
                    .any(|option| option.id == selected)
            })
        });
    if !fast_supported && patch.get("fastMode").is_some_and(|value| !value.is_null()) {
        patch
            .as_object_mut()
            .expect("draft patch object")
            .remove("fastMode");
    }
    if clear_thinking
        && patch
            .get("thinkingLevel")
            .is_some_and(|value| !value.is_null())
    {
        patch
            .as_object_mut()
            .expect("draft patch object")
            .remove("thinkingLevel");
    }
    if clear_context {
        patch
            .as_object_mut()
            .expect("draft patch object")
            .remove("contextWindow");
    }
}

fn model_patch_access_reason(
    hello: &Value,
    target: &ModelControlsTarget,
    row: Option<&SessionRow>,
    patch: &Value,
) -> Option<String> {
    if !hello
        .pointer("/features/methods")
        .and_then(Value::as_array)
        .is_some_and(|methods| methods.iter().any(|method| method == "sessions.patch"))
    {
        return Some("This Gateway does not support changing session settings.".into());
    }
    let scopes = hello.pointer("/auth/scopes").and_then(Value::as_array);
    let has_scope =
        |scope: &str| scopes.is_some_and(|scopes| scopes.iter().any(|value| value == scope));
    let admin = has_scope("operator.admin");
    if hello
        .pointer("/auth/role")
        .and_then(Value::as_str)
        .is_some_and(|role| role != "operator")
    {
        return Some("Session settings require operator access.".into());
    }
    if patch.get("contextWindow").is_some() {
        return (!admin).then(|| "Changing context window requires operator.admin access.".into());
    }
    if admin || has_scope("operator.write") {
        return None;
    }
    if !has_scope("operator.sessions.write") {
        return Some("Changing session settings requires operator.sessions.write access.".into());
    }
    if target.session_key.is_some()
        && !row.is_some_and(|row| matches!(row.sharing_role.as_deref(), Some("owner" | "admin")))
    {
        return Some("Only the session owner can change these settings.".into());
    }
    None
}

fn project_model_controls_row(
    target: &ModelControlsTarget,
    base: Option<&SessionRow>,
    defaults: &Value,
    patch: &Value,
) -> SessionRow {
    let mut row = base.cloned().unwrap_or_else(|| {
        let mut row: SessionRow = serde_json::from_value(defaults.clone()).unwrap_or_default();
        row.agent_id = Some(target.agent_id.clone());
        row.key = target.session_key.clone().unwrap_or_default();
        row
    });
    if target.session_key.is_none()
        && patch.get("model").and_then(Value::as_str).is_some()
        && patch.get("agentRuntime").is_none()
    {
        // A draft model owns its configured route; the previous default is not a runtime pin.
        row.agent_runtime = None;
    }
    project_selection(&mut row, patch, defaults);
    row
}

fn project_selection(row: &mut SessionRow, patch: &Value, defaults: &Value) {
    let Some(fields) = patch.as_object() else {
        return;
    };
    let mut projected = fields.clone();
    if let Some(value) = fields.get("model") {
        let model = value
            .as_str()
            .map(|value| split_model_auth_profile(value).0);
        if let Some(model) = model {
            projected.insert("model".into(), json!(model));
            if let Some((provider, model)) = model.split_once('/') {
                projected.insert("model".into(), json!(model));
                projected.insert("modelProvider".into(), json!(provider));
            }
            projected.insert("modelOverrideSource".into(), json!("user"));
        } else {
            projected.insert(
                "model".into(),
                defaults.get("model").cloned().unwrap_or(Value::Null),
            );
            projected.insert(
                "modelProvider".into(),
                defaults
                    .get("modelProvider")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            projected.insert("modelOverrideSource".into(), Value::Null);
        }
        for field in [
            "thinkingLevels",
            "thinkingOptions",
            "thinkingDefault",
            "contextWindows",
            "contextWindowDefault",
            "activeModel",
            "activeModelProvider",
        ] {
            projected.insert(field.into(), Value::Null);
        }
    }
    if let Some(runtime) = fields.get("agentRuntime") {
        projected.insert(
            "agentRuntime".into(),
            runtime
                .as_str()
                .map(|id| json!({"id": id, "source": "session"}))
                .unwrap_or(Value::Null),
        );
        for field in [
            "thinkingLevels",
            "thinkingOptions",
            "thinkingDefault",
            "contextWindows",
            "contextWindowDefault",
        ] {
            projected.insert(field.into(), Value::Null);
        }
    }
    if let Some(value) = fields.get("fastMode") {
        projected.insert("effectiveFastMode".into(), value.clone());
    }
    row.apply_patch(&Value::Object(projected));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[::core::prelude::v1::test]
    fn model_references_follow_web_stale_hint_and_nested_id_precedence() {
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[
            {"provider":"other", "id":"shared-model", "name":"Shared"},
            {"provider":"other", "id":"shared-model", "name":"Duplicate route"},
            {"provider":"route", "id":"nested/model", "name":"Nested raw ID"},
            {"provider":"nested", "id":"model", "name":"Qualified reference"}
        ]}))
        .unwrap();
        for (model, provider, expected) in [
            ("shared-model", Some("openai"), "other/shared-model"),
            (" SHARED-model ", Some(" stale "), "other/shared-model"),
            ("shared-model", None, "other/shared-model"),
            ("other/shared-model", Some("openai"), "other/shared-model"),
            ("nested/model", Some("route"), "route/nested/model"),
            ("nested/model", Some("stale"), "nested/model"),
            ("nested/model", None, "nested/model"),
            ("openai/unlisted", Some("stale"), "openai/unlisted"),
            ("unlisted", Some(" local "), "local/unlisted"),
        ] {
            assert_eq!(
                model_reference(Some(model), provider, &catalog),
                expected,
                "model={model} provider={provider:?}"
            );
        }
        let ambiguous: ModelsResult = serde_json::from_value(json!({"models":[
            {"provider":"one", "id":"shared", "name":"One"},
            {"provider":"two", "id":"shared", "name":"Two"}
        ]}))
        .unwrap();
        assert_eq!(
            model_reference(Some("shared"), Some("hint"), &ambiguous),
            "hint/shared"
        );
    }

    #[::core::prelude::v1::test]
    fn draft_choices_are_isolated_by_gateway_agent_and_draft_and_preserve_other_settings() {
        let mut drafts = DraftSelections::default();
        let target = ModelControlsTarget {
            agent_id: "work".into(),
            draft_id: Some("one".into()),
            ..Default::default()
        };
        drafts.apply(
            "gateway-a",
            target.clone(),
            json!({"model":"openai/gpt-5", "thinkingLevel":"high"})
                .as_object()
                .unwrap(),
            "",
        );
        drafts.apply(
            "gateway-a",
            target.clone(),
            json!({"thinkingLevel":null}).as_object().unwrap(),
            "",
        );
        assert_eq!(
            drafts.read("gateway-a", &target),
            json!({"model":"openai/gpt-5", "thinkingLevel":null})
        );
        assert_eq!(drafts.read("gateway-b", &target), json!({}));
        assert_eq!(
            drafts.read(
                "gateway-a",
                &ModelControlsTarget {
                    agent_id: "personal".into(),
                    ..target.clone()
                }
            ),
            json!({})
        );
        assert_eq!(
            drafts.read(
                "gateway-a",
                &ModelControlsTarget {
                    draft_id: Some("two".into()),
                    ..target
                }
            ),
            json!({})
        );
    }

    #[::core::prelude::v1::test]
    fn draft_model_intents_replace_runtime_while_account_only_intents_preserve_it() {
        let target = ModelControlsTarget {
            agent_id: "work".into(),
            ..Default::default()
        };
        let seed = json!({"model":"local/old@personal:one", "agentRuntime":"old-runtime", "contextWindow":"large", "thinkingLevel":"high"});
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[{
            "provider":"local", "id":"new", "name":"New", "agentRuntime":{"id":"openclaw", "source":"provider"}, "thinkingLevels":[{"id":"high", "label":"High"}]
        }]})).unwrap();
        let mut drafts = DraftSelections::default();
        for (previous_model, expected_model) in [
            ("local/old", "local/new"),
            ("local/old@personal:one", "local/new@personal:one"),
        ] {
            let mut previous = seed.clone();
            previous["model"] = json!(previous_model);
            drafts.apply(
                "gateway",
                target.clone(),
                previous.as_object().unwrap(),
                "local/default",
            );
            let mut changed = drafts.apply(
                "gateway",
                target.clone(),
                json!({"model":"local/new"}).as_object().unwrap(),
                "local/default",
            );
            assert_eq!(changed["model"], expected_model);
            assert!(changed.get("agentRuntime").is_none());
            assert!(changed.get("contextWindow").is_none());
            reconcile_draft_selection(&mut changed, &catalog, &json!({}), "local/default");
            assert_eq!(changed["model"], expected_model);
            assert_eq!(changed["thinkingLevel"], "high");
        }

        drafts.apply(
            "gateway",
            target.clone(),
            seed.as_object().unwrap(),
            "local/default",
        );
        let account = drafts.apply(
            "gateway",
            target.clone(),
            json!({"model":"local/old@personal:two"})
                .as_object()
                .unwrap(),
            "local/default",
        );
        assert_eq!(account["agentRuntime"], "old-runtime");
        assert_eq!(account["contextWindow"], "large");
        let runtime = drafts.apply(
            "gateway",
            target,
            json!({"model":"local/new", "agentRuntime":"new-runtime"})
                .as_object()
                .unwrap(),
            "local/default",
        );
        assert_eq!(runtime["agentRuntime"], "new-runtime");
    }

    #[::core::prelude::v1::test]
    fn draft_model_changes_drop_unsupported_settings_but_preserve_unknown_thinking_profiles() {
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[
            {"id":"binary", "provider":"local", "name":"Binary", "reasoning":true, "thinkingLevels":[{"id":"high","label":"On"}], "supportsFastMode":false, "contextWindows":[{"id":"small","label":"Small","contextWindow":32000}]},
            {"id":"unknown", "provider":"local", "name":"Unknown"},
            {"id":"none", "provider":"local", "name":"None", "thinkingLevels":[]}
        ]})).unwrap();
        let mut binary = json!({"model":"local/binary", "thinkingLevel":"medium", "fastMode":true, "contextWindow":"large"});
        reconcile_draft_selection(&mut binary, &catalog, &json!({}), "");
        assert_eq!(binary, json!({"model":"local/binary"}));
        let mut supported =
            json!({"model":"local/binary", "thinkingLevel":"high", "contextWindow":"small"});
        reconcile_draft_selection(&mut supported, &catalog, &json!({}), "");
        assert_eq!(
            supported,
            json!({"model":"local/binary", "thinkingLevel":"high", "contextWindow":"small"})
        );
        let mut unknown = json!({"model":"local/unknown", "thinkingLevel":"medium"});
        reconcile_draft_selection(&mut unknown, &catalog, &json!({}), "");
        assert_eq!(unknown["thinkingLevel"], "medium");
        let mut unsupported = json!({"model":"local/none", "thinkingLevel":"medium"});
        reconcile_draft_selection(&mut unsupported, &catalog, &json!({}), "");
        assert!(unsupported.get("thinkingLevel").is_none());
    }

    #[::core::prelude::v1::test]
    fn draft_model_projection_uses_selected_runtime_without_losing_explicit_pins() {
        let draft = ModelControlsTarget {
            agent_id: "work".into(),
            ..Default::default()
        };
        let defaults = json!({"model":"default", "modelProvider":"anthropic", "agentRuntime":{"id":"claude-cli", "source":"agent"}});
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[{
            "id":"selected", "provider":"local", "name":"Selected",
            "agentRuntime":{"id":"openclaw", "source":"provider"},
            "thinkingLevels":[{"id":"high", "label":"High"}],
            "runtimeChoices":[{"agentRuntime":{"id":"worker", "source":"session"}, "thinkingLevels":[{"id":"medium", "label":"Medium"}]}]
        }]})).unwrap();
        for patch in [
            json!({"model":"local/selected"}),
            json!({"model":"local/selected@personal:fixture"}),
        ] {
            let row = project_model_controls_row(&draft, None, &defaults, &patch);
            let entry = &catalog.models[0];
            let capabilities = resolve_runtime_entry(
                entry,
                row.agent_runtime
                    .as_ref()
                    .map(|runtime| runtime.id.as_str()),
            );
            assert_eq!(
                capabilities
                    .and_then(|entry| entry.thinking_levels)
                    .map(|levels| levels[0].id.clone())
                    .as_deref(),
                Some("high")
            );
        }
        let pinned = project_model_controls_row(
            &draft,
            None,
            &defaults,
            &json!({"model":"local/selected@personal:fixture", "agentRuntime":"worker"}),
        );
        assert_eq!(
            pinned
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str()),
            Some("worker")
        );
        assert_eq!(pinned.model.as_deref(), Some("selected"));
        let inherited = project_model_controls_row(&draft, None, &defaults, &json!({}));
        assert_eq!(
            inherited
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str()),
            Some("claude-cli")
        );
        let session_target = ModelControlsTarget {
            session_key: Some("agent:work:chat".into()),
            ..draft
        };
        let existing = project_model_controls_row(
            &session_target,
            Some(&inherited),
            &defaults,
            &json!({"model":"local/selected"}),
        );
        assert_eq!(
            existing
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str()),
            Some("claude-cli")
        );
    }

    #[::core::prelude::v1::test]
    fn optimistic_model_and_runtime_changes_retire_old_capabilities_and_hide_account_suffix() {
        let mut row: SessionRow = serde_json::from_value(json!({
            "key":"agent:work:chat", "label":"Keep this label", "model":"old", "modelProvider":"anthropic",
            "agentRuntime":{"id":"claude-cli", "source":"session"},
            "thinkingLevels":[{"id":"high", "label":"High"}], "thinkingDefault":"high",
            "contextWindows":[{"id":"large", "label":"Large", "contextWindow":200000}]
        })).unwrap();
        project_selection(
            &mut row,
            &json!({"model":"openai/gpt-5@personal:fixture", "agentRuntime":null}),
            &json!({}),
        );
        assert_eq!(row.model.as_deref(), Some("gpt-5"));
        assert_eq!(row.model_provider.as_deref(), Some("openai"));
        assert_eq!(row.model_override_source.as_deref(), Some("user"));
        assert!(row.agent_runtime.is_none());
        assert!(row.thinking_levels.is_none());
        assert!(row.context_windows.is_none());
        assert_eq!(row.label.as_deref(), Some("Keep this label"));
        project_selection(
            &mut row,
            &json!({"model":null, "fastMode":false}),
            &json!({"model":"default-model", "modelProvider":"local"}),
        );
        assert_eq!(row.model.as_deref(), Some("default-model"));
        assert_eq!(row.model_provider.as_deref(), Some("local"));
        assert!(row.model_override_source.is_none());
        assert_eq!(
            row.effective_fast_mode,
            Some(crate::gateway::composer_rpc::FastMode::Off)
        );
    }

    #[::core::prelude::v1::test]
    fn scoped_settings_require_ownership_but_context_windows_require_admin() {
        let hello = json!({"features":{"methods":["sessions.patch"]}, "auth":{"role":"operator", "scopes":["operator.sessions.write"]}});
        let target = ModelControlsTarget {
            agent_id: "work".into(),
            session_key: Some("agent:work:chat".into()),
            ..Default::default()
        };
        let owner = SessionRow {
            sharing_role: Some("owner".into()),
            ..Default::default()
        };
        assert!(
            model_patch_access_reason(&hello, &target, Some(&owner), &json!({"model":null}))
                .is_none()
        );
        assert!(
            model_patch_access_reason(
                &hello,
                &target,
                Some(&owner),
                &json!({"contextWindow":null})
            )
            .is_some()
        );
        assert!(
            model_patch_access_reason(
                &hello,
                &target,
                Some(&SessionRow::default()),
                &json!({"thinkingLevel":"high"})
            )
            .is_some()
        );
        let draft = ModelControlsTarget {
            session_key: None,
            ..target
        };
        assert!(
            model_patch_access_reason(&hello, &draft, None, &json!({"thinkingLevel":"high"}))
                .is_none()
        );
        let admin = json!({"features":{"methods":["sessions.patch"]}, "auth":{"role":"operator", "scopes":["operator.admin"]}});
        assert!(
            model_patch_access_reason(&admin, &draft, None, &json!({"contextWindow":"large"}))
                .is_none()
        );
    }
}
