mod effort;
mod keyboard;
mod rows;

use super::{
    AppView,
    components::*,
    theme::{Palette, controls as t},
};
use crate::{
    gateway::composer_rpc::ModelChoice,
    model::{model_controls::*, model_picker::*},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::Input,
        tooltip::Tooltip,
    },
    prelude::FluentBuilder as _,
    *,
};
use serde_json::json;

struct PickerRowPresentation {
    highlight: bool,
    searching: bool,
    shortcut: Option<usize>,
    navigation_index: Option<usize>,
}

impl AppView {
    /// Call set_model_controls_target when routing changes; the same view serves a session or draft.
    pub(super) fn model_controls_view(
        &self,
        target: &ModelControlsTarget,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        if self.model_controls.target.as_ref() != Some(target) {
            return div().into_any_element();
        }
        div()
            .h_flex()
            .items_center()
            .min_w_0()
            .gap(px(t::SPACE_XS))
            .child(self.model_picker(target, window, cx))
            .children(self.thinking_picker(target, cx))
            .into_any_element()
    }

    fn picker_options(&self) -> Vec<PickerOption> {
        if !self.model_controls.has_snapshot {
            return Vec::new();
        }
        let row = self.model_controls_row().unwrap_or_default();
        let mut options = build_picker_options(
            &self.model_controls.catalog.models,
            &self.model_controls_default_reference(),
            &self.model_controls_model_reference(),
            row.runtime_selection_locked,
            self.model_is_pinned(),
            self.model_controls
                .catalog
                .model_selection_policy
                .as_ref()
                .is_some_and(|p| p.restricted),
        );
        if !self.model_controls.pending {
            let current = self.model_controls_model_reference();
            for option in &mut options {
                if option.value == current
                    && row
                        .agent_runtime
                        .as_ref()
                        .is_some_and(|r| Some(&r.id) == option.agent_runtime_id.as_ref())
                {
                    option.context_tokens = row.context_tokens.map(|v| v as u64);
                }
            }
        }
        options
    }

    fn model_is_pinned(&self) -> bool {
        self.model_controls
            .target
            .as_ref()
            .is_some_and(|t| t.session_key.is_some())
            && self.model_controls_row().is_some_and(|row| {
                row.model_override_source.as_deref() == Some("user")
                    || (!row.runtime_selection_locked
                        && row.agent_runtime.as_ref().is_some_and(|r| {
                            matches!(r.source.as_str(), "session" | "session-key")
                        }))
            })
    }

    fn model_runtime(&self) -> Option<String> {
        self.model_controls_row()
            .and_then(|r| r.agent_runtime.map(|r| r.id))
            .or_else(|| {
                find_catalog_entry(
                    &self.model_controls.catalog.models,
                    &self.model_controls_model_reference(),
                )
                .and_then(|m| m.agent_runtime.as_ref().map(|r| r.id.clone()))
            })
    }

    fn model_capabilities(&self) -> Option<ModelChoice> {
        let reference = self.model_controls_model_reference();
        let entry = find_catalog_entry(&self.model_controls.catalog.models, &reference)?;
        resolve_runtime_entry(entry, self.model_runtime().as_deref())
    }

    fn thinking_selection(&self) -> ThinkingState {
        let row = self.model_controls_row().unwrap_or_default();
        let defaults =
            serde_json::from_value(self.model_controls.defaults.clone()).unwrap_or_default();
        project_thinking(&row, &defaults, self.model_capabilities().as_ref())
    }

    fn picker_selection_value(&self) -> String {
        let row = self.model_controls_row().unwrap_or_default();
        if row.model_override_source.is_none()
            && row
                .agent_runtime
                .as_ref()
                .is_none_or(|runtime| !matches!(runtime.source.as_str(), "session" | "session-key"))
        {
            String::new()
        } else {
            self.model_controls_model_reference()
        }
    }

    fn picker_menu_entries(&self, target: &ModelControlsTarget, cx: &App) -> Vec<PickerMenuEntry> {
        let reference = self.model_controls_model_reference();
        menu_entries(MenuProjection {
            options: &self.picker_options(),
            selection: &self.picker_selection_value(),
            runtime: self.model_runtime().as_deref(),
            query: &self.model_controls.search.read(cx).value(),
            expanded_providers: &self.model_controls.expanded_providers,
            locked: self
                .model_controls_row()
                .is_some_and(|row| row.model_selection_locked),
            disabled: self.model_controls_disabled_reason().is_some(),
            pinned: self.model_is_pinned(),
            accounts_open: self.model_controls.accounts_open,
            accounts: self
                .model_controls
                .catalog
                .account_selection
                .as_ref()
                .map(|selection| AccountInventory {
                    selection,
                    accounts: &self.model_controls.accounts,
                    auth: &self.model_controls.auth,
                    model_reference: &reference,
                    disabled: self.account_controls_disabled(target),
                    automatic: target.session_key.is_none()
                        && self
                            .model_controls_draft_patch(target)
                            .get("model")
                            .and_then(serde_json::Value::as_str)
                            .is_some_and(|value| split_model_auth_profile(value).1.is_some()),
                    loading: self.model_controls.accounts_loading,
                    has_more: self.model_controls.account_next_cursor.is_some(),
                }),
            account_error: self.model_controls.accounts_error.as_deref(),
        })
    }

    pub(super) fn reset_model_picker_highlight(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.model_controls.target.as_ref() else {
            return;
        };
        let entries = self.picker_menu_entries(target, cx);
        let selectable = entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| match entry {
                PickerMenuEntry::Row(row) if !row.disabled => Some((index, row)),
                _ => None,
            })
            .collect::<Vec<_>>();
        let selected = if self
            .model_controls
            .search
            .read(cx)
            .value()
            .trim()
            .is_empty()
        {
            selectable
                .iter()
                .position(|(_, row)| row.selected)
                .unwrap_or(0)
        } else {
            0
        };
        self.model_controls.highlight = selected;
        if let Some((index, _)) = selectable.get(selected) {
            self.model_controls.menu_scroll.scroll_to_item(*index);
        }
    }

    fn model_picker(
        &self,
        target: &ModelControlsTarget,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let p = Palette::get(cx);
        let row = self.model_controls_row().unwrap_or_default();
        let options = self.picker_options();
        let restricted = self
            .model_controls
            .catalog
            .model_selection_policy
            .as_ref()
            .is_some_and(|policy| policy.restricted);
        let raw_reference = self.model_controls_model_reference();
        let reference = if restricted
            && find_catalog_entry(&self.model_controls.catalog.models, &raw_reference).is_none()
        {
            String::new()
        } else {
            raw_reference
        };
        let default_reference = self.model_controls_default_reference();
        let runtime = self.model_runtime();
        let selection_value = self.picker_selection_value();
        let selected = options
            .iter()
            .find(|o| o.selected(&selection_value, runtime.as_deref()));
        let active = row
            .active_model
            .as_ref()
            .zip(row.active_model_provider.as_ref())
            .filter(|(model, provider)| !model.trim().is_empty() && !provider.trim().is_empty())
            .map(|(model, provider)| format!("{provider}/{model}"))
            .filter(|reference| {
                !restricted
                    || find_catalog_entry(&self.model_controls.catalog.models, reference).is_some()
            });
        let label_option = active
            .as_ref()
            .filter(|_| !self.model_controls.pending)
            .and_then(|active| options.iter().find(|o| &o.value == active))
            .or(selected);
        let locked_without_model = row.model_selection_locked
            && row
                .model
                .as_deref()
                .is_none_or(|model| model.trim().is_empty())
            && active.is_none();
        let trigger_status = if row.model_selection_locked {
            None
        } else if restricted && reference.is_empty() && default_reference.is_empty() {
            Some(if options.is_empty() {
                "No models are permitted by your administrator."
            } else {
                "Choose a model"
            })
        } else if self.session.is_none() {
            None
        } else if self.model_controls.error.is_some() && options.is_empty() {
            Some("Models unavailable")
        } else if !self.model_controls.has_snapshot
            && self.model_controls.loading
            && reference.is_empty()
        {
            Some("Loading models…")
        } else if self.model_controls.has_snapshot && options.is_empty() {
            Some("No models available")
        } else {
            None
        };
        let label = if locked_without_model {
            "Session model".into()
        } else if let Some(status) = trigger_status {
            status.into()
        } else {
            label_option
                .map(|option| option.label.clone())
                .unwrap_or_else(|| {
                    if !reference.is_empty() {
                        reference.clone()
                    } else {
                        "Default model".into()
                    }
                })
        };
        let disabled_reason = self.model_controls_disabled_reason();
        let disabled = disabled_reason.is_some();
        let query = self
            .model_controls
            .search
            .read(cx)
            .value()
            .trim()
            .to_lowercase();
        let entries = self.picker_menu_entries(target, cx);
        let search_focused = self
            .model_controls
            .search
            .focus_handle(cx)
            .is_focused(window);
        let mut menu = div()
            .id("model-menu-content")
            .key_context("ModelPicker")
            .v_flex()
            .w(px(t::MODEL_MENU_WIDTH))
            .max_h(px(t::MENU_MAX_HEIGHT))
            .overflow_hidden()
            .track_focus(&self.model_controls.menu_focus)
            .capture_key_down(cx.listener(Self::model_picker_key_down))
            .capture_action(cx.listener(
                |this, _: &gpui_kit::base::actions::Confirm, window, cx| {
                    this.confirm_model_picker(window, cx)
                },
            ))
            .capture_action(cx.listener(
                |this, _: &gpui_kit::component::input::Enter, window, cx| {
                    this.confirm_model_picker(window, cx)
                },
            ))
            .capture_action(
                cx.listener(|this, _: &gpui_kit::base::actions::Cancel, window, cx| {
                    this.escape_model_picker(window, cx)
                }),
            )
            .capture_action(cx.listener(
                |this, _: &gpui_kit::component::input::Escape, window, cx| {
                    this.escape_model_picker(window, cx)
                },
            ))
            .capture_action(cx.listener(
                |this, _: &gpui_kit::component::input::MoveDown, window, cx| {
                    this.move_model_picker(1, window, cx)
                },
            ))
            .capture_action(cx.listener(
                |this, _: &gpui_kit::component::input::MoveUp, window, cx| {
                    this.move_model_picker(-1, window, cx)
                },
            ));
        if row.model_selection_locked {
            menu = menu.child(
                div()
                    .h_flex()
                    .gap(rems(t::REM_SPACE_SM))
                    .p(rems(t::REM_SPACE_SM))
                    .text_size(px(t::TEXT_LABEL))
                    .child(label.clone())
                    .child(div().text_size(px(t::TEXT_META)).child("LOCKED")),
            );
        } else {
            menu = menu.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(t::SPACE_SEARCH))
                    .m(px(t::SPACE_MD))
                    .px(px(t::SPACE_INSET))
                    .h(px(t::SEARCH_HEIGHT))
                    .flex_shrink_0()
                    .border_1()
                    .border_color(p.controls().search_border)
                    .rounded(px(t::SEARCH_RADIUS))
                    .bg(p.controls().search)
                    .child(
                        Icon::new(IconName::Search)
                            .size(px(t::ICON))
                            .text_color(p.muted),
                    )
                    .child(
                        Input::new(&self.model_controls.search)
                            .appearance(false)
                            .bordered(false)
                            .text_size(px(t::TEXT_LABEL))
                            .h(px(t::SEARCH_INPUT_HEIGHT))
                            .p_0()
                            .flex_1(),
                    ),
            );
            if let Some(error) = &self.model_controls.error {
                menu = menu.child(
                    div()
                        .px(rems(t::REM_SPACE_MD))
                        .py(rems(t::REM_SPACE_SM))
                        .text_size(px(t::TEXT_LABEL))
                        .text_color(p.muted)
                        .child(error.clone()),
                );
            } else if options.is_empty() {
                menu = menu.child(
                    div()
                        .min_h(px(t::EMPTY_HEIGHT))
                        .p(rems(t::REM_SPACE_LG))
                        .text_size(px(t::TEXT_LABEL))
                        .text_color(p.muted)
                        .child(if self.model_controls.loading {
                            "Loading models…"
                        } else {
                            "No models available"
                        }),
                );
            }
        }
        let mut rows = div()
            .id("model-options")
            .v_flex()
            .min_h_0()
            .overflow_y_scroll()
            .track_scroll(&self.model_controls.menu_scroll)
            .px(px(t::SPACE_SEARCH))
            .pb(px(t::SPACE_SEARCH))
            .gap(px(t::SPACE_TINY));
        let selectable_count = entries
            .iter()
            .filter(|entry| matches!(entry, PickerMenuEntry::Row(row) if !row.disabled))
            .count();
        let highlight = self
            .model_controls
            .highlight
            .min(selectable_count.saturating_sub(1));
        let mut navigation_index = 0;
        let has_rows = entries
            .iter()
            .any(|entry| matches!(entry, PickerMenuEntry::Row(_)));
        for entry in entries {
            rows = rows.child(match entry {
                PickerMenuEntry::Provider(group) => self.provider_header(&group, disabled, cx),
                PickerMenuEntry::Accounts => self.account_header(target, cx),
                PickerMenuEntry::AccountError(error) => div()
                    .px(rems(t::REM_SPACE_SM))
                    .py(rems(t::REM_SPACE_XS))
                    .text_size(px(t::TEXT_LABEL))
                    .text_color(p.danger)
                    .child(error)
                    .into_any_element(),
                PickerMenuEntry::Row(row) => {
                    let index = if row.disabled {
                        None
                    } else {
                        let index = navigation_index;
                        navigation_index += 1;
                        Some(index)
                    };
                    let presentation = PickerRowPresentation {
                        highlight: index == Some(highlight),
                        searching: !query.is_empty(),
                        shortcut: index
                            .filter(|index| *index < 9 && !search_focused)
                            .map(|index| index + 1),
                        navigation_index: index,
                    };
                    match &row.action {
                        PickerAction::Model(_) => {
                            self.model_option_row(target, &row, presentation, cx)
                        }
                        _ => self.account_option_row(target, &row, presentation, cx),
                    }
                }
            });
        }
        if !query.is_empty() && !has_rows {
            rows = rows.child(
                div()
                    .min_h(px(t::SEARCH_EMPTY_HEIGHT))
                    .p(rems(t::REM_SPACE_MD))
                    .text_size(px(t::TEXT_LABEL))
                    .text_color(p.muted)
                    .child("No models match your search"),
            );
        }
        menu = menu.child(rows).children(self.context_control(target, cx));
        let control_target = target.clone();
        let owner = cx.entity().downgrade();
        let trigger = chip(
            "model-picker-trigger",
            format!("Model: {label}"),
            ChipStyle::Model,
            p,
        )
        .track_focus(&self.model_controls.trigger_focus)
        .min_w(px(t::CHIP_MIN_WIDTH))
        .max_w(px(t::CHIP_MAX_WIDTH))
        .disabled(disabled)
        .element_tooltip(disabled_reason.unwrap_or_else(|| {
            if restricted {
                "Your administrator centrally configures the models available here.".into()
            } else {
                "Selecting a model changes only this session.".into()
            }
        }));
        let mut content = div()
            .h_flex()
            .items_center()
            .gap(px(t::SPACE_XS))
            .min_w_0()
            .text_size(px(t::TEXT_CHIP))
            .line_height(px(t::CHIP_LINE_HEIGHT));
        if let Some(option) =
            label_option.filter(|_| trigger_status.is_none() && !locked_without_model)
        {
            if option.supports_tools == Some(false) {
                content = content.child(
                    div()
                        .id("model-chat-only-badge")
                        .h_flex()
                        .items_center()
                        .flex_shrink_0()
                        .gap(px(t::SPACE_XS))
                        .child(Icon::new(IconName::TriangleAlert).size(px(t::ICON)))
                        .child("Chat only")
                        .tooltip(|window, cx| Tooltip::new(CHAT_ONLY_HELP).build(window, cx)),
                );
            }
            if provider_icon_name(&option.provider).is_some() {
                content = content.child(
                    div()
                        .mr(px(t::SPACE_TINY))
                        .flex_shrink_0()
                        .child(provider_icon(&option.provider, t::ICON_TRIGGER, true, p)),
                );
            }
        }
        content = content.child(div().min_w_0().truncate().child(label));
        if let Some(ContextSelection {
            options: windows,
            selected: chosen,
            default,
        }) = self.context_options()
            && chosen != default
            && let Some(option) = windows.iter().find(|o| o.id == chosen)
        {
            content = content.child(
                div()
                    .px(rems(t::REM_SPACE_XS))
                    .rounded_full()
                    .bg(p.hover)
                    .text_size(px(t::TEXT_META))
                    .child(option.label.clone()),
            );
        }
        content = content.child(
            Icon::new(if self.model_controls.model_open {
                IconName::ChevronUp
            } else {
                IconName::ChevronDown
            })
            .size(px(t::ICON_SMALL))
            .text_color(p.muted),
        );
        popover(
            "model-picker",
            Anchor::BottomRight,
            self.model_controls.model_open,
            trigger.child(content),
            menu_surface(p).child(menu).into_any_element(),
            move |open, window, cx| {
                let _ = owner.update(cx, |this, cx| {
                    if this.model_controls_disabled_reason().is_some() {
                        this.model_controls.model_open = false;
                        return;
                    }
                    this.model_controls.model_open = open;
                    this.model_controls.effort_open = false;
                    this.model_controls.accounts_open = false;
                    this.model_controls.expanded_providers.clear();
                    this.model_controls.highlight = 0;
                    this.model_controls
                        .menu_scroll
                        .set_offset(point(px(0.), px(0.)));
                    this.model_controls
                        .search
                        .update(cx, |search, cx| search.set_value("", window, cx));
                    if open {
                        this.load_model_controls(control_target.clone(), cx);
                    }
                    cx.notify();
                });
            },
        )
        .bottom(px(t::POPOVER_OFFSET))
        .track_focus(&self.model_controls.menu_focus)
        .into_any_element()
    }
}
