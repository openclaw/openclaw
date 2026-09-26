use super::*;

impl AppView {
    pub(in crate::ui) fn load_model_controls(
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
        self.request("models.list", params, cx, move |this, result, cx| {
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
            this.refresh_draft_model_destinations(&catalog_target, cx);
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
            move |this, result, cx| {
                if !this.model_controls_owns_read(&defaults_target, generation) {
                    return;
                }
                if let Ok(value) = result {
                    this.model_controls.defaults =
                        value.get("defaults").cloned().unwrap_or(Value::Null);
                    if defaults_target.session_key.is_none() {
                        this.reconcile_draft_model_controls(&defaults_target);
                        this.refresh_draft_model_destinations(&defaults_target, cx);
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

    pub(super) fn model_controls_owns_read(
        &self,
        target: &ModelControlsTarget,
        generation: u64,
    ) -> bool {
        self.model_controls.target.as_ref() == Some(target)
            && self.model_controls.generation == generation
    }

    pub(in crate::ui) fn load_model_control_accounts(
        &mut self,
        more: bool,
        cx: &mut Context<Self>,
    ) {
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
}
