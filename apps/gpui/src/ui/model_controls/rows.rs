use super::*;

impl AppView {
    pub(super) fn model_option_row(
        &self,
        target: &ModelControlsTarget,
        menu_row: &PickerMenuRow,
        presentation: PickerRowPresentation,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let PickerAction::Model(option) = &menu_row.action else {
            unreachable!("model row")
        };
        let p = Palette::get(cx);
        let selected = menu_row.selected;
        let target = target.clone();
        let choice = menu_row.clone();
        let status = if option.needs_auth() {
            "Sign in needed"
        } else if option.unavailable_reason.as_deref() == Some("unsupported-runtime") {
            "This harness is unavailable for this model."
        } else if option.disabled {
            "This model is temporarily unavailable."
        } else {
            ""
        };
        let row = crate::ui::components::menu_row(
            SharedString::from(format!(
                "choice-{}-{}",
                option.value,
                option.agent_runtime.as_deref().unwrap_or("base")
            )),
            MenuRowStyle {
                selected,
                highlighted: presentation.highlight,
                disabled: menu_row.disabled,
                emphasized: true,
            },
            p,
        )
        .accessibility_label(
            [
                option.display_label(),
                option.runtime_label(),
                status.to_owned(),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(". "),
        );
        let content = div()
            .h_flex()
            .items_center()
            .w_full()
            .gap(px(t::SPACE_MD))
            .text_size(px(t::TEXT_ROW))
            .child(
                div()
                    .w(px(t::ROW_ICON_SLOT))
                    .h(px(t::ROW_ICON_SLOT))
                    .flex_shrink_0()
                    .when(presentation.searching, |stem| {
                        stem.child(provider_icon(&option.provider, t::ICON_PROVIDER, false, p))
                    }),
            );
        let mut copy = div()
            .h_flex()
            .items_center()
            .min_w_0()
            .flex_1()
            .child(div().truncate().child(option.display_label()));
        if option.is_default {
            copy = copy.child(
                div()
                    .ml(px(t::SPACE_SM))
                    .flex_shrink_0()
                    .text_size(px(t::TEXT_TINY))
                    .font_weight(t::WEIGHT_HEADING)
                    .text_color(p.muted)
                    .child("Default"),
            );
        }
        let meta = option.metadata();
        if !meta.is_empty() {
            copy = copy.child(
                div()
                    .ml(px(t::SPACE_SM))
                    .min_w_0()
                    .truncate()
                    .text_size(px(t::TEXT_META))
                    .font_weight(t::WEIGHT_BODY)
                    .text_color(p.muted)
                    .child(meta),
            );
        }
        if option.needs_auth() {
            copy = copy.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(t::SPACE_COMPACT))
                    .ml(px(t::SPACE_SM))
                    .min_w_0()
                    .text_size(px(t::TEXT_META))
                    .text_color(p.controls().warning)
                    .child(Icon::new(IconName::TriangleAlert).size(px(t::ICON_SMALL)))
                    .child(div().truncate().child(status)),
            );
        }
        if option.supports_tools == Some(false) {
            copy = copy.child(
                Icon::new(IconName::Info)
                    .size(px(t::ICON_PROVIDER))
                    .text_color(p.muted),
            );
        }
        let content = content.child(copy).child(
            div()
                .w(px(t::ROW_ACTION_SLOT))
                .flex_shrink_0()
                .flex()
                .justify_center()
                .child(picker_row_action(selected, presentation.shortcut, p)),
        );
        let help = model_option_help(option);
        row.child(content)
            .element_tooltip(if !help.is_empty() {
                help
            } else if status.is_empty() {
                option.value.clone()
            } else {
                status.into()
            })
            .on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| {
                if let Some(index) = presentation.navigation_index
                    && this.model_controls.highlight != index
                {
                    this.model_controls.highlight = index;
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |this, _, window, cx| {
                this.activate_picker_row(&target, &choice, window, cx);
            }))
            .into_any_element()
    }

    pub(super) fn open_model_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.model_controls.close_popups();
        self.open_control_page("/settings/model-providers", "Models", window, cx);
    }

    pub(super) fn provider_auth_label(&self, provider: &str) -> Option<(IconName, String)> {
        let auth = provider_auth_label(
            provider,
            &self.model_controls.auth,
            self.model_controls.catalog.account_selection.as_ref(),
            &self.picker_options(),
        )?;
        let icon = match auth.kind {
            ProviderAuthKind::Missing => IconName::TriangleAlert,
            ProviderAuthKind::Subscription => IconName::CircleUser,
            ProviderAuthKind::Api => IconName::Key,
        };
        Some((icon, auth.label))
    }

    pub(super) fn provider_header(
        &self,
        group: &PickerGroup,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let provider = group.provider.clone();
        let toggle_provider = provider.clone();
        let open = self.model_controls.expanded_providers.contains(&provider);
        div()
            .h_flex()
            .items_center()
            .gap(px(t::SPACE_MD))
            .px(px(t::SPACE_INSET))
            .h(px(t::SECTION_HEIGHT))
            .text_color(p.muted)
            .child(
                Button::new(SharedString::from(format!("provider-{provider}")))
                    .accessibility_label(format!(
                        "{} models ({})",
                        group.label,
                        group.options.len()
                    ))
                    .ghost()
                    .small()
                    .p_0()
                    .h(px(t::SECTION_HEIGHT))
                    .flex_1()
                    .justify_start()
                    .text_size(px(t::TEXT_SECTION))
                    .font_weight(t::WEIGHT_HEADING)
                    .text_color(p.muted)
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .w_full()
                            .gap(px(t::SPACE_MD))
                            .text_size(px(t::TEXT_SECTION))
                            .font_weight(t::WEIGHT_HEADING)
                            .child(provider_icon(&provider, t::ICON_PROVIDER, false, p))
                            .child(group.label.clone())
                            .child(group.options.len().to_string())
                            .child(
                                Icon::new(if open {
                                    IconName::ChevronUp
                                } else {
                                    IconName::ChevronDown
                                })
                                .size(px(t::ICON_SMALL)),
                            ),
                    )
                    .disabled(disabled)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if !this
                            .model_controls
                            .expanded_providers
                            .remove(&toggle_provider)
                        {
                            this.model_controls
                                .expanded_providers
                                .insert(toggle_provider.clone());
                        }
                        this.reset_model_picker_highlight(cx);
                        cx.notify();
                    })),
            )
            .when_some(self.provider_auth_label(&provider), |row, (icon, label)| {
                row.child(
                    div()
                        .h_flex()
                        .gap(px(t::SPACE_XS))
                        .items_center()
                        .min_w_0()
                        .text_size(px(t::TEXT_SECTION))
                        .child(Icon::new(icon).size(px(t::ICON_META)))
                        .child(div().truncate().child(label)),
                )
            })
            .child(
                Button::new(SharedString::from(format!("configure-{provider}")))
                    .ghost()
                    .xsmall()
                    .p_0()
                    .size(px(t::ICON_BUTTON_SIZE))
                    .icon(Icon::new(IconName::Settings).size(px(t::ICON_SMALL)))
                    .element_tooltip("Configure models")
                    .on_click(
                        cx.listener(|this, _, window, cx| this.open_model_settings(window, cx)),
                    ),
            )
            .into_any_element()
    }

    pub(super) fn account_controls_disabled(&self, target: &ModelControlsTarget) -> bool {
        let account_write = self
            .session
            .as_ref()
            .and_then(|s| s.hello().pointer("/auth/scopes"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|scopes| {
                scopes
                    .iter()
                    .any(|s| s == "operator.write" || s == "operator.admin")
            });
        self.model_controls_disabled_reason().is_some()
            || (target.session_key.is_none() && !account_write)
    }

    pub(super) fn account_header(
        &self,
        target: &ModelControlsTarget,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let label = self
            .model_controls
            .catalog
            .account_selection
            .as_ref()
            .map(|selection| selection.label.clone())
            .unwrap_or_default();
        Button::new("model-accounts-toggle")
            .accessibility_label(format!("Account: {label}"))
            .ghost()
            .small()
            .w_full()
            .min_h(px(t::SECTION_HEIGHT))
            .px(px(t::SPACE_INSET))
            .py(px(t::SPACE_COMPACT))
            .gap(px(t::SPACE_MD))
            .text_color(p.muted)
            .text_size(px(t::TEXT_SECTION))
            .font_weight(t::WEIGHT_HEADING)
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .w_full()
                    .gap(px(t::SPACE_MD))
                    .text_size(px(t::TEXT_SECTION))
                    .font_weight(t::WEIGHT_HEADING)
                    .child(Icon::new(IconName::Users).size(px(t::ICON_PROVIDER)))
                    .child("Account")
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_right()
                            .truncate()
                            .font_weight(t::WEIGHT_BODY)
                            .child(label),
                    )
                    .child(
                        Icon::new(if self.model_controls.accounts_open {
                            IconName::ChevronUp
                        } else {
                            IconName::ChevronDown
                        })
                        .size(px(t::ICON_SMALL)),
                    ),
            )
            .disabled(self.account_controls_disabled(target))
            .on_click(cx.listener(|this, _, _, cx| {
                this.model_controls.accounts_open = !this.model_controls.accounts_open;
                if this.model_controls.accounts_open && this.model_controls.accounts.is_empty() {
                    this.load_model_control_accounts(false, cx);
                }
                this.reset_model_picker_highlight(cx);
                cx.notify();
            }))
            .into_any_element()
    }

    pub(super) fn account_option_row(
        &self,
        target: &ModelControlsTarget,
        row: &PickerMenuRow,
        presentation: PickerRowPresentation,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let choice = row.clone();
        let target = target.clone();
        menu_row(
            SharedString::from(row.key.clone()),
            MenuRowStyle {
                selected: row.selected,
                highlighted: presentation.highlight,
                disabled: row.disabled,
                emphasized: false,
            },
            p,
        )
        .accessibility_label(match &row.description {
            Some(description) => format!("{}. {description}", row.label),
            None => row.label.clone(),
        })
        .child(
            div()
                .h_flex()
                .items_center()
                .w_full()
                .gap(px(t::SPACE_MD))
                .text_size(px(t::TEXT_ROW))
                .font_weight(t::WEIGHT_BODY)
                .child(
                    div()
                        .size(px(t::ROW_ICON_SLOT))
                        .flex_shrink_0()
                        .when(presentation.searching, |stem| {
                            stem.child(Icon::new(IconName::Users).size(px(t::ICON_PROVIDER)))
                        }),
                )
                .child(
                    div()
                        .h_flex()
                        .items_center()
                        .min_w_0()
                        .flex_1()
                        .child(div().truncate().child(row.label.clone()))
                        .when_some(row.description.clone(), |container, description| {
                            container.child(
                                div()
                                    .ml(px(t::SPACE_SM))
                                    .text_size(px(t::TEXT_SECTION))
                                    .text_color(p.muted)
                                    .font_weight(t::WEIGHT_BODY)
                                    .truncate()
                                    .child(description),
                            )
                        }),
                )
                .child(
                    div()
                        .w(px(t::ROW_ACTION_SLOT))
                        .flex_shrink_0()
                        .flex()
                        .justify_center()
                        .child(picker_row_action(row.selected, presentation.shortcut, p)),
                ),
        )
        .on_mouse_move(cx.listener(move |this, _: &MouseMoveEvent, _, cx| {
            if let Some(index) = presentation.navigation_index
                && this.model_controls.highlight != index
            {
                this.model_controls.highlight = index;
                cx.notify();
            }
        }))
        .on_click(cx.listener(move |this, _, window, cx| {
            this.activate_picker_row(&target, &choice, window, cx)
        }))
        .into_any_element()
    }

    pub(super) fn activate_picker_row(
        &mut self,
        target: &ModelControlsTarget,
        row: &PickerMenuRow,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if row.disabled || self.model_controls.target.as_ref() != Some(target) {
            return;
        }
        match &row.action {
            PickerAction::Model(option) => {
                if option.needs_auth() && !option.selectable(self.model_is_pinned()) {
                    self.open_model_settings(window, cx);
                } else {
                    self.apply_model_control_patch(
                        target.clone(),
                        selection_patch(option, None),
                        cx,
                    );
                }
            }
            PickerAction::Account(profile) => {
                let reference = self.model_controls_model_reference();
                self.apply_model_control_patch(
                    target.clone(),
                    json!({"model":format!("{}@{profile}",split_model_auth_profile(&reference).0)}),
                    cx,
                );
            }
            PickerAction::Automatic => self.clear_draft_model_account(cx),
            PickerAction::MoreAccounts => self.load_model_control_accounts(true, cx),
            PickerAction::ManageAccounts => {
                self.model_controls.close_popups();
                self.open_control_page("/settings/profile", "Profile", window, cx);
            }
            PickerAction::CurrentAccount | PickerAction::Loading => {}
        }
        cx.stop_propagation();
    }
}
