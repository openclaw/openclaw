use super::*;

impl AppView {
    pub(super) fn draft_picker(
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
        let trigger = chip(
            SharedString::from(format!("{id}-trigger")),
            accessible_label,
            ChipStyle::Draft,
            Palette::get(cx),
        )
        .child(
            div()
                .h_flex()
                .items_center()
                .gap(px(t::CONTROL_GAP))
                .child(if kind == DraftPicker::Agent {
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
                })
                .child(label),
        )
        .dropdown_caret(true)
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

    pub(super) fn draft_agent_menu(&self, cx: &mut Context<Self>) -> AnyElement {
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
            menu::identity_row(
                SharedString::from(format!("draft-agent-{id}")),
                agent.name().to_owned(),
                self.render_agent_avatar(
                    agent,
                    crate::ui::theme::tokens::avatar::DRAFT_IDENTITY,
                    cx,
                ),
                selected,
                cx,
            )
            .on_click(cx.listener(move |this, _, window, cx| {
                this.choose_draft_agent(id.clone(), window, cx)
            }))
        }))
        .into_any_element()
    }

    pub(super) fn draft_destination_label(&self) -> String {
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

    pub(super) fn draft_destination_menu(&self, cx: &mut Context<Self>) -> AnyElement {
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
}
