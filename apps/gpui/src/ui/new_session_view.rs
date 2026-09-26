use super::{
    AppView,
    components::{
        controls, icons,
        menu::{
            self, MenuStyle, inline_detail_row as checkout_option, input_field as checkout_field,
            note, section_header as title, selection_row as row,
        },
    },
    new_session::DraftPicker,
    new_session_actions::clone_url,
    theme::{Palette, draft_tokens as t, menu_tokens as m},
};
use crate::model::new_session::{
    Destination, Visibility, is_worktree_name_valid, worktree_branch_name,
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::{Input, Textarea},
    },
    prelude::FluentBuilder,
    *,
};

impl AppView {
    pub(super) fn new_session_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        let state = &self.new_session;
        let draft = &state.draft;
        let agent = self
            .sidebar_state
            .agents
            .iter()
            .find(|a| a.id == draft.agent_id);
        let incognito = draft.visibility == Visibility::Incognito;
        let paste_target = cx.entity().downgrade();
        let invalid_name = draft.worktree && !is_worktree_name_valid(&draft.worktree_name);
        let submit_block = self.draft_submit_block();
        let send_disabled = state.submitting
            || self.session.is_none()
            || self.composer_state.reading > 0
            || invalid_name
            || submit_block.is_some()
            || (self.composer.read(cx).value().trim().is_empty()
                && self.composer_state.attachments.is_empty());
        let composer = div()
            .id("new-session-composer")
            .v_flex()
            .w_full()
            .gap(px(t::STACK_GAP))
            .px(px(t::COMPOSER_INSET))
            .py(px(t::COMPOSER_PADDING_Y))
            .min_h(px(t::COMPOSER_HEIGHT))
            .justify_between()
            .bg(p.card)
            .border_1()
            .border_color(p.border_strong)
            .rounded(px(t::COMPOSER_RADIUS))
            .capture_key_down(cx.listener(Self::composer_key_down))
            .children(self.attachment_rail(cx))
            .child(
                Textarea::new(&self.composer)
                    .mx(px(t::EDITOR_MARGIN_X))
                    .aria_label("What should this session work on?")
                    .accessibility_id("new-session-message")
                    .appearance(false)
                    .bordered(false)
                    .disabled(state.locked())
                    .text_size(px(t::EDITOR_TEXT_SIZE))
                    .on_paste(move |item, _, cx| {
                        paste_target
                            .update(cx, |this, cx| this.composer_paste(item, cx))
                            .unwrap_or(false)
                    }),
            )
            .children(self.composer_state.error.as_ref().map(|error| {
                div()
                    .text_size(px(t::CAPTION_TEXT_SIZE))
                    .text_color(p.danger)
                    .child(error.clone())
            }))
            .when(self.composer_state.reading > 0, |el| {
                el.child(
                    div()
                        .text_color(p.muted)
                        .text_size(px(t::CAPTION_TEXT_SIZE))
                        .child("Reading attachment…"),
                )
            })
            .child(
                div()
                    .h_flex()
                    .group("new-session-footer")
                    .mx(px(t::FOOTER_MARGIN_X))
                    .items_center()
                    .gap(px(t::CONTROL_GAP))
                    .child(self.composer_plus_control(cx))
                    .child(self.permission_control(cx))
                    .when(self.composer_draft_available(), |el| {
                        el.child(
                            Button::new("draft-visibility")
                                .ghost()
                                .small()
                                .h(px(t::FOOTER_CONTROL_SIZE))
                                .icon(Icon::new(IconName::Pencil).size(px(m::ICON_SIZE)))
                                .label("Draft")
                                .text_color(if draft.visibility == Visibility::Draft {
                                    p.accent
                                } else {
                                    p.muted
                                })
                                .tooltip("Keep this session to yourself until you publish it")
                                .disabled(state.locked())
                                .when(draft.visibility != Visibility::Draft, |el| {
                                    el.opacity(t::HIDDEN_CONTROL_OPACITY)
                                        .group_hover("new-session-footer", |el| {
                                            el.opacity(t::VISIBLE_CONTROL_OPACITY)
                                        })
                                })
                                .on_click(cx.listener(|this, _, _, cx| {
                                    this.new_session.draft.visibility =
                                        if this.new_session.draft.visibility == Visibility::Draft {
                                            Visibility::Normal
                                        } else {
                                            Visibility::Draft
                                        };
                                    cx.notify();
                                })),
                        )
                    })
                    .child(div().flex_1())
                    .child(self.model_control(cx))
                    .children(self.effort_control(cx))
                    .child(
                        Button::new("start-session")
                            .primary()
                            .small()
                            .size(px(t::FOOTER_CONTROL_SIZE))
                            .rounded_full()
                            .child(
                                Icon::new(if state.submitting {
                                    IconName::LoaderCircle
                                } else {
                                    IconName::ArrowUp
                                })
                                .size(px(t::FOOTER_ICON_SIZE)),
                            )
                            .accessibility_label(if state.submitting {
                                "Starting session"
                            } else {
                                "Start session"
                            })
                            .disabled(send_disabled)
                            .tooltip(
                                submit_block
                                    .clone()
                                    .unwrap_or_else(|| "Start session".into()),
                            )
                            .on_click(cx.listener(|this, _, window, cx| this.send(window, cx))),
                    ),
            );
        let target_row = div()
            .id("new-session-targets")
            .h_flex()
            .flex_wrap()
            .items_center()
            .gap(px(t::CHIP_GAP))
            .when(self.sidebar_state.agents.len() > 1, |el| {
                el.child(self.draft_picker(
                    DraftPicker::Agent,
                    "draft-agent",
                    agent.map(|a| a.name()).unwrap_or("Agent").to_owned(),
                    IconName::Bot,
                    self.draft_agent_menu(cx),
                    cx,
                ))
            })
            .child(self.draft_picker(
                DraftPicker::Destination,
                "draft-destination",
                self.draft_destination_label(),
                if draft.destination.is_remote() {
                    IconName::Monitor
                } else {
                    IconName::House
                },
                self.draft_destination_menu(cx),
                cx,
            ))
            .child(self.draft_picker(
                DraftPicker::Project,
                "draft-project",
                self.draft_project_label(),
                if draft.project_id.is_empty() {
                    IconName::Folder
                } else {
                    IconName::GitBranch
                },
                self.draft_project_menu(cx),
                cx,
            ))
            .when(
                !(draft.destination.is_remote() && draft.fresh_workspace)
                    && (state.branches.repository_status.as_deref() == Some("git")
                        || !draft.project_git_url.is_empty()
                        || draft.worktree),
                |el| {
                    el.child(self.draft_picker(
                        DraftPicker::Checkout,
                        "draft-checkout",
                        if draft.worktree {
                            "New worktree".into()
                        } else {
                            state
                                .branches
                                .head_branch
                                .clone()
                                .unwrap_or_else(|| "Current checkout".into())
                        },
                        IconName::GitBranch,
                        self.draft_checkout_menu(cx),
                        cx,
                    ))
                },
            );
        let mut recent = self
            .rows
            .iter()
            .filter(|row| {
                !row.archived
                    && row
                        .navigation_parent(
                            &format!("agent:{}:{}", draft.agent_id, self.sidebar_state.main_key),
                            None,
                        )
                        .is_none()
                    && !row.incognito
                    && row
                        .channel
                        .as_deref()
                        .is_none_or(|channel| channel == "webchat")
                    && row.agent() == Some(draft.agent_id.as_str())
                    && !row.key.ends_with(":main")
            })
            .collect::<Vec<_>>();
        recent.sort_by(|a, b| {
            b.updated_at
                .partial_cmp(&a.updated_at)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        div().id("new-session-page").relative().flex_1().min_w_0().h_full()
            .child(div().id("new-session-scroll").v_flex().items_center().size_full().overflow_y_scroll()
                .pt(px(t::SCROLL_TOP)).px(px(t::SCROLL_PADDING_X)).pb(px(t::SCROLL_BOTTOM))
                .on_drop(cx.listener(|this,paths:&ExternalPaths,_,cx| this.attach_paths(paths.paths().to_vec(),cx)))
                .child(div().v_flex().items_center().gap(px(t::HERO_GAP))
                    .children(agent.map(|agent| div().size(px(t::HERO_AVATAR_SIZE)).h_flex().items_center().justify_center().text_size(px(t::ICON_SIZE)).child(agent.avatar())))
                    .child(div().v_flex().items_center().gap(px(t::CONTROL_GAP))
                        .child(div().text_size(px(t::TITLE_TEXT_SIZE)).line_height(px(t::TITLE_LINE_HEIGHT)).font_weight(t::TITLE_WEIGHT)
                            .child(agent.map(|a|a.name()).unwrap_or("Assistant").to_owned()))
                        .child(div().text_size(px(t::BODY_TEXT_SIZE)).line_height(px(t::HINT_LINE_HEIGHT)).text_color(p.muted).child("Pick where this session works, then say what to do."))))
                .child(div().v_flex().w_full().max_w(px(t::COMPOSER_WIDTH)).mt(px(t::FORM_TOP)).gap(px(t::STACK_GAP))
                    .child(target_row)
                    .when(invalid_name,|el| el.child(div().text_size(px(t::CAPTION_TEXT_SIZE)).text_color(p.danger).px(px(t::NOTICE_INSET)).child("Use lowercase letters, digits, and dashes (up to 64).")))
                    .children(state.error.as_ref().map(|error| div().text_size(px(t::CAPTION_TEXT_SIZE)).text_color(p.danger).child(error.clone())))
                    .when(state.group_failed,|el|el.child(Button::new("retry-group-defaults").ghost().small().label("Retry group defaults")
                        .on_click(cx.listener(|this,_,_,cx|{this.new_session.group_failed=false;this.new_session.group_pending=true;this.load_draft_catalogs(cx);}))))
                    .when(state.error.is_some() && state.completed_key.is_some(), |el| {
                        let key=state.completed_key.clone().unwrap_or_default();
                        el.child(Button::new("open-created-session").ghost().small().label("Open created session")
                            .on_click(cx.listener(move|this,_,window,cx|this.select_session(key.clone(),window,cx))))
                    })
                    .child(composer)
                    .when(incognito, |el| el.child(div().text_size(px(t::CAPTION_TEXT_SIZE)).text_color(p.muted).px(px(t::COMPOSER_INSET)).child(
                        "Keep this session for 24 hours or until the Gateway restarts, whichever comes first"))))
                .when(!incognito && self.composer.read(cx).value().trim().is_empty(), |el| el.child(
                    div().v_flex().w_full().max_w(px(t::RECENT_WIDTH)).mt(px(t::RECENT_TOP)).gap(px(t::CHIP_GAP))
                        .when(!recent.is_empty(), |el| el.child(div().px(px(t::RECENT_ROW_PADDING_X)).text_size(px(t::CAPTION_TEXT_SIZE)).font_weight(t::TITLE_WEIGHT).text_color(p.muted).child("RECENT CHATS")))
                        .children(recent.into_iter().take(5).map(|row| {
                            let key = row.key.clone();
                            Button::new(SharedString::from(format!("draft-recent-{key}"))).ghost().small().h(px(t::RECENT_ROW_HEIGHT)).px(px(t::RECENT_ROW_PADDING_X)).justify_start()
                                .accessibility_label(row.title()).child(div().flex_1().text_left().child(row.title())).on_click(cx.listener(move |this,_,window,cx|this.select_session(key.clone(),window,cx)))
                        })))))
            .child(Button::new("new-session-incognito").ghost().small().absolute().top(px(t::INCOGNITO_INSET)).right(px(t::INCOGNITO_INSET)).size(px(t::INCOGNITO_BUTTON_SIZE))
                .border_1().border_color(p.border).rounded(px(t::INCOGNITO_RADIUS)).child(icons::incognito(if incognito {p.accent} else {p.muted}))
                .when(incognito,|el|el.border_color(p.accent.opacity(t::ACTIVE_BORDER_OPACITY)).bg(p.accent.opacity(t::ACTIVE_BACKGROUND_OPACITY)))
                .text_color(if incognito {p.accent} else {p.muted}).accessibility_label("Incognito")
                .tooltip(if self.draft_admin(){"Keep this session for 24 hours or until the Gateway restarts, whichever comes first"}else{"Incognito requires administrator access"}).disabled(state.locked() || !self.draft_admin())
                .on_click(cx.listener(|this,_,_,cx| {
                    this.new_session.draft.visibility = if this.new_session.draft.visibility == Visibility::Incognito {Visibility::Normal} else {Visibility::Incognito}; cx.notify();
                })))
            .into_any_element()
    }

    fn draft_picker(
        &self,
        kind: DraftPicker,
        id: &'static str,
        label: String,
        icon: IconName,
        content: AnyElement,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let view = cx.entity().downgrade();
        let accessible_label = format!(
            "{}: {label}",
            match kind {
                DraftPicker::Agent => "Agent",
                DraftPicker::Destination => "Environment",
                DraftPicker::Project => "Project",
                DraftPicker::Checkout => "Checkout",
            }
        );
        let trigger = controls::chip(
            SharedString::from(format!("{id}-trigger")),
            label,
            if kind == DraftPicker::Agent {
                div()
                    .text_size(px(t::ICON_SIZE))
                    .child(
                        self.sidebar_state
                            .agents
                            .iter()
                            .find(|a| a.id == self.new_session.draft.agent_id)
                            .map(|a| a.avatar())
                            .unwrap_or_default(),
                    )
                    .into_any_element()
            } else {
                Icon::new(icon).size(px(m::ICON_SIZE)).into_any_element()
            },
            cx,
        )
        .accessibility_label(accessible_label)
        .disabled(self.new_session.locked());
        menu::popover(
            id,
            Anchor::TopLeft,
            self.new_session.picker == Some(kind),
            trigger,
            content,
            move |open, window, cx| {
                let _ = view.update(cx, |this, cx| {
                    if (this.new_session.picker == Some(kind)) == open {
                        return;
                    }
                    this.new_session.picker = open.then_some(kind);
                    if open {
                        this.new_session.search.update(cx, |input, cx| {
                            input.set_placeholder(
                                match kind {
                                    DraftPicker::Agent => "Search agents…",
                                    DraftPicker::Destination => "Search environments",
                                    DraftPicker::Project => "Search projects or paste a Git URL",
                                    DraftPicker::Checkout => "Search branches",
                                },
                                window,
                                cx,
                            );
                            input.set_value("", window, cx);
                        });
                        this.new_session.branch_suggestions = false;
                        this.new_session.browsing = false;
                    }
                    cx.notify();
                });
            },
        )
        .into_any_element()
    }

    fn draft_agent_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let p = Palette::get(cx);
        menu::panel(
            "draft-agents-menu",
            t::AGENT_MENU_WIDTH,
            MenuStyle::Selection,
            cx,
        )
        .gap_0()
        .child(
            div()
                .px(px(m::ROW_PADDING_X))
                .py(px(t::HEADER_PADDING_Y))
                .text_size(px(t::HEADING_TEXT_SIZE))
                .line_height(px(t::HEADER_LINE_HEIGHT))
                .text_color(p.muted)
                .child("AGENTS"),
        )
        .children(self.sidebar_state.agents.iter().map(|agent| {
            let id = agent.id.clone();
            let selected = self.new_session.draft.agent_id == id;
            controls::identity_row(
                SharedString::from(format!("draft-agent-{id}")),
                agent.name().to_owned(),
                self.render_agent_avatar(agent, t::IDENTITY_AVATAR_SIZE, cx),
                selected,
                cx,
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.choose_draft_agent(id.clone(), window, cx)
            }))
        }))
        .into_any_element()
    }

    fn draft_destination_label(&self) -> String {
        match &self.new_session.draft.destination {
            Destination::Local => {
                if self.new_session.gateway_name.is_empty() {
                    "Local".into()
                } else {
                    self.new_session.gateway_name.clone()
                }
            }
            Destination::AutomaticDevice => "Automatic".into(),
            Destination::Device { device_id } => self
                .new_session
                .environments
                .environments
                .iter()
                .find(|e| e.device_id() == Some(device_id.as_str()))
                .and_then(|e| e.label.clone())
                .unwrap_or_else(|| device_id.clone()),
            Destination::Cloud { profile_id, .. } => profile_id.clone(),
        }
    }

    fn draft_destination_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.new_session;
        let query = state.search.read(cx).value().to_lowercase();
        let mut menu = menu::panel(
            "draft-destination-menu",
            t::DESTINATION_MENU_WIDTH,
            MenuStyle::Selection,
            cx,
        )
        .child(
            Input::new(&state.search)
                .small()
                .appearance(false)
                .h(px(m::ROW_HEIGHT))
                .px(px(m::ROW_PADDING_X))
                .rounded(px(t::SEARCH_RADIUS))
                .bg(Palette::get(cx).hover)
                .prefix(Icon::new(IconName::Search).size(px(m::ICON_SIZE)))
                .aria_label("Search environments"),
        )
        .child(title("YOUR DEVICES", cx));
        let devices = state
            .environments
            .environments
            .iter()
            .filter(|e| e.device_id().is_some())
            .collect::<Vec<_>>();
        if devices.len() > 1 {
            menu = menu.child(
                row(
                    "draft-auto",
                    "Choose automatically",
                    matches!(state.draft.destination, Destination::AutomaticDevice),
                    cx,
                )
                .disabled(
                    !devices
                        .iter()
                        .any(|e| self.draft_device_reason(e).is_none()),
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.choose_draft_destination(Destination::AutomaticDevice, cx)
                })),
            );
        }
        if format!("local gateway {}", state.gateway_name)
            .to_lowercase()
            .contains(&query)
        {
            menu = menu.child(
                row(
                    "draft-local",
                    if state.gateway_name.is_empty() {
                        "Local".to_owned()
                    } else {
                        state.gateway_name.clone()
                    },
                    state.draft.destination == Destination::Local,
                    cx,
                )
                .icon(Icon::new(IconName::House).size(px(m::ICON_SIZE)))
                .tooltip("Runs on this Gateway")
                .on_click(cx.listener(|this, _, _, cx| {
                    this.choose_draft_destination(Destination::Local, cx)
                })),
            );
        }
        for device in devices {
            let id = device.device_id().unwrap_or_default().to_owned();
            let label = device.label.clone().unwrap_or_else(|| id.clone());
            if !format!("{label} {id}").to_lowercase().contains(&query) {
                continue;
            }
            let reason = self.draft_device_reason(device);
            menu=menu.child(row(format!("draft-device-{id}"),label,matches!(&state.draft.destination,Destination::Device{device_id} if device_id==&id),cx)
                .icon(Icon::new(IconName::Monitor).size(px(m::ICON_SIZE))).disabled(reason.is_some())
                .tooltip(format!("{}{}",device.platform.as_deref().unwrap_or("Device"),device.worker_slots.as_ref().map(|slots|format!(" · {}/{} slots available",slots.available,slots.total)).unwrap_or_default()))
                .when_some(reason,|el,reason|el.tooltip(reason))
                .on_click(cx.listener(move|this,_,_,cx|this.choose_draft_destination(Destination::Device{device_id:id.clone()},cx))));
        }
        if self.draft_admin() && !state.environments.profiles.is_empty() {
            menu = menu.child(title("CLOUD", cx));
            for profile in &state.environments.profiles {
                if !format!("{} {}", profile.id, profile.provider_id)
                    .to_lowercase()
                    .contains(&query)
                {
                    continue;
                }
                let destination = profile.default_destination();
                let selected = matches!(&state.draft.destination,Destination::Cloud{profile_id,..} if profile_id==&profile.id);
                menu = menu.child(
                    row(
                        format!("draft-cloud-{}", profile.id),
                        profile.id.clone(),
                        selected,
                        cx,
                    )
                    .icon(Icon::new(IconName::Cloud).size(px(m::ICON_SIZE)))
                    .disabled(self.draft_cloud_reason(profile).is_some())
                    .when_some(self.draft_cloud_reason(profile), |el, reason| {
                        el.tooltip(reason)
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.choose_draft_destination(destination.clone(), cx)
                    })),
                );
                if selected {
                    for os in &profile.operating_systems {
                        let mut destination = state.draft.destination.clone();
                        if let Destination::Cloud { os: current, .. } = &mut destination {
                            *current = os.id.clone();
                        }
                        menu=menu.child(row(format!("draft-os-{}",os.id),os.label.clone(),matches!(&state.draft.destination,Destination::Cloud{os:id,..} if id==&os.id),cx)
                            .disabled(os.disabled_reason.is_some()).when_some(os.disabled_reason.clone(),|el,why|el.tooltip(why))
                            .on_click(cx.listener(move|this,_,_,cx|this.choose_draft_destination(destination.clone(),cx))));
                    }
                    for machine in &profile.machines {
                        if machine.os.as_ref().is_some_and(|os|!matches!(&state.draft.destination,Destination::Cloud{os:id,..} if os==id)) {continue;}
                        let mut destination = state.draft.destination.clone();
                        if let Destination::Cloud { machine_class, .. } = &mut destination {
                            *machine_class = machine.id.clone();
                        }
                        menu=menu.child(row(format!("draft-machine-{}",machine.id),machine.label.clone(),matches!(&state.draft.destination,Destination::Cloud{machine_class,..} if machine_class==&machine.id),cx)
                            .tooltip(format!("{} CPUs · {} GB",machine.cpu.unwrap_or_default(),machine.memory_gb.unwrap_or_default()))
                            .on_click(cx.listener(move|this,_,_,cx|this.choose_draft_destination(destination.clone(),cx))));
                    }
                }
            }
        }
        if state.catalog_loading {
            menu = menu.child(title("Loading destinations…", cx));
        }
        menu.into_any_element()
    }

    fn draft_project_label(&self) -> String {
        let draft = &self.new_session.draft;
        if draft.destination.is_remote() && draft.fresh_workspace {
            return "New workspace".into();
        }
        self.new_session
            .projects
            .iter()
            .find(|p| p.id == draft.project_id)
            .map(|p| p.display_name.clone())
            .unwrap_or_else(|| {
                if !draft.project_git_url.is_empty() {
                    draft.project_git_url.clone()
                } else {
                    folder_name(&draft.folder)
                }
            })
    }

    fn draft_project_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.new_session;
        let draft = &state.draft;
        let mut menu = menu::panel(
            "draft-project-menu",
            t::PROJECT_MENU_WIDTH,
            MenuStyle::Selection,
            cx,
        );
        if state.browsing {
            menu =
                menu.child(row("draft-browser-back", "‹ Projects", false, cx).on_click(
                    cx.listener(|this, _, _, cx| {
                        this.new_session.browsing = false;
                        cx.notify();
                    }),
                ))
                .child(
                    Input::new(&state.folder_input)
                        .small()
                        .appearance(false)
                        .aria_label("Folder path"),
                );
            if let Some(listing) = &state.directory {
                if let Some(parent) = listing.parent.clone() {
                    menu = menu.child(row("draft-folder-parent", "..", false, cx).on_click(
                        cx.listener(move |this, _, _, cx| {
                            this.browse_draft_folder(Some(parent.clone()), cx)
                        }),
                    ));
                }
                for entry in &listing.entries {
                    let path = entry.path.clone();
                    menu = menu.child(
                        row(
                            SharedString::from(format!("draft-folder-{path}")),
                            entry.name.clone(),
                            false,
                            cx,
                        )
                        .when(entry.hidden, |el| el.text_color(Palette::get(cx).muted))
                        .icon(Icon::new(IconName::Folder).size(px(m::ICON_SIZE)))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.browse_draft_folder(Some(path.clone()), cx)
                        })),
                    );
                }
                let path = listing.path.clone();
                menu = menu.child(
                    Button::new("draft-use-folder")
                        .primary()
                        .small()
                        .label("Use this folder")
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.choose_draft_folder(path.clone(), window, cx)
                        })),
                );
            }
            if state.directory_loading {
                menu = menu.child(title("Loading…", cx));
            }
            return menu.into_any_element();
        }
        menu = menu.child(title("PROJECTS", cx));
        if draft.destination.is_remote() {
            menu = menu.child(
                row(
                    "draft-new-workspace",
                    "New workspace",
                    draft.fresh_workspace,
                    cx,
                )
                .on_click(cx.listener(|this, _, _, cx| {
                    this.new_session.draft.fresh_workspace = true;
                    this.new_session.draft.project_id.clear();
                    this.new_session.draft.project_git_url.clear();
                    this.new_session.picker = None;
                    cx.notify();
                })),
            );
        }
        if !draft.workspace.is_empty() {
            let folder = draft.workspace.clone();
            menu = menu.child(
                row(
                    "draft-agent-workspace",
                    folder_name(&folder),
                    draft.folder == folder && draft.project_id.is_empty(),
                    cx,
                )
                .icon(Icon::new(IconName::Folder).size(px(m::ICON_SIZE)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.choose_draft_folder(folder.clone(), window, cx)
                })),
            );
        }
        menu = menu.child(
            Input::new(&state.search)
                .small()
                .appearance(false)
                .h(px(m::ROW_HEIGHT))
                .px(px(m::ROW_PADDING_X))
                .border_1()
                .border_color(Palette::get(cx).border)
                .rounded(px(t::SEARCH_RADIUS))
                .bg(Palette::get(cx).bg)
                .aria_label("Search projects or paste a clone URL"),
        );
        let query = state.search.read(cx).value().to_string();
        for project in &state.projects {
            if !format!(
                "{} {} {}",
                project.display_name,
                project.repo_root.as_deref().unwrap_or(""),
                project.origin_url.as_deref().unwrap_or("")
            )
            .to_lowercase()
            .contains(&query.to_lowercase())
            {
                continue;
            }
            let project = project.clone();
            menu = menu.child(
                row(
                    format!("draft-project-{}", project.id),
                    project.display_name.clone(),
                    draft.project_id == project.id,
                    cx,
                )
                .icon(Icon::new(IconName::GitBranch).size(px(m::ICON_SIZE)))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.choose_draft_project(project.clone(), window, cx)
                })),
            );
        }
        if clone_url(&query) {
            let url = query.clone();
            menu = menu.child(
                row("draft-clone-url", format!("Clone {url}"), false, cx).on_click(cx.listener(
                    move |this, _, _, cx| this.choose_remote_draft_project(url.clone(), cx),
                )),
            );
        }
        for project in &state.remote_projects {
            let Some(url) = project["cloneUrl"].as_str().map(str::to_owned) else {
                continue;
            };
            menu = menu.child(
                row(
                    format!("draft-remote-{url}"),
                    project["fullName"].as_str().unwrap_or(&url).to_owned(),
                    false,
                    cx,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.choose_remote_draft_project(url.clone(), cx)
                })),
            );
        }
        menu.child(
            row("draft-browse", "Browse folders", false, cx)
                .icon(Icon::new(IconName::Folder).size(px(m::ICON_SIZE)))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.browse_draft_folder(Some(this.new_session.draft.folder.clone()), cx)
                })),
        )
        .into_any_element()
    }

    fn draft_checkout_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let state = &self.new_session;
        let draft = &state.draft;
        let repository = draft.destination.is_remote() && !draft.project_git_url.is_empty();
        let mut menu = menu::panel(
            "draft-checkout-menu",
            if draft.worktree {
                t::WORKTREE_MENU_WIDTH
            } else {
                t::CHECKOUT_MENU_WIDTH
            },
            MenuStyle::Selection,
            cx,
        )
        .child(title("CHECKOUT", cx));
        if !repository {
            menu = menu
                .child(
                    checkout_option(
                        "draft-current-checkout",
                        "Current checkout",
                        IconName::Folder,
                        state.branches.head_branch.as_deref().unwrap_or(""),
                        !draft.worktree,
                        cx,
                    )
                    .disabled(draft.destination.is_remote())
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.new_session.draft.worktree = false;
                        cx.notify();
                    })),
                )
                .child(
                    checkout_option(
                        "draft-new-worktree",
                        "New worktree",
                        IconName::GitBranch,
                        "Isolated copy of the repo",
                        draft.worktree,
                        cx,
                    )
                    .disabled(
                        state.branches.repository_status.as_deref() != Some("git")
                            && draft.project_git_url.is_empty(),
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.new_session.draft.worktree = true;
                        this.new_session.draft.fresh_workspace = false;
                        cx.notify();
                    })),
                );
        }
        if draft.worktree || repository {
            menu = menu.child(checkout_field(
                "From",
                "Base branch or commit",
                &state.base_ref_input,
                cx,
            ));
            let query = state.base_ref_input.read(cx).value().to_lowercase();
            for branch in state
                .branches
                .branches
                .iter()
                .filter(|b| state.branch_suggestions && b.name.to_lowercase().contains(&query))
                .take(8)
            {
                let name = branch.name.clone();
                menu = menu.child(
                    row(
                        format!("draft-base-{name}"),
                        name.clone(),
                        draft.base_ref == name,
                        cx,
                    )
                    .on_click(cx.listener(move |this, _, window, cx| {
                        this.new_session.draft.base_ref = name.clone();
                        this.new_session.branch_suggestions = false;
                        this.new_session
                            .base_ref_input
                            .update(cx, |input, cx| input.set_value(name.clone(), window, cx));
                        cx.notify();
                    })),
                );
            }
            menu = menu.child(note(
                if state.branches.branches_unavailable {
                    "Branch suggestions are unavailable. Enter a branch or commit."
                } else {
                    "Suggestions are limited. Enter any branch or commit."
                },
                cx,
            ));
            if !repository {
                menu = menu
                    .child(checkout_field(
                        "Name",
                        "New worktree name",
                        &state.worktree_name_input,
                        cx,
                    ))
                    .child(note(
                        worktree_branch_name(&draft.worktree_name)
                            .map(|name| format!("Creates branch {name} in a separate checkout."))
                            .unwrap_or_else(|| {
                                "Creates a branch from the session title in a separate checkout."
                                    .into()
                            }),
                        cx,
                    ));
            }
        }
        if state.branches_loading {
            menu = menu.child(note("Loading branches…", cx));
        }
        menu.into_any_element()
    }
}

fn folder_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("Select folder")
        .to_owned()
}
