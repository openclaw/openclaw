mod permissions;

#[path = "composer_capability_actions.rs"]
mod actions;
#[path = "composer_connectors.rs"]
mod connectors_ui;
#[path = "composer_library.rs"]
mod library_ui;
use super::{
    AppView,
    components::menu::{
        MenuStyle, capability_note as menu_note, capability_row as menu_row,
        divider as menu_divider, panel, popover,
    },
    theme::{Palette, menu_tokens as tokens},
};
use crate::model::composer_capabilities::{
    self as capabilities, EffectiveTools, Skill, SkillCatalog, permission_description,
    permission_label,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
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
    pub(super) fn composer_plus_control(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let p = Palette::get(cx);
        let state = &self.composer_capabilities;
        let has_overrides = capabilities::override_count(self.current_tool_overrides()) > 0;
        let target = cx.entity().downgrade();
        popover(
            "composer-plus-menu",
            Anchor::BottomLeft,
            state.plus_open,
            Button::new("attach-files")
                .ghost()
                .small()
                .size(px(tokens::PLUS_BUTTON_SIZE))
                .child(Icon::new(IconName::Plus).size(px(tokens::PLUS_ICON_SIZE)))
                .accessibility_label("Add attachment")
                .text_color(if has_overrides { p.accent } else { p.muted })
                .when(!state.plus_open, |button| button.tooltip("Add attachment"))
                .accessibility_label("Add attachment")
                .disabled(
                    self.session.is_none()
                        || self.new_session.locked()
                        || (!self.new_session.active && self.chat.loading),
                ),
            self.composer_plus_menu(cx),
            move |open, _, cx| {
                let _ = target.update(cx, |this, cx| {
                    if this.composer_capabilities.plus_open == open {
                        return;
                    }
                    this.composer_capabilities.plus_open = open;
                    this.composer_capabilities.view = PlusView::Root;
                    if open {
                        this.load_composer_capabilities(cx);
                    }
                    cx.notify();
                });
            },
        )
    }

    fn composer_plus_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let state = &self.composer_capabilities;
        let overrides = self.current_tool_overrides();
        let blocked = self.capability_blocked();
        let mut menu = panel(
            "composer-capability-menu",
            if state.view == PlusView::Root {
                tokens::CAPABILITY_ROOT_WIDTH
            } else {
                tokens::CAPABILITY_DETAIL_WIDTH
            },
            MenuStyle::Capability,
            cx,
        );
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
                .child(menu_divider(cx));
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
                    .child(menu_divider(cx))
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
                                .size(px(tokens::ICON_SIZE))
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
                            div()
                                .text_size(px(tokens::BADGE_TEXT_SIZE))
                                .text_color(p.muted)
                                .child(
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
                                .size(px(tokens::ICON_SIZE))
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
                    .child(menu_divider(cx))
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
                        .child(Icon::new(IconName::X).size(px(tokens::ICON_SIZE)))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.patch_composer_capability(json!({"toolOverrides":null}), cx)
                        })),
                    );
                }
            }
            PlusView::Skills => {
                menu = menu.children(self.composer_library_menu(None, cx));
                if state.skills_loading {
                    menu = menu.child(menu_note("Loading skills…", cx));
                } else if let Some(error) = &state.skills_error {
                    menu = menu.child(menu_note(&format!("Could not load skills: {error}"), cx));
                } else if state.skills.is_empty() {
                    menu = menu.child(menu_note("No skills available", cx));
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
                menu = menu.child(menu_divider(cx)).child(
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
                    menu = menu.child(menu_note("Loading connectors…", cx));
                } else if state.config_error.is_none() && connectors.is_empty() {
                    menu = menu.child(menu_note("No connectors configured", cx));
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
                            .pl(px(tokens::CAPABILITY_SUBROW_INDENT))
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
                menu = menu.child(menu_divider(cx)).child(
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
                menu = menu.child(menu_note(server, cx));
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
                    menu = menu.child(menu_note("Loading tools…", cx));
                } else if let Some(error) = &state.tools_error {
                    menu = menu.child(menu_note(&format!("Could not load tools: {error}"), cx));
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
                        cx,
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
            menu = menu.child(menu_note(error, cx).text_color(p.danger));
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
}
