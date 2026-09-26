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
        let trigger = composer_chip("model-picker-trigger", format!("Model: {label}"), p)
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
        control_popover(
            "model-picker",
            self.model_controls.model_open,
            &self.model_controls.menu_focus,
            trigger.child(content),
            move |open, window, cx| {
                let _ = owner.update(cx, |this, cx| {
                    if this.model_controls_disabled_reason().is_some() {
                        this.model_controls.model_open = false;
                        return;
                    }
                    this.model_controls.model_open = *open;
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
                    if *open {
                        this.load_model_controls(control_target.clone(), cx);
                    }
                    cx.notify();
                });
            },
        )
        .child(menu_surface(p).child(menu))
        .into_any_element()
    }

    fn model_option_row(
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
        let row = super::components::menu_row(
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

    fn open_model_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.model_controls.close_popups();
        self.open_control_page("/settings/model-providers", "Models", window, cx);
    }

    fn provider_auth_label(&self, provider: &str) -> Option<(IconName, String)> {
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

    fn provider_header(
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

    fn account_controls_disabled(&self, target: &ModelControlsTarget) -> bool {
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

    fn account_header(&self, target: &ModelControlsTarget, cx: &mut Context<Self>) -> AnyElement {
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

    fn account_option_row(
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

    fn activate_picker_row(
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

    fn context_options(&self) -> Option<ContextSelection> {
        let row = self.model_controls_row()?;
        let draft = self
            .model_controls
            .target
            .as_ref()
            .is_some_and(|target| target.session_key.is_none());
        context_selection(&row, draft, self.model_capabilities().as_ref())
    }

    fn context_control(
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

    fn thinking_picker(
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
        let trigger = composer_chip("effort-trigger", accessible_label, p)
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
            control_popover(
                "effort-picker",
                self.model_controls.effort_open,
                &self.model_controls.effort_focus,
                trigger.child(content),
                move |open, _, cx| {
                    let _ = owner.update(cx, |this, cx| {
                        this.model_controls.effort_open =
                            *open && this.model_controls_disabled_reason().is_none();
                        this.model_controls.model_open = false;
                        this.model_controls.effort_preview = None;
                        cx.notify();
                    });
                },
            )
            .child(menu_surface(p).child(menu))
            .into_any_element(),
        )
    }

    fn reasoning_slider(
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

    fn commit_effort(&mut self, index: usize, cx: &mut Context<Self>) {
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

    fn model_picker_choices(&self, cx: &App) -> Vec<(usize, PickerMenuRow)> {
        self.model_controls
            .target
            .as_ref()
            .map(|target| {
                self.picker_menu_entries(target, cx)
                    .into_iter()
                    .enumerate()
                    .filter_map(|(index, entry)| match entry {
                        PickerMenuEntry::Row(row) if !row.disabled => Some((index, row)),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn picker_is_composing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        self.model_controls
            .search
            .focus_handle(cx)
            .is_focused(window)
            && self.model_controls.search.update(cx, |search, cx| {
                search.marked_text_range(window, cx).is_some()
            })
    }

    fn confirm_model_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.model_controls.menu_focus.is_focused(window)
            && !self
                .model_controls
                .search
                .focus_handle(cx)
                .is_focused(window)
        {
            return;
        }
        if self.picker_is_composing(window, cx) {
            return;
        }
        if let Some(target) = self.model_controls.target.clone() {
            let choices = self.model_picker_choices(cx);
            if let Some((_, row)) = choices.get(
                self.model_controls
                    .highlight
                    .min(choices.len().saturating_sub(1)),
            ) {
                self.activate_picker_row(&target, row, window, cx);
            }
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    fn escape_model_picker(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker_is_composing(window, cx) {
            return;
        }
        if self
            .model_controls
            .search
            .focus_handle(cx)
            .is_focused(window)
            && !self.model_controls.search.read(cx).value().is_empty()
        {
            self.model_controls
                .search
                .update(cx, |search, cx| search.set_value("", window, cx));
            self.reset_model_picker_highlight(cx);
        } else {
            self.model_controls.close_popups();
            self.model_controls.trigger_focus.focus(window, cx);
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    fn move_model_picker(&mut self, offset: isize, window: &mut Window, cx: &mut Context<Self>) {
        if self.picker_is_composing(window, cx) {
            return;
        }
        let choices = self.model_picker_choices(cx);
        if !choices.is_empty() {
            let current = self.model_controls.highlight.min(choices.len() - 1);
            self.model_controls.highlight =
                (current as isize + offset).rem_euclid(choices.len() as isize) as usize;
            self.model_controls
                .menu_scroll
                .scroll_to_item(choices[self.model_controls.highlight].0);
        }
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }

    fn model_picker_key_down(
        &mut self,
        event: &KeyDownEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.picker_is_composing(window, cx) {
            return;
        }
        let focused = self
            .model_controls
            .search
            .focus_handle(cx)
            .is_focused(window);
        match event.keystroke.key.as_str() {
            "escape" => self.escape_model_picker(window, cx),
            "down" => self.move_model_picker(1, window, cx),
            "up" => self.move_model_picker(-1, window, cx),
            "enter" => self.confirm_model_picker(window, cx),
            key => {
                let choices = self.model_picker_choices(cx);
                if focused || choices.is_empty() {
                    return;
                }
                let choose = match key {
                    "home" => {
                        self.model_controls.highlight = 0;
                        false
                    }
                    "end" => {
                        self.model_controls.highlight = choices.len() - 1;
                        false
                    }
                    _ => {
                        let Ok(number) = key.parse::<usize>() else {
                            return;
                        };
                        if number == 0 || number > choices.len().min(9) {
                            return;
                        }
                        self.model_controls.highlight = number - 1;
                        true
                    }
                };
                self.model_controls
                    .menu_scroll
                    .scroll_to_item(choices[self.model_controls.highlight].0);
                if choose && let Some(target) = self.model_controls.target.clone() {
                    self.activate_picker_row(
                        &target,
                        &choices[self.model_controls.highlight].1,
                        window,
                        cx,
                    );
                }
                window.prevent_default();
                cx.stop_propagation();
                cx.notify();
            }
        }
    }
}
