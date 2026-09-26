use super::*;

impl AppView {
    pub(super) fn capability_scope(&self) -> Scope {
        Scope {
            epoch: self.epoch,
            agent: if self.new_session.active {
                self.new_session.draft.agent_id.clone()
            } else {
                self.selected_row()
                    .and_then(|row| row.agent().map(str::to_owned))
                    .or_else(|| self.sidebar_state.selected_agent.clone())
                    .unwrap_or_else(|| "main".to_owned())
            },
            session: (!self.new_session.active)
                .then(|| self.chat.selected_session.clone())
                .flatten(),
            incarnation: (!self.new_session.active)
                .then(|| self.selected_row().and_then(|row| row.session_id.clone()))
                .flatten(),
        }
    }

    pub(super) fn capability_is_current(&self, scope: &Scope, generation: u64) -> bool {
        self.session.is_some()
            && self.capability_scope() == *scope
            && self.composer_capabilities.generation == generation
            && self.composer_capabilities.scope.as_ref() == Some(scope)
    }

    pub(super) fn composer_has_scope(&self, name: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| capabilities::has_operator_scope(session.hello(), name))
    }

    pub(super) fn composer_method_available(&self, method: &str) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| capabilities::method_available(session.hello(), method))
    }

    pub(in crate::ui) fn composer_draft_available(&self) -> bool {
        self.session
            .as_ref()
            .is_some_and(|session| capabilities::draft_visibility_available(session.hello()))
    }

    pub(super) fn current_tool_overrides(&self) -> Option<&Value> {
        if self.new_session.active {
            self.new_session.draft.tool_overrides.as_ref()
        } else {
            self.selected_row()
                .and_then(|row| row.tool_overrides.as_ref())
        }
    }

    pub(super) fn permission_blocked(&self) -> Option<&'static str> {
        if self.session.is_none() {
            return Some("Reconnect to change execution permissions.");
        }
        if self.composer_capabilities.pending
            || self.new_session.locked()
            || self
                .selected_row()
                .is_some_and(|row| row.permission_mode_pending)
        {
            return Some("Saving execution permissions…");
        }
        if self.composer_has_scope("operator.write") {
            return None;
        }
        if self.composer_has_scope("operator.sessions.write")
            && (self.new_session.active
                || self.selected_row().is_some_and(|row| {
                    matches!(row.sharing_role.as_deref(), Some("owner" | "admin"))
                }))
        {
            return None;
        }
        Some("Changing permissions requires write access to this session.")
    }

    pub(super) fn capability_blocked(&self) -> Option<&'static str> {
        if self.session.is_none() {
            Some("Reconnect to change session capabilities.")
        } else if self.composer_capabilities.pending || self.new_session.locked() {
            Some("Saving session settings…")
        } else if !self.composer_has_scope("operator.admin") {
            Some("Session capability changes require operator.admin access.")
        } else if self.composer_capabilities.config.is_none() {
            Some("Waiting for the active Gateway configuration.")
        } else {
            None
        }
    }

    pub(super) fn load_composer_capabilities(&mut self, cx: &mut Context<Self>) {
        if self.session.is_none()
            || self.composer_capabilities.pending
            || self.composer_capabilities.library.busy
        {
            return;
        }
        let scope = self.capability_scope();
        self.composer_capabilities.generation =
            self.composer_capabilities.generation.wrapping_add(1);
        let generation = self.composer_capabilities.generation;
        self.composer_capabilities.scope = Some(scope.clone());
        self.composer_capabilities.config = None;
        self.composer_capabilities.config_loading = true;
        self.composer_capabilities.config_error = None;
        self.composer_capabilities.skills.clear();
        self.composer_capabilities.skills_loading = true;
        self.composer_capabilities.skills_error = None;
        self.composer_capabilities.tools = None;
        self.composer_capabilities.error = None;
        let config_scope = scope.clone();
        self.request("config.get", json!({}), cx, move |this, result, _| {
            if !this.capability_is_current(&config_scope, generation) {
                return;
            }
            this.composer_capabilities.config_loading = false;
            match result {
                Ok(snapshot) => match snapshot
                    .get("runtimeConfig")
                    .filter(|value| value.is_object())
                {
                    Some(config) => this.composer_capabilities.config = Some(config.clone()),
                    None => {
                        this.composer_capabilities.config_error =
                            Some("The active Gateway configuration is unavailable.".into())
                    }
                },
                Err(error) => this.composer_capabilities.config_error = Some(error),
            }
        });
        self.request(
            "skills.status",
            json!({"agentId":scope.agent}),
            cx,
            move |this, result, _| {
                if !this.capability_is_current(&scope, generation) {
                    return;
                }
                this.composer_capabilities.skills_loading = false;
                match result.and_then(|value| {
                    serde_json::from_value::<SkillCatalog>(value).map_err(|e| e.to_string())
                }) {
                    Ok(mut catalog) => {
                        catalog.skills.sort_by_key(|a| a.name.to_lowercase());
                        this.composer_capabilities.skills = catalog.skills;
                    }
                    Err(error) => this.composer_capabilities.skills_error = Some(error),
                }
            },
        );
        self.load_composer_library(cx);
    }

    pub(super) fn pick_composer_photos(&mut self, multiple: bool, cx: &mut Context<Self>) {
        let scope = self.capability_scope();
        let generation = self.composer_capabilities.generation;
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple,
            prompt: Some("Choose a photo".into()),
        });
        cx.spawn(async move |this, cx| {
            let result = prompt.await;
            let _ = this.update(cx, |this, cx| {
                if !this.capability_is_current(&scope, generation) {
                    return;
                }
                match result {
                    Ok(Ok(Some(paths))) => this.attach_paths(paths, cx),
                    Ok(Err(error)) => this.composer_state.error = Some(error.to_string()),
                    _ => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    pub(super) fn load_composer_tools(&mut self, cx: &mut Context<Self>) {
        let scope = self.capability_scope();
        let Some(session) = &scope.session else {
            return;
        };
        let generation = self.composer_capabilities.generation;
        let model = self.selected_row().and_then(|row| row.model.clone());
        self.composer_capabilities.tools = None;
        self.composer_capabilities.tools_loading = true;
        self.composer_capabilities.tools_error = None;
        self.request(
            "tools.effective",
            json!({"agentId":scope.agent,"sessionKey":session}),
            cx,
            move |this, result, _| {
                if !this.capability_is_current(&scope, generation)
                    || this.selected_row().and_then(|row| row.model.clone()) != model
                {
                    return;
                }
                this.composer_capabilities.tools_loading = false;
                match result
                    .and_then(|value| serde_json::from_value(value).map_err(|e| e.to_string()))
                {
                    Ok(tools) => this.composer_capabilities.tools = Some(tools),
                    Err(error) => this.composer_capabilities.tools_error = Some(error),
                }
            },
        );
    }

    pub(super) fn patch_composer_capability(&mut self, fields: Value, cx: &mut Context<Self>) {
        let permission = fields.get("permissionMode").is_some();
        let blocked = if permission {
            self.permission_blocked()
        } else {
            self.capability_blocked()
        };
        if let Some(reason) = blocked {
            self.composer_capabilities.error = Some(reason.into());
            cx.notify();
            return;
        }
        if fields.get("permissionMode").and_then(Value::as_str) == Some("full")
            && !self.composer_has_scope("operator.admin")
        {
            return;
        }
        let scope = self.capability_scope();
        self.composer_capabilities.scope = Some(scope.clone());
        let generation = self.composer_capabilities.generation;
        self.composer_capabilities.pending = true;
        self.composer_capabilities.error = None;
        self.patch_composer_settings(fields, cx, move |this, result, _| {
            if !this.capability_is_current(&scope, generation) {
                return;
            }
            this.composer_capabilities.pending = false;
            if let Err(error) = result {
                this.composer_capabilities.error = Some(error);
            }
        });
    }

    pub(super) fn choose_permission(&mut self, mode: Option<&str>, cx: &mut Context<Self>) {
        if self.permission_blocked().is_some()
            || (mode == Some("full") && !self.composer_has_scope("operator.admin"))
        {
            return;
        }
        self.composer_capabilities.permission_open = false;
        if mode
            == self
                .selected_row()
                .and_then(|row| row.permission_mode.as_deref())
        {
            cx.notify();
            return;
        }
        self.patch_composer_capability(json!({"permissionMode":mode}), cx);
    }
}
