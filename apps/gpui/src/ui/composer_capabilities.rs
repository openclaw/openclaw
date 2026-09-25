#[path = "composer_connectors.rs"]
mod connectors_ui;
#[path = "composer_library.rs"]
mod library_ui;
use super::{AppView, theme::Palette};
use crate::model::composer_capabilities::{
    self as capabilities, EffectiveTools, Skill, SkillCatalog,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        popover::Popover,
    },
    prelude::FluentBuilder as _,
    *,
};
use serde_json::{Value, json};

#[derive(Clone, Default, PartialEq)]
pub(super) enum PlusView {
    #[default]
    Root,
    Skills,
    Connectors,
    Tools(String),
    Library(String),
}

#[derive(Clone, PartialEq)]
struct Scope {
    epoch: u64,
    agent: String,
    session: Option<String>,
    incarnation: Option<String>,
}

#[derive(Default)]
pub(super) struct ComposerCapabilities {
    pub plus_open: bool,
    pub permission_open: bool,
    generation: u64,
    scope: Option<Scope>,
    view: PlusView,
    config: Option<Value>,
    config_loading: bool,
    config_error: Option<String>,
    skills: Vec<Skill>,
    skills_loading: bool,
    skills_error: Option<String>,
    tools: Option<EffectiveTools>,
    tools_loading: bool,
    tools_error: Option<String>,
    pending: bool,
    error: Option<String>,
    library: library_ui::LibraryUi,
}

impl ComposerCapabilities {
    pub fn reset(&mut self) {
        let generation = self.generation.wrapping_add(1);
        *self = Self {
            generation,
            ..Self::default()
        };
    }
}

impl AppView {
    fn capability_scope(&self) -> Scope {
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

    fn capability_is_current(&self, scope: &Scope, generation: u64) -> bool {
        self.session.is_some()
            && self.capability_scope() == *scope
            && self.composer_capabilities.generation == generation
            && self.composer_capabilities.scope.as_ref() == Some(scope)
    }

    fn composer_has_scope(&self, name: &str) -> bool {
        self.session
            .as_ref()
            .and_then(|session| session.hello().pointer("/auth/scopes"))
            .and_then(Value::as_array)
            .is_some_and(|scopes| {
                scopes.iter().any(|scope| {
                    scope.as_str() == Some(name) || scope.as_str() == Some("operator.admin")
                })
            })
    }

    fn composer_method_available(&self, method: &str) -> bool {
        self.session
            .as_ref()
            .and_then(|session| session.hello().pointer("/features/methods"))
            .and_then(Value::as_array)
            .is_some_and(|methods| methods.iter().any(|v| v.as_str() == Some(method)))
    }

    pub(super) fn composer_draft_available(&self) -> bool {
        self.session.as_ref().is_some_and(|session| {
            session
                .hello()
                .pointer("/policy/hasMultipleSessionSharingIdentities")
                .and_then(Value::as_bool)
                == Some(true)
                && session
                    .hello()
                    .pointer("/policy/allowedSessionVisibilities")
                    .and_then(Value::as_array)
                    .is_some_and(|values| {
                        values.iter().any(|value| value.as_str() == Some("draft"))
                    })
        })
    }

    fn current_tool_overrides(&self) -> Option<&Value> {
        if self.new_session.active {
            self.new_session.draft.tool_overrides.as_ref()
        } else {
            self.selected_row()
                .and_then(|row| row.tool_overrides.as_ref())
        }
    }

    fn permission_blocked(&self) -> Option<&'static str> {
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

    fn capability_blocked(&self) -> Option<&'static str> {
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

    fn load_composer_capabilities(&mut self, cx: &mut Context<Self>) {
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

    fn pick_composer_photos(&mut self, multiple: bool, cx: &mut Context<Self>) {
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

    fn load_composer_tools(&mut self, cx: &mut Context<Self>) {
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

    fn patch_composer_capability(&mut self, fields: Value, cx: &mut Context<Self>) {
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

    fn choose_permission(&mut self, mode: Option<&str>, cx: &mut Context<Self>) {
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

    pub(super) fn composer_plus_control(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let state = &self.composer_capabilities;
        let has_overrides = capabilities::override_count(self.current_tool_overrides()) > 0;
        let target = cx.entity().downgrade();
        Popover::new("composer-plus-menu")
            .anchor(Anchor::BottomLeft)
            .appearance(false)
            .open(state.plus_open)
            .on_open_change(move |open, _, cx| {
                let _ = target.update(cx, |this, cx| {
                    this.composer_capabilities.plus_open = *open;
                    this.composer_capabilities.view = PlusView::Root;
                    if *open {
                        this.load_composer_capabilities(cx);
                    }
                    cx.notify();
                });
            })
            .trigger(
                Button::new("attach-files")
                    .ghost()
                    .small()
                    .size(px(28.))
                    .child(Icon::new(IconName::Plus).size(px(20.)))
                    .accessibility_label("Add attachment")
                    .text_color(if has_overrides { p.accent } else { p.muted })
                    .tooltip("Add attachment")
                    .disabled(
                        self.session.is_none()
                            || self.new_session.locked()
                            || (!self.new_session.active && self.chat.loading),
                    ),
            )
            .child(self.composer_plus_menu(cx))
    }

    fn composer_plus_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let state = &self.composer_capabilities;
        let overrides = self.current_tool_overrides();
        let blocked = self.capability_blocked();
        let mut menu = div()
            .id("composer-capability-menu")
            .v_flex()
            .w(px(if state.view == PlusView::Root {
                208.
            } else {
                272.
            }))
            .max_h(px(420.))
            .overflow_y_scroll()
            .p(px(4.))
            .rounded(px(12.))
            .border_1()
            .border_color(p.border_strong)
            .bg(p.elevated)
            .shadow_lg();
        if state.view != PlusView::Root {
            menu = menu
                .child(
                    menu_row(
                        "capability-back",
                        "Back",
                        Some(IconName::ArrowLeft),
                        None,
                        None,
                        false,
                        cx,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.composer_capabilities.view =
                            if matches!(this.composer_capabilities.view, PlusView::Tools(_)) {
                                PlusView::Connectors
                            } else if matches!(
                                this.composer_capabilities.view,
                                PlusView::Library(_)
                            ) {
                                PlusView::Skills
                            } else {
                                PlusView::Root
                            };
                        cx.notify();
                    })),
                )
                .child(menu_divider(p));
        }
        match &state.view {
            PlusView::Root => {
                menu = menu
                    .child(
                        menu_row(
                            "capability-camera",
                            "Take photo",
                            Some(IconName::Camera),
                            None,
                            None,
                            false,
                            cx,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.composer_capabilities.plus_open = false;
                            this.pick_composer_photos(false, cx);
                        })),
                    )
                    .child(
                        menu_row(
                            "capability-photo",
                            "Photo",
                            Some(IconName::Image),
                            None,
                            None,
                            false,
                            cx,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.composer_capabilities.plus_open = false;
                            this.pick_composer_photos(true, cx);
                        })),
                    )
                    .child(
                        menu_row(
                            "capability-attach",
                            "File",
                            Some(IconName::Paperclip),
                            None,
                            None,
                            false,
                            cx,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.composer_capabilities.plus_open = false;
                            this.pick_attachments(cx);
                        })),
                    )
                    .child(menu_divider(p))
                    .when(
                        self.new_session.active && self.composer_draft_available(),
                        |menu| {
                            use crate::model::new_session::Visibility;
                            menu.child(
                                menu_row(
                                    "capability-draft",
                                    "Draft",
                                    Some(IconName::Pencil),
                                    None,
                                    Some(self.new_session.draft.visibility == Visibility::Draft),
                                    self.new_session.locked(),
                                    cx,
                                )
                                .tooltip("Keep this session to yourself until you publish it")
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        if this.new_session.locked() {
                                            return;
                                        }
                                        this.new_session.draft.visibility =
                                            if this.new_session.draft.visibility
                                                == Visibility::Draft
                                            {
                                                Visibility::Normal
                                            } else {
                                                Visibility::Draft
                                            };
                                        cx.notify();
                                    },
                                )),
                            )
                        },
                    )
                    .child(
                        menu_row(
                            "capability-skills",
                            "Skills",
                            Some(IconName::Book),
                            None,
                            None,
                            false,
                            cx,
                        )
                        .child(
                            Icon::new(IconName::ChevronRight)
                                .size(px(14.))
                                .text_color(p.muted),
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.composer_capabilities.view = PlusView::Skills;
                            cx.notify();
                        })),
                    )
                    .child(
                        menu_row(
                            "capability-connectors",
                            "Connectors",
                            Some(IconName::Plug),
                            None,
                            None,
                            false,
                            cx,
                        )
                        .child(
                            div().text_size(px(10.)).text_color(p.muted).child(
                                state
                                    .config
                                    .as_ref()
                                    .map(|config| {
                                        capabilities::connectors(config)
                                            .iter()
                                            .filter(|server| {
                                                capabilities::enabled(
                                                    overrides,
                                                    "mcpServers",
                                                    &server.name,
                                                    server.enabled,
                                                )
                                            })
                                            .count()
                                            .to_string()
                                    })
                                    .unwrap_or_else(|| "…".into()),
                            ),
                        )
                        .child(
                            Icon::new(IconName::ChevronRight)
                                .size(px(14.))
                                .text_color(p.muted),
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.composer_capabilities.view = PlusView::Connectors;
                            cx.notify();
                        })),
                    );
                let base = state
                    .config
                    .as_ref()
                    .is_some_and(capabilities::web_search_base_enabled);
                let stale = overrides
                    .and_then(|v| v.get("webSearch"))
                    .and_then(Value::as_bool)
                    == Some(true);
                let checked = base
                    && overrides
                        .and_then(|v| v.get("webSearch"))
                        .and_then(Value::as_bool)
                        .unwrap_or(true);
                menu = menu
                    .child(
                        menu_row(
                            "capability-search",
                            "Web search",
                            Some(IconName::Globe),
                            None,
                            None,
                            blocked.is_some() || (!base && !stale),
                            cx,
                        )
                        .tooltip(blocked.unwrap_or(if !base {
                            "Web search is disabled in Gateway settings."
                        } else {
                            "Search the web in this session"
                        }))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let next = capabilities::next_web_search(
                                this.current_tool_overrides(),
                                !checked,
                                base,
                            );
                            this.patch_composer_capability(json!({"toolOverrides":next}), cx);
                        })),
                    )
                    .child(menu_divider(p))
                    .child(
                        menu_row(
                            "capability-plugins",
                            "Manage plugins",
                            Some(IconName::Plug),
                            None,
                            None,
                            false,
                            cx,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.composer_capabilities.plus_open = false;
                            this.open_control_page("/plugins", "Plugins", window, cx);
                        })),
                    );
                let count = capabilities::override_count(overrides);
                if count > 0 {
                    menu = menu.child(
                        menu_row(
                            "capability-reset",
                            &format!("{count} override{}", if count == 1 { "" } else { "s" }),
                            Some(IconName::Settings),
                            None,
                            None,
                            blocked.is_some(),
                            cx,
                        )
                        .child(Icon::new(IconName::X).size(px(14.)))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.patch_composer_capability(json!({"toolOverrides":null}), cx)
                        })),
                    );
                }
            }
            PlusView::Skills => {
                menu = menu.children(self.composer_library_menu(None, cx));
                if state.skills_loading {
                    menu = menu.child(menu_note("Loading skills…", p));
                } else if let Some(error) = &state.skills_error {
                    menu = menu.child(menu_note(&format!("Could not load skills: {error}"), p));
                } else if state.skills.is_empty() {
                    menu = menu.child(menu_note("No skills available", p));
                } else {
                    for skill in &state.skills {
                        let key = skill.skill_key.clone();
                        let base = !skill.disabled;
                        let checked = skill.blocked_reason().is_none()
                            && capabilities::enabled(overrides, "skills", &key, base);
                        let reason = skill.blocked_reason().or(blocked);
                        menu = menu.child(
                            menu_row(
                                format!("skill-{key}"),
                                &skill.name,
                                None,
                                skill.blocked_reason(),
                                Some(checked),
                                reason.is_some(),
                                cx,
                            )
                            .tooltip(reason.unwrap_or("Enable this skill for this session"))
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    let next = capabilities::next_boolean(
                                        this.current_tool_overrides(),
                                        "skills",
                                        &key,
                                        !checked,
                                        base,
                                    );
                                    this.patch_composer_capability(
                                        json!({"toolOverrides":next}),
                                        cx,
                                    );
                                },
                            )),
                        );
                    }
                }
                menu = menu.child(menu_divider(p)).child(
                    menu_row(
                        "manage-skills",
                        "Manage skills",
                        None,
                        None,
                        None,
                        false,
                        cx,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.composer_capabilities.plus_open = false;
                        this.open_control_page("/skills", "Skills", window, cx);
                    })),
                );
            }
            PlusView::Connectors => {
                let connectors = state
                    .config
                    .as_ref()
                    .map(capabilities::connectors)
                    .unwrap_or_default();
                if state.config_loading {
                    menu = menu.child(menu_note("Loading connectors…", p));
                } else if state.config_error.is_none() && connectors.is_empty() {
                    menu = menu.child(menu_note("No connectors configured", p));
                }
                for server in connectors {
                    let checked = capabilities::enabled(
                        overrides,
                        "mcpServers",
                        &server.name,
                        server.enabled,
                    );
                    let name = server.name.clone();
                    let note = format!(
                        "{}{}",
                        if checked { "Enabled" } else { "Disabled" },
                        if overrides
                            .and_then(|v| v.get("mcpServers"))
                            .and_then(|v| v.get(&name))
                            .is_some()
                        {
                            " · Session"
                        } else {
                            ""
                        }
                    );
                    menu = menu.child(
                        menu_row(
                            format!("connector-{name}"),
                            &name,
                            None,
                            Some(&note),
                            Some(checked),
                            blocked.is_some(),
                            cx,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let next = capabilities::next_boolean(
                                this.current_tool_overrides(),
                                "mcpServers",
                                &name,
                                !checked,
                                server.enabled,
                            );
                            this.patch_composer_capability(json!({"toolOverrides":next}), cx);
                        })),
                    );
                    if !self.new_session.active && self.composer_method_available("tools.effective")
                    {
                        let name = server.name.clone();
                        menu = menu.child(
                            menu_row(
                                format!("tools-{name}"),
                                "Tool access",
                                Some(IconName::Wrench),
                                None,
                                None,
                                false,
                                cx,
                            )
                            .pl(px(28.))
                            .on_click(cx.listener(
                                move |this, _, _, cx| {
                                    this.composer_capabilities.view = PlusView::Tools(name.clone());
                                    this.load_composer_tools(cx);
                                    cx.notify();
                                },
                            )),
                        );
                    }
                }
                menu = menu.child(menu_divider(p)).child(
                    menu_row(
                        "add-mcp-server",
                        "Add MCP server…",
                        Some(IconName::Plus),
                        None,
                        None,
                        !self.composer_has_scope("operator.admin"),
                        cx,
                    )
                    .on_click(cx.listener(|this, _, window, cx| {
                        this.composer_capabilities.plus_open = false;
                        this.open_composer_connector_dialog(window, cx);
                    })),
                );
            }
            PlusView::Tools(server) => {
                menu = menu.child(menu_note(server, p));
                let tools: Vec<_> = state
                    .tools
                    .as_ref()
                    .into_iter()
                    .flat_map(|r| &r.groups)
                    .flat_map(|g| &g.tools)
                    .filter(|tool| {
                        tool.source == "mcp"
                            && tool.mcp_server.as_ref() == Some(server)
                            && tool.mcp_tool_name.is_some()
                    })
                    .collect();
                if state.tools_loading {
                    menu = menu.child(menu_note("Loading tools…", p));
                } else if let Some(error) = &state.tools_error {
                    menu = menu.child(menu_note(&format!("Could not load tools: {error}"), p));
                } else if tools.is_empty() {
                    let notice = state.tools.as_ref().and_then(|result| {
                        result.notices.iter().find(|n| {
                            matches!(
                                n.id.as_str(),
                                "mcp-not-yet-connected"
                                    | "mcp-not-yet-listed"
                                    | "mcp-stale-catalog"
                            ) && n.servers.contains(server)
                        })
                    });
                    menu = menu.child(menu_note(
                        notice
                            .map(|n| n.message.as_str())
                            .unwrap_or("No tools available"),
                        p,
                    ));
                }
                for tool in tools {
                    let name = tool.mcp_tool_name.clone().unwrap_or_default();
                    let server = server.clone();
                    let denied = capabilities::tool_denied(overrides, tool);
                    menu = menu.child(
                        menu_row(
                            format!("mcp-tool-{name}"),
                            &name,
                            None,
                            (!tool.label.is_empty() && tool.label != name)
                                .then_some(tool.label.as_str()),
                            Some(!denied),
                            blocked.is_some(),
                            cx,
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let next = capabilities::next_tool_denied(
                                this.current_tool_overrides(),
                                &server,
                                &name,
                                !denied,
                            );
                            this.patch_composer_capability(json!({"toolOverrides":next}), cx);
                        })),
                    );
                }
            }
            PlusView::Library(id) => {
                menu = menu.children(self.composer_library_menu(Some(id), cx));
            }
        }
        for error in [state.config_error.as_ref(), state.error.as_ref()]
            .into_iter()
            .flatten()
        {
            menu = menu.child(menu_note(error, p).text_color(p.danger));
        }
        if state.config_error.is_some()
            || state.skills_error.is_some()
            || state.tools_error.is_some()
        {
            menu = menu.child(
                menu_row("capability-retry", "Retry", None, None, None, false, cx).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.load_composer_capabilities(cx);
                        if matches!(this.composer_capabilities.view, PlusView::Tools(_)) {
                            this.load_composer_tools(cx);
                        }
                    }),
                ),
            );
        }
        menu.into_any_element()
    }

    pub(super) fn permission_control(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let current = self
            .selected_row()
            .and_then(|row| row.permission_mode.as_deref());
        let scope = self.capability_scope();
        let default = self
            .sidebar_state
            .agents
            .iter()
            .find(|agent| agent.id == scope.agent)
            .and_then(|agent| agent.default_permission_mode.as_deref());
        let label = permission_label(current, default);
        let blocked = self.permission_blocked();
        let admin = self.composer_has_scope("operator.admin");
        let target = cx.entity().downgrade();
        let mut menu = div()
            .id("composer-permission-menu")
            .v_flex()
            .w(px(340.))
            .p(px(8.))
            .rounded(px(12.))
            .border_1()
            .border_color(p.border_strong)
            .bg(p.elevated)
            .shadow_lg()
            .capture_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if let Some(index) = event
                    .keystroke
                    .key
                    .parse::<usize>()
                    .ok()
                    .filter(|index| (1..=5).contains(index))
                {
                    this.choose_permission(
                        [
                            None,
                            Some("read-only"),
                            Some("guarded"),
                            Some("workspace"),
                            Some("full"),
                        ][index - 1],
                        cx,
                    );
                    cx.stop_propagation();
                }
            }))
            .child(
                Button::new("permission-help")
                    .ghost()
                    .small()
                    .w_full()
                    .justify_between()
                    .px_0()
                    .pb(px(9.))
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(11.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(p.muted)
                            .child("EXECUTION PERMISSIONS"),
                    )
                    .child(
                        div()
                            .text_size(px(11.))
                            .text_color(p.muted)
                            .child("Learn more"),
                    )
                    .on_click(|_, _, cx| {
                        cx.open_url("https://docs.openclaw.ai/gateway/permission-modes")
                    }),
            );
        for (index, mode) in [
            None,
            Some("read-only"),
            Some("guarded"),
            Some("workspace"),
            Some("full"),
        ]
        .into_iter()
        .enumerate()
        {
            let locked = mode == Some("full") && !admin;
            let selected = current == mode;
            let mut row = menu_row(
                format!("permission-{index}"),
                &permission_label(mode, default),
                Some(permission_icon(mode)),
                Some(permission_description(mode)),
                None,
                blocked.is_some() || locked,
                cx,
            )
            .when(selected, |row| row.bg(p.hover))
            .tooltip(if locked {
                "Full access requires operator.admin access."
            } else {
                blocked.unwrap_or(permission_description(mode))
            })
            .on_click(cx.listener(move |this, _, _, cx| this.choose_permission(mode, cx)));
            row = if locked {
                row.child(Icon::new(IconName::Lock).size(px(16.)))
            } else if selected {
                row.child(
                    Icon::new(IconName::Check)
                        .size(px(16.))
                        .text_color(p.accent),
                )
            } else {
                row.child(
                    div()
                        .w(px(16.))
                        .text_size(px(9.))
                        .text_color(p.muted)
                        .child((index + 1).to_string()),
                )
            };
            menu = menu.child(row);
        }
        if let Some(error) = &self.composer_capabilities.error {
            menu = menu.child(menu_note(error, p).text_color(p.danger));
        }
        Popover::new("permission-picker")
            .anchor(Anchor::BottomLeft)
            .appearance(false)
            .open(self.composer_capabilities.permission_open)
            .on_open_change(move |open, _, cx| {
                let _ = target.update(cx, |this, cx| {
                    this.composer_capabilities.permission_open = *open;
                    cx.notify();
                });
            })
            .trigger(
                Button::new("permission-mode")
                    .ghost()
                    .small()
                    .h(px(30.))
                    .accessibility_label(format!("Execution permissions: {label}"))
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .gap(px(6.))
                            .child(Icon::new(permission_icon(current)).size(px(16.)))
                            .child(label),
                    )
                    .text_color(if current.or(default) == Some("full") {
                        p.accent
                    } else {
                        p.muted
                    })
                    .disabled(blocked.is_some())
                    .tooltip(
                        blocked.unwrap_or("Choose what available tools may do in this session."),
                    ),
            )
            .child(menu)
    }
}

fn permission_label(mode: Option<&str>, default: Option<&str>) -> String {
    match mode {
        Some("read-only") => "Read Only".into(),
        Some("guarded") => "Guarded".into(),
        Some("workspace") => "Workspace".into(),
        Some("full") => "Full Access".into(),
        _ => default
            .map(|mode| format!("Default ({})", permission_label(Some(mode), None)))
            .unwrap_or_else(|| "Default".into()),
    }
}
fn permission_description(mode: Option<&str>) -> &'static str {
    match mode {
        Some("read-only") => {
            "Agent tools can read within the session root, but cannot write or run commands."
        }
        Some("guarded") => "A human reviews requests beyond the session root.",
        Some("workspace") => "An AI reviewer checks requests beyond the session root.",
        Some("full") => "No reviewer; files and commands are unrestricted.",
        _ => "Follow the agent's configured execution permissions.",
    }
}
fn permission_icon(mode: Option<&str>) -> IconName {
    match mode {
        Some("read-only") => IconName::ShieldEllipsis,
        Some("guarded") => IconName::ShieldLock,
        Some("workspace") => IconName::ShieldCog,
        Some("full") => IconName::ShieldAlert,
        _ => IconName::ShieldCheck,
    }
}
fn menu_divider(p: Palette) -> Div {
    div().h(px(1.)).mx(px(6.)).my(px(4.)).bg(p.border)
}
fn menu_note(note: &str, p: Palette) -> Div {
    div()
        .px(px(12.))
        .py(px(10.))
        .text_size(px(12.))
        .line_height(px(16.8))
        .text_color(p.muted)
        .child(note.to_owned())
}
fn menu_row(
    id: impl Into<SharedString>,
    label: &str,
    icon: Option<IconName>,
    note: Option<&str>,
    checked: Option<bool>,
    disabled: bool,
    cx: &App,
) -> Button {
    let p = Palette::get(cx);
    Button::new(id.into())
        .ghost()
        .small()
        .accessibility_label(label.to_owned())
        .w_full()
        .h_auto()
        .min_h(px(40.))
        .px(px(9.))
        .py(px(6.))
        .rounded(px(10.))
        .disabled(disabled)
        .child(
            div()
                .h_flex()
                .w_full()
                .flex_1()
                .min_w_0()
                .items_center()
                .gap(px(8.))
                .children(icon.map(|icon| {
                    Icon::new(icon).size(px(16.)).flex_shrink_0().text_color(
                        if icon == IconName::ShieldAlert {
                            p.accent
                        } else {
                            p.muted
                        },
                    )
                }))
                .child(
                    div()
                        .v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(3.))
                        .items_start()
                        .child(
                            div()
                                .text_size(px(13.))
                                .line_height(px(15.6))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(p.strong)
                                .child(label.to_owned()),
                        )
                        .children(note.map(|note| {
                            div()
                                .whitespace_normal()
                                .text_size(px(11.))
                                .line_height(px(13.75))
                                .text_color(p.muted)
                                .child(note.to_owned())
                        })),
                )
                .children(checked.map(|checked| {
                    div()
                        .w(px(26.))
                        .h(px(15.))
                        .flex_shrink_0()
                        .rounded_full()
                        .bg(if checked { p.accent } else { p.border_strong })
                        .p(px(2.))
                        .h_flex()
                        .when(checked, |el| el.justify_end())
                        .child(div().size(px(11.)).rounded_full().bg(p.accent_fg))
                })),
        )
}
