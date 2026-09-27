use super::*;

impl AppView {
    pub(super) fn context_options(&self) -> Option<ContextSelection> {
        let row = self.model_controls_row()?;
        let draft = self
            .model_controls
            .target
            .as_ref()
            .is_some_and(|target| target.session_key.is_none());
        context_selection(&row, draft, self.model_capabilities().as_ref())
    }

    pub(super) fn context_control(
        &self,
        target: &ModelControlsTarget,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let ContextSelection {
            mut options,
            selected,
            ..
        } = self.context_options()?;
        let p = Palette::get(cx);
        let label = options.iter().find(|o| o.id == selected)?.label.clone();
        let disabled = self.model_controls_disabled_reason().is_some()
            || self
                .model_controls_access_reason(&json!({"contextWindow":null}))
                .is_some();
        let mut row = setting_row(IconName::ScrollText, "Context window", &label, p);
        if options.len() == 2 {
            options.sort_by_key(|o| o.context_window);
            let active = selected == options[1].id;
            let next = options[usize::from(!active)].id.clone();
            let target = target.clone();
            row = row.child(
                toggle(
                    "context-window-toggle",
                    "Context window",
                    active,
                    disabled,
                    p,
                )
                .accessibility_label(format!("Context window: {label}"))
                .on_change({
                    let owner = cx.entity().downgrade();
                    move |_, _, _, cx| {
                        let _ = owner.update(cx, |this, cx| {
                            this.apply_model_control_patch(
                                target.clone(),
                                json!({"contextWindow":next}),
                                cx,
                            )
                        });
                    }
                }),
            );
        } else {
            row = row.child(div().h_flex().gap(rems(t::REM_SPACE_XS)).children(
                options.into_iter().enumerate().map(|(index, option)| {
                    let target = target.clone();
                    Button::new(("context-window", index))
                        .ghost()
                        .xsmall()
                        .label(option.label)
                        .when(option.id == selected, |b| b.bg(p.hover))
                        .disabled(disabled)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.apply_model_control_patch(
                                target.clone(),
                                json!({"contextWindow":option.id}),
                                cx,
                            )
                        }))
                }),
            ));
        }
        Some(row.into_any_element())
    }

    pub(super) fn thinking_picker(
        &self,
        target: &ModelControlsTarget,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let model = self.model_capabilities();
        let row = self.model_controls_row().unwrap_or_default();
        let reference = self.model_controls_model_reference();
        let provider = reference
            .split_once('/')
            .map(|(p, _)| p)
            .unwrap_or_default();
        let fast = fast_mode_state(
            model.as_ref(),
            provider,
            row.fast_mode,
            row.effective_fast_mode,
        );
        let thinking = self.thinking_selection();
        let options = self.picker_options();
        let selection = self.picker_selection_value();
        let runtime = self.model_runtime();
        let active_option = options
            .iter()
            .find(|option| option.selected(&selection, runtime.as_deref()));
        let ready = self.session.is_some()
            && self.model_controls.has_snapshot
            && !self.model_controls.loading
            && self.model_controls.error.is_none();
        let has_resolvable_model = ready
            && active_option.is_none_or(|option| !option.disabled)
            && options.iter().any(|option| !option.disabled);
        let loading_without_snapshot = !self.model_controls.has_snapshot
            && self.session.is_some()
            && self.model_controls.error.is_none();
        let reserved =
            !has_resolvable_model && (loading_without_snapshot || self.model_controls.model_open);
        if (!has_resolvable_model && !reserved)
            || (reserved && !self.model_controls.model_open)
            || (!reserved && thinking.options.is_empty() && !fast.supported)
        {
            return None;
        }
        let p = Palette::get(cx);
        let common_disabled = self.model_controls_disabled_reason().is_some()
            || self
                .model_controls_access_reason(&json!({"thinkingLevel":null}))
                .is_some();
        let fast_disabled = common_disabled || !fast.supported;
        let disabled =
            reserved || common_disabled || (thinking.options.is_empty() && fast_disabled);
        let thinking_disabled = common_disabled
            || !self.model_controls.has_snapshot
            || (thinking.options.is_empty() && !thinking.override_active);
        let label = if thinking.options.is_empty() {
            "Fast mode".to_owned()
        } else {
            thinking.label.trim_start_matches("Inherited: ").to_owned()
        };
        let owner = cx.entity().downgrade();
        let accessible_label = if thinking.options.is_empty() {
            format!("Fast mode: {}", fast.label)
        } else {
            format!("Thinking level: {label}")
        };
        let trigger = chip("effort-trigger", accessible_label, ChipStyle::Model, p)
            .disabled(disabled)
            .element_tooltip(format!("Thinking level: {label}"));
        let mut content = div()
            .h_flex()
            .items_center()
            .gap(px(t::SPACE_XS))
            .text_size(px(t::TEXT_CHIP))
            .line_height(px(t::CHIP_LINE_HEIGHT));
        if fast.active {
            content = content.child(
                div()
                    .mr(px(t::SPACE_TINY))
                    .flex_shrink_0()
                    .child(filled_zap(t::ICON, p.accent)),
            );
        }
        content = content.child(label).child(
            Icon::new(if self.model_controls.effort_open {
                IconName::ChevronUp
            } else {
                IconName::ChevronDown
            })
            .size(px(t::ICON_SMALL))
            .text_color(p.muted),
        );
        if reserved {
            return Some(
                div()
                    .invisible()
                    .flex_shrink_0()
                    .child(trigger.child(content))
                    .into_any_element(),
            );
        }
        let mut menu = div().v_flex().w(px(t::EFFORT_MENU_WIDTH));
        if !thinking.options.is_empty() {
            let preview = self
                .model_controls
                .effort_preview
                .and_then(|index| thinking.options.get(index));
            let value = preview
                .map(|o| o.label.clone())
                .unwrap_or_else(|| thinking.label.trim_start_matches("Inherited: ").into());
            let mut panel = div()
                .v_flex()
                .gap(px(t::SPACE_XS))
                .px(px(t::SPACE_LG))
                .pt(px(t::SPACE_LG))
                .pb(px(t::SPACE_SECTION_Y))
                .bg(p.controls().search)
                .child(
                    div()
                        .h_flex()
                        .justify_between()
                        .mb(px(t::SPACE_INSET))
                        .gap(px(t::SPACE_MD))
                        .text_size(px(t::TEXT_LABEL))
                        .font_weight(t::WEIGHT_LABEL)
                        .child("Effort")
                        .child(div().text_color(p.accent).child(value)),
                );
            if thinking.options.len() > 1 {
                panel = panel
                    .child(self.reasoning_slider(&thinking, thinking_disabled, cx))
                    .child(
                        div()
                            .h_flex()
                            .justify_between()
                            .mx(px(t::SPACE_SM))
                            .mb(px(t::SPACE_TINY))
                            .text_size(px(t::TEXT_META))
                            .text_color(p.muted)
                            .font_weight(t::WEIGHT_SCALE)
                            .child("Faster")
                            .child("Smarter"),
                    );
            } else {
                let stop = thinking.options[0].clone();
                let target = target.clone();
                panel = panel.child(
                    Button::new("thinking-only-stop")
                        .small()
                        .label(stop.label)
                        .disabled(thinking_disabled)
                        .when(thinking.selected_index == Some(0), |b| {
                            b.icon(IconName::Check)
                        })
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if this.thinking_selection().selected_index == Some(0) {
                                return;
                            }
                            this.apply_model_control_patch(
                                target.clone(),
                                json!({"thinkingLevel":stop.value}),
                                cx,
                            )
                        })),
                );
            }
            menu = menu.child(panel);
        }
        let target = target.clone();
        let next = fast.next;
        menu = menu.child(
            setting_row(
                IconName::Zap,
                "Fast mode",
                "Faster responses, higher usage of limits.",
                p,
            )
            .child(
                toggle(
                    "fast-mode-toggle",
                    "Fast responses",
                    fast.active,
                    fast_disabled,
                    p,
                )
                .accessibility_label(format!("Fast responses: {}", fast.label))
                .element_tooltip(if fast.supported {
                    format!("Fast responses: {}", fast.label)
                } else {
                    "Speed control is not supported for this model.".into()
                })
                .on_change({
                    let owner = cx.entity().downgrade();
                    move |_, _, _, cx| {
                        let _ = owner.update(cx, |this, cx| {
                            this.apply_model_control_patch(
                                target.clone(),
                                json!({"fastMode":next}),
                                cx,
                            )
                        });
                    }
                }),
            ),
        );
        Some(
            popover(
                "effort-picker",
                Anchor::BottomRight,
                self.model_controls.effort_open,
                trigger.child(content),
                menu_surface(p).child(menu).into_any_element(),
                move |open, _, cx| {
                    let _ = owner.update(cx, |this, cx| {
                        this.model_controls.effort_open =
                            open && this.model_controls_disabled_reason().is_none();
                        this.model_controls.model_open = false;
                        this.model_controls.effort_preview = None;
                        cx.notify();
                    });
                },
            )
            .bottom(px(t::POPOVER_OFFSET))
            .track_focus(&self.model_controls.effort_focus)
            .into_any_element(),
        )
    }

    pub(super) fn reasoning_slider(
        &self,
        thinking: &ThinkingState,
        disabled: bool,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let maximum = thinking.options.iter().rposition(|option| {
            option.label != "On"
                && matches!(
                    option.value.as_str(),
                    "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                )
        });
        let config = DiscreteSliderConfig {
            stops: thinking
                .options
                .iter()
                .enumerate()
                .map(|(index, option)| SliderStop {
                    boost: if option.value == "ultra" {
                        Some(SliderBoost::Ultra)
                    } else if maximum == Some(index) {
                        Some(SliderBoost::Maximum)
                    } else {
                        None
                    },
                })
                .collect(),
            selected: thinking.selected_index,
            preview: self.model_controls.effort_preview,
            inherited: !thinking.override_active,
            disabled,
            label: "Thinking level",
            description: if thinking.override_active {
                thinking.label.clone()
            } else {
                format!("Default ({})", thinking.inherited_label)
            },
        };
        let target = self.model_controls.target.clone();
        let preview_target = target.clone();
        let id = SharedString::from(format!(
            "thinking-slider:{}",
            target
                .as_ref()
                .map(|target| json!([target.agent_id, target.session_key, target.draft_id]))
                .unwrap_or_default()
        ));
        DiscreteSlider::new(id, config, &self.model_controls.effort_focus)
            .on_preview(cx.listener(move |this, index, _, cx| {
                if this.model_controls.target == preview_target {
                    this.model_controls.effort_preview = Some(*index);
                    cx.notify();
                }
            }))
            .on_commit(cx.listener(move |this, index, _, cx| {
                if this.model_controls.target == target {
                    this.commit_effort(*index, cx);
                }
            }))
            .into_any_element()
    }

    pub(super) fn commit_effort(&mut self, index: usize, cx: &mut Context<Self>) {
        self.model_controls.effort_preview = None;
        let thinking = self.thinking_selection();
        if let Some(stop) = thinking.options.get(index)
            && (!thinking.override_active || thinking.value != stop.value)
            && let Some(target) = self.model_controls.target.clone()
        {
            self.apply_model_control_patch(target, json!({"thinkingLevel":stop.value}), cx);
        }
        cx.notify();
    }
}
