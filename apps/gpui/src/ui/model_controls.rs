use super::{AppView, theme::Palette};
use crate::{
    gateway::composer_rpc::{ModelChoice, ThinkingLevel},
    model::{model_controls::*, sessions::SessionRow},
};
use gpui_kit::{
    assets::IconName,
    component::{
        Disableable, Icon, Sizable, StyledExt,
        button::{Button, ButtonVariants},
        input::Input,
        popover::Popover,
        tooltip::Tooltip,
    },
    prelude::FluentBuilder as _,
    *,
};
use serde_json::json;

const CHAT_ONLY_HELP: &str = "This model can chat, but it cannot use tools. Choose another model for files, commands, web, or media tasks.";

#[derive(Clone)]
enum PickerAction {
    Model(Box<PickerOption>),
    Account(String),
    CurrentAccount,
    Automatic,
    Loading,
    MoreAccounts,
    ManageAccounts,
}

#[derive(Clone)]
struct PickerMenuRow {
    key: String,
    label: String,
    description: Option<String>,
    selected: bool,
    disabled: bool,
    action: PickerAction,
}

impl PickerMenuRow {
    fn search_rank(&self, query: &str) -> Option<u8> {
        let (keywords, provider, reference) = match &self.action {
            PickerAction::Model(option) => (
                format!(
                    "{} {}",
                    if option.is_default { "Default" } else { "" },
                    option.runtime_label()
                ),
                provider_label(&option.provider),
                option.value.as_str(),
            ),
            _ => (
                self.description.clone().unwrap_or_default(),
                "account".into(),
                self.key.as_str(),
            ),
        };
        picker_search_rank(&self.label, &keywords, &provider, reference, query)
    }
}

enum PickerMenuEntry {
    Provider(PickerGroup),
    Accounts,
    Row(PickerMenuRow),
    AccountError(String),
}

struct PickerRowPresentation {
    highlight: bool,
    searching: bool,
    shortcut: Option<usize>,
    navigation_index: Option<usize>,
}

#[derive(Clone)]
struct EffortDrag;
impl Render for EffortDrag {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
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
            .gap(px(4.))
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
        let defaults: SessionRow =
            serde_json::from_value(self.model_controls.defaults.clone()).unwrap_or_default();
        let matching_defaults = row
            .model
            .as_ref()
            .is_none_or(|v| Some(v) == defaults.model.as_ref())
            && row
                .model_provider
                .as_ref()
                .is_none_or(|v| Some(v) == defaults.model_provider.as_ref())
            && row
                .agent_runtime
                .as_ref()
                .zip(defaults.agent_runtime.as_ref())
                .is_none_or(|(a, b)| a.id == b.id);
        let model = self.model_capabilities();
        let owns_profile = |row: &SessionRow| {
            row.thinking_levels.is_some()
                || row.thinking_options.is_some()
                || row.thinking_default.is_some()
        };
        let profile = if owns_profile(&row) {
            Some(&row)
        } else if matching_defaults && owns_profile(&defaults) {
            Some(&defaults)
        } else {
            None
        };
        let levels = if let Some(profile) = profile {
            profile.thinking_levels.clone().unwrap_or_else(|| {
                profile
                    .thinking_options
                    .as_ref()
                    .map(|options| {
                        options
                            .iter()
                            .map(|id| ThinkingLevel {
                                id: id.clone(),
                                label: id.clone(),
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            })
        } else {
            model
                .as_ref()
                .and_then(|m| m.thinking_levels.clone())
                .unwrap_or_default()
        };
        let default = profile
            .and_then(|p| p.thinking_default.as_deref())
            .or_else(|| {
                if profile.is_none() {
                    model.as_ref().and_then(|m| m.thinking_default.as_deref())
                } else {
                    None
                }
            });
        thinking_state(
            &levels,
            default,
            model.as_ref().and_then(|m| m.reasoning),
            row.thinking_level.as_deref(),
        )
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
        let row = self.model_controls_row().unwrap_or_default();
        if row.model_selection_locked {
            return Vec::new();
        }
        let query = self
            .model_controls
            .search
            .read(cx)
            .value()
            .trim()
            .to_lowercase();
        let selection = self.picker_selection_value();
        let runtime = self.model_runtime();
        let disabled = self.model_controls_disabled_reason().is_some();
        let pinned = self.model_is_pinned();
        let mut entries = Vec::new();
        for group in group_picker_options(&self.picker_options()) {
            let expanded = self
                .model_controls
                .expanded_providers
                .contains(&group.provider);
            if query.is_empty() {
                entries.push(PickerMenuEntry::Provider(group.clone()));
            }
            if expanded || !query.is_empty() {
                for option in group.options {
                    entries.push(PickerMenuEntry::Row(PickerMenuRow {
                        key: format!(
                            "model:{}:{}",
                            option.value,
                            option.agent_runtime.as_deref().unwrap_or("base")
                        ),
                        label: option.display_label(),
                        description: None,
                        selected: option.selected(&selection, runtime.as_deref()),
                        disabled: disabled || (!option.selectable(pinned) && !option.needs_auth()),
                        action: PickerAction::Model(Box::new(option)),
                    }));
                }
            }
        }
        if self.model_controls.catalog.account_selection.is_some() {
            if query.is_empty() {
                entries.push(PickerMenuEntry::Accounts);
            }
            if self.model_controls.accounts_open || !query.is_empty() {
                entries.extend(
                    self.account_rows(target)
                        .into_iter()
                        .map(PickerMenuEntry::Row),
                );
                if query.is_empty()
                    && let Some(error) = &self.model_controls.accounts_error
                {
                    entries.push(PickerMenuEntry::AccountError(error.clone()));
                }
            }
        }
        if !query.is_empty() {
            let mut ranked = entries
                .into_iter()
                .filter_map(|entry| match entry {
                    PickerMenuEntry::Row(row) => row.search_rank(&query).map(|rank| (rank, row)),
                    _ => None,
                })
                .collect::<Vec<_>>();
            ranked.sort_by_key(|(rank, _)| *rank);
            return ranked
                .into_iter()
                .map(|(_, row)| PickerMenuEntry::Row(row))
                .collect();
        }
        entries
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
            .w(px(338.))
            .max_h(px(398.))
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
                    .gap_2()
                    .p_2()
                    .text_size(px(12.))
                    .child(label.clone())
                    .child(div().text_size(px(10.)).child("LOCKED")),
            );
        } else {
            menu = menu.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(7.))
                    .m(px(8.))
                    .px(px(10.))
                    .h(px(36.))
                    .flex_shrink_0()
                    .border_1()
                    .border_color(p.border.opacity(0.78))
                    .rounded(px(10.))
                    .bg(p.card.opacity(0.78))
                    .child(
                        Icon::new(IconName::Search)
                            .size(px(14.))
                            .text_color(p.muted),
                    )
                    .child(
                        Input::new(&self.model_controls.search)
                            .appearance(false)
                            .bordered(false)
                            .text_size(px(12.))
                            .h(px(34.))
                            .p_0()
                            .flex_1(),
                    ),
            );
            if let Some(error) = &self.model_controls.error {
                menu = menu.child(
                    div()
                        .px_3()
                        .py_2()
                        .text_size(px(12.))
                        .text_color(p.muted)
                        .child(error.clone()),
                );
            } else if options.is_empty() {
                menu = menu.child(
                    div()
                        .min_h(px(112.))
                        .p_4()
                        .text_size(px(12.))
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
            .px(px(7.))
            .pb(px(7.))
            .gap(px(2.));
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
                    .px_2()
                    .py_1()
                    .text_size(px(12.))
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
                    .min_h(px(80.))
                    .p_3()
                    .text_size(px(12.))
                    .text_color(p.muted)
                    .child("No models match your search"),
            );
        }
        menu = menu.child(rows).children(self.context_control(target, cx));
        let control_target = target.clone();
        let owner = cx.entity().downgrade();
        let trigger = Button::new("model-picker-trigger")
            .track_focus(&self.model_controls.trigger_focus)
            .ghost()
            .small()
            .h(px(30.))
            .px(px(8.))
            .gap(px(6.))
            .min_w(px(44.))
            .max_w(px(260.))
            .rounded_full()
            .text_size(px(14.))
            .font_weight(FontWeight::NORMAL)
            .text_color(chip_color(p))
            .disabled(disabled)
            .picker_tooltip(disabled_reason.unwrap_or_else(|| {
                if restricted {
                    "Your administrator centrally configures the models available here.".into()
                } else {
                    "Selecting a model changes only this session.".into()
                }
            }));
        let mut content = div()
            .h_flex()
            .items_center()
            .gap(px(4.))
            .min_w_0()
            .text_size(px(14.))
            .line_height(px(18.9));
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
                        .gap(px(4.))
                        .child(Icon::new(IconName::TriangleAlert).size(px(14.)))
                        .child("Chat only")
                        .tooltip(|window, cx| Tooltip::new(CHAT_ONLY_HELP).build(window, cx)),
                );
            }
            if provider_icon_name(&option.provider).is_some() {
                content = content.child(div().mr(px(2.)).flex_shrink_0().child(provider_icon(
                    &option.provider,
                    15.,
                    true,
                    p,
                )));
            }
        }
        content = content.child(div().min_w_0().truncate().child(label));
        if let Some((windows, chosen, default)) = self.context_options()
            && chosen != default
            && let Some(option) = windows.iter().find(|o| o.id == chosen)
        {
            content = content.child(
                div()
                    .px_1()
                    .rounded_full()
                    .bg(p.hover)
                    .text_size(px(10.))
                    .child(option.label.clone()),
            );
        }
        content = content.child(
            Icon::new(if self.model_controls.model_open {
                IconName::ChevronUp
            } else {
                IconName::ChevronDown
            })
            .size(px(12.))
            .text_color(p.muted),
        );
        Popover::new("model-picker")
            .anchor(Anchor::BottomRight)
            .bottom(px(6.))
            .appearance(false)
            .open(self.model_controls.model_open)
            .track_focus(&self.model_controls.menu_focus)
            .on_open_change(move |open, window, cx| {
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
            })
            .trigger(trigger.child(content))
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
        let row = Button::new(SharedString::from(format!(
            "choice-{}-{}",
            option.value,
            option.agent_runtime.as_deref().unwrap_or("base")
        )))
        .ghost()
        .small()
        .w_full()
        .min_h(px(40.))
        .h_auto()
        .px(px(9.))
        .py(px(6.))
        .gap(px(8.))
        .rounded(px(12.5))
        .justify_start()
        .text_size(px(13.))
        .font_weight(FontWeight::SEMIBOLD)
        .text_color(p.text)
        .disabled(menu_row.disabled)
        .when(selected, |row| row.bg(p.text.opacity(0.08)))
        .when(presentation.highlight, |row| row.bg(p.hover));
        let content = div()
            .h_flex()
            .items_center()
            .w_full()
            .gap(px(8.))
            .text_size(px(13.))
            .child(
                div()
                    .w(px(18.))
                    .h(px(18.))
                    .flex_shrink_0()
                    .when(presentation.searching, |stem| {
                        stem.child(provider_icon(&option.provider, 16., false, p))
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
                    .ml(px(6.))
                    .flex_shrink_0()
                    .text_size(px(9.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(p.muted)
                    .child("Default"),
            );
        }
        let meta = option.metadata();
        if !meta.is_empty() {
            copy = copy.child(
                div()
                    .ml(px(6.))
                    .min_w_0()
                    .truncate()
                    .text_size(px(10.))
                    .font_weight(FontWeight::NORMAL)
                    .text_color(p.muted)
                    .child(meta),
            );
        }
        if option.needs_auth() {
            copy = copy.child(
                div()
                    .h_flex()
                    .items_center()
                    .gap(px(3.))
                    .ml(px(6.))
                    .min_w_0()
                    .text_size(px(10.))
                    .text_color(rgb(0xfbbf24))
                    .child(Icon::new(IconName::TriangleAlert).size(px(12.)))
                    .child(div().truncate().child(status)),
            );
        }
        if option.supports_tools == Some(false) {
            copy = copy.child(Icon::new(IconName::Info).size(px(16.)).text_color(p.muted));
        }
        let content = content.child(copy).child(
            div()
                .w(px(22.))
                .flex_shrink_0()
                .flex()
                .justify_center()
                .child(picker_row_action(selected, presentation.shortcut, p)),
        );
        let help = model_option_help(option);
        row.child(content)
            .picker_tooltip(if !help.is_empty() {
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
        let records: Vec<_> = self
            .model_controls
            .auth
            .providers
            .iter()
            .filter(|p| provider_group(&p.provider) == provider)
            .collect();
        let profiles: Vec<_> = records.iter().flat_map(|p| p.profiles.iter()).collect();
        let selected = self
            .model_controls
            .catalog
            .account_selection
            .as_ref()
            .filter(|s| s.kind != "automatic")
            .and_then(|s| s.auth_profile_id.as_deref());
        let active = selected.and_then(|id| profiles.iter().find(|p| p.profile_id == id));
        let subscriptions: Vec<_> = profiles
            .iter()
            .filter(|p| matches!(p.auth_type.as_str(), "oauth" | "token"))
            .collect();
        let has_api = records.iter().any(|p| p.api_key.is_some())
            || profiles.iter().any(|p| p.auth_type == "api_key");
        let usable = profiles
            .iter()
            .any(|p| matches!(p.status.as_str(), "ok" | "expiring" | "static"));
        if records
            .iter()
            .any(|p| matches!(p.status.as_str(), "missing" | "expired"))
            && !has_api
            && !usable
        {
            if self
                .picker_options()
                .iter()
                .any(|o| o.provider == provider && o.needs_auth())
            {
                return None;
            }
            return Some((IconName::TriangleAlert, "Sign in needed".into()));
        }
        if !subscriptions.is_empty() && active.is_none_or(|p| p.auth_type != "api_key") {
            let label = if subscriptions.len() == 1 {
                records
                    .iter()
                    .find_map(|p| p.usage.as_ref().and_then(|u| u.plan.clone()))
                    .unwrap_or_else(|| "Subscription".into())
            } else {
                "Subscription".into()
            };
            let detail = (subscriptions.len() > 1)
                .then(|| active.and_then(|p| p.email.clone()))
                .flatten();
            return Some((
                IconName::CircleUser,
                detail.map(|d| format!("{label} · {d}")).unwrap_or(label),
            ));
        }
        has_api.then(|| (IconName::Key, "API".into()))
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
            .gap(px(8.))
            .px(px(10.))
            .h(px(32.))
            .text_color(p.muted)
            .child(
                Button::new(SharedString::from(format!("provider-{provider}")))
                    .ghost()
                    .small()
                    .p_0()
                    .h(px(32.))
                    .flex_1()
                    .justify_start()
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .text_color(p.muted)
                    .child(
                        div()
                            .h_flex()
                            .items_center()
                            .w_full()
                            .gap(px(8.))
                            .text_size(px(11.))
                            .font_weight(FontWeight::BOLD)
                            .child(provider_icon(&provider, 16., false, p))
                            .child(group.label.clone())
                            .child(group.options.len().to_string())
                            .child(
                                Icon::new(if open {
                                    IconName::ChevronUp
                                } else {
                                    IconName::ChevronDown
                                })
                                .size(px(12.)),
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
                        .gap(px(4.))
                        .items_center()
                        .min_w_0()
                        .text_size(px(11.))
                        .child(Icon::new(icon).size(px(13.)))
                        .child(div().truncate().child(label)),
                )
            })
            .child(
                Button::new(SharedString::from(format!("configure-{provider}")))
                    .ghost()
                    .xsmall()
                    .p_0()
                    .size(px(22.))
                    .icon(Icon::new(IconName::Settings).size(px(12.)))
                    .picker_tooltip("Configure models")
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

    fn account_rows(&self, target: &ModelControlsTarget) -> Vec<PickerMenuRow> {
        let Some(selection) = self.model_controls.catalog.account_selection.as_ref() else {
            return Vec::new();
        };
        let disabled = self.account_controls_disabled(target);
        let reference = self.model_controls_model_reference();
        let provider = reference
            .split_once('/')
            .map(|(p, _)| normalize_provider(p))
            .unwrap_or_default();
        let current = if selection.kind == "automatic" {
            None
        } else {
            selection.auth_profile_id.as_deref()
        };
        let subscriptions = self
            .model_controls
            .auth
            .providers
            .iter()
            .filter(|record| provider_group(&record.provider) == provider_group(&provider))
            .flat_map(|record| record.profiles.iter())
            .filter(|profile| matches!(profile.auth_type.as_str(), "oauth" | "token"))
            .collect::<Vec<_>>();
        let description = |profile_id: Option<&str>| {
            let id = profile_id?;
            if subscriptions.len() > 1
                && let Some(email) = subscriptions
                    .iter()
                    .find(|profile| profile.profile_id == id)
                    .and_then(|profile| profile.email.clone())
            {
                return Some(email);
            }
            let account = self
                .model_controls
                .accounts
                .iter()
                .find(|account| account.auth_profile_id == id)?;
            self.model_controls
                .accounts
                .iter()
                .any(|other| {
                    other.auth_profile_id != id
                        && other.provider == account.provider
                        && other.label == account.label
                })
                .then(|| id.to_owned())
        };
        let mut rows = vec![PickerMenuRow {
            key: "account:current".into(),
            label: selection.label.clone(),
            description: description(current),
            selected: true,
            disabled,
            action: PickerAction::CurrentAccount,
        }];
        rows.extend(
            self.model_controls
                .accounts
                .iter()
                .filter(|account| {
                    account.provider == provider
                        && Some(account.auth_profile_id.as_str()) != current
                })
                .map(|account| PickerMenuRow {
                    key: format!("account:account:{}", account.auth_profile_id),
                    label: account.label.clone(),
                    description: description(Some(&account.auth_profile_id)),
                    selected: false,
                    disabled,
                    action: PickerAction::Account(account.auth_profile_id.clone()),
                }),
        );
        if target.session_key.is_none()
            && self
                .model_controls_draft_patch(target)
                .get("model")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| split_model_auth_profile(value).1.is_some())
        {
            rows.push(PickerMenuRow {
                key: "account:automatic".into(),
                label: "Automatic".into(),
                description: None,
                selected: false,
                disabled,
                action: PickerAction::Automatic,
            });
        }
        if self.model_controls.accounts_loading {
            rows.push(PickerMenuRow {
                key: "account:loading".into(),
                label: "Loading…".into(),
                description: None,
                selected: false,
                disabled: true,
                action: PickerAction::Loading,
            });
        }
        if self.model_controls.account_next_cursor.is_some() {
            rows.push(PickerMenuRow {
                key: "account:more".into(),
                label: "Load more".into(),
                description: None,
                selected: false,
                disabled: disabled || self.model_controls.accounts_loading,
                action: PickerAction::MoreAccounts,
            });
        }
        rows.push(PickerMenuRow {
            key: "account:manage".into(),
            label: "Manage saved accounts…".into(),
            description: None,
            selected: false,
            disabled,
            action: PickerAction::ManageAccounts,
        });
        rows
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
            .ghost()
            .small()
            .w_full()
            .min_h(px(32.))
            .px(px(10.))
            .py(px(3.))
            .gap(px(8.))
            .text_color(p.muted)
            .text_size(px(11.))
            .font_weight(FontWeight::BOLD)
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .w_full()
                    .gap(px(8.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::BOLD)
                    .child(Icon::new(IconName::Users).size(px(16.)))
                    .child("Account")
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_right()
                            .truncate()
                            .font_weight(FontWeight::NORMAL)
                            .child(label),
                    )
                    .child(
                        Icon::new(if self.model_controls.accounts_open {
                            IconName::ChevronUp
                        } else {
                            IconName::ChevronDown
                        })
                        .size(px(12.)),
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
        Button::new(SharedString::from(row.key.clone()))
            .ghost()
            .small()
            .w_full()
            .min_h(px(40.))
            .h_auto()
            .px(px(9.))
            .py(px(6.))
            .rounded(px(12.5))
            .disabled(row.disabled)
            .when(presentation.highlight, |button| button.bg(p.hover))
            .child(
                div()
                    .h_flex()
                    .items_center()
                    .w_full()
                    .gap(px(8.))
                    .text_size(px(13.))
                    .font_weight(FontWeight::NORMAL)
                    .child(
                        div()
                            .size(px(18.))
                            .flex_shrink_0()
                            .when(presentation.searching, |stem| {
                                stem.child(Icon::new(IconName::Users).size(px(16.)))
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
                                        .ml(px(6.))
                                        .text_size(px(11.))
                                        .text_color(p.muted)
                                        .font_weight(FontWeight::NORMAL)
                                        .truncate()
                                        .child(description),
                                )
                            }),
                    )
                    .child(
                        div()
                            .w(px(22.))
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

    fn context_options(
        &self,
    ) -> Option<(
        Vec<crate::gateway::composer_rpc::ContextWindowOption>,
        String,
        String,
    )> {
        let row = self.model_controls_row()?;
        let draft = self
            .model_controls
            .target
            .as_ref()
            .is_some_and(|t| t.session_key.is_none());
        let model = draft.then(|| self.model_capabilities()).flatten();
        let (options, default) = if draft && row.context_windows.is_none() {
            let model = model?;
            (
                model.context_windows,
                model.context_window_default.unwrap_or_default(),
            )
        } else {
            (
                row.context_windows.clone().unwrap_or_default(),
                row.context_window_default.clone().unwrap_or_default(),
            )
        };
        if options.len() < 2 {
            return None;
        }
        let selected = row.context_window.unwrap_or_else(|| default.clone());
        options
            .iter()
            .any(|o| o.id == selected)
            .then_some((options, selected, default))
    }

    fn context_control(
        &self,
        target: &ModelControlsTarget,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let (mut options, selected, _) = self.context_options()?;
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
                switch("context-window-toggle", active, disabled, p).on_click(cx.listener(
                    move |this, _, _, cx| {
                        this.apply_model_control_patch(
                            target.clone(),
                            json!({"contextWindow":next}),
                            cx,
                        )
                    },
                )),
            );
        } else {
            row = row.child(
                div()
                    .h_flex()
                    .gap_1()
                    .children(options.into_iter().enumerate().map(|(index, option)| {
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
                    })),
            );
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
        let trigger = Button::new("effort-trigger")
            .ghost()
            .small()
            .h(px(30.))
            .px(px(8.))
            .gap(px(6.))
            .rounded_full()
            .text_size(px(14.))
            .font_weight(FontWeight::NORMAL)
            .text_color(chip_color(p))
            .disabled(disabled)
            .picker_tooltip(format!("Thinking level: {label}"));
        let mut content = div()
            .h_flex()
            .items_center()
            .gap(px(4.))
            .text_size(px(14.))
            .line_height(px(18.9));
        if fast.active {
            content = content.child(
                div()
                    .mr(px(2.))
                    .flex_shrink_0()
                    .child(filled_zap(14., p.accent)),
            );
        }
        content = content.child(label).child(
            Icon::new(if self.model_controls.effort_open {
                IconName::ChevronUp
            } else {
                IconName::ChevronDown
            })
            .size(px(12.))
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
        let mut menu = div().v_flex().w(px(328.));
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
                .gap(px(4.))
                .px(px(12.))
                .pt(px(12.))
                .pb(px(11.))
                .bg(p.card.opacity(0.78))
                .child(
                    div()
                        .h_flex()
                        .justify_between()
                        .mb(px(10.))
                        .gap(px(8.))
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
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
                            .mx(px(6.))
                            .mb(px(2.))
                            .text_size(px(10.))
                            .text_color(p.muted)
                            .font_weight(FontWeight::MEDIUM)
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
                switch("fast-mode-toggle", fast.active, fast_disabled, p)
                    .picker_tooltip(if fast.supported {
                        format!("Fast responses: {}", fast.label)
                    } else {
                        "Speed control is not supported for this model.".into()
                    })
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.apply_model_control_patch(target.clone(), json!({"fastMode":next}), cx)
                    })),
            ),
        );
        Some(
            Popover::new("effort-picker")
                .anchor(Anchor::BottomRight)
                .bottom(px(6.))
                .appearance(false)
                .open(self.model_controls.effort_open)
                .track_focus(&self.model_controls.effort_focus)
                .on_open_change(move |open, _, cx| {
                    let _ = owner.update(cx, |this, cx| {
                        this.model_controls.effort_open =
                            *open && this.model_controls_disabled_reason().is_none();
                        this.model_controls.model_open = false;
                        this.model_controls.effort_preview = None;
                        cx.notify();
                    });
                })
                .trigger(trigger.child(content))
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
        let p = Palette::get(cx);
        let count = thinking.options.len();
        let selected = self
            .model_controls
            .effort_preview
            .or(thinking.selected_index)
            .unwrap_or(0);
        let fraction = selected as f32 / (count - 1) as f32;
        let bounds_cell = self.model_controls.effort_bounds.clone();
        let ultra = thinking.options[selected].value == "ultra";
        let anchored =
            thinking.selected_index.is_some() || self.model_controls.effort_preview.is_some();
        let boosted = anchored
            && (ultra
                || thinking.options.iter().rposition(|o| {
                    o.label != "On"
                        && matches!(
                            o.value.as_str(),
                            "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
                        )
                }) == Some(selected));
        let thumb = if thinking.override_active || self.model_controls.effort_preview.is_some() {
            p.strong
        } else {
            p.muted
        };
        let thumb = if anchored { thumb } else { thumb.opacity(0.35) };
        let focus = self.model_controls.effort_focus.clone();
        let track = div()
            .id("thinking-slider")
            .role(Role::Slider)
            .aria_label("Thinking level")
            .aria_numeric_value(selected as f64)
            .aria_min_numeric_value(0.)
            .aria_max_numeric_value((count - 1) as f64)
            .aria_numeric_value_step(1.)
            .aria_description(if thinking.override_active {
                thinking.label.clone()
            } else {
                format!("Default ({})", thinking.inherited_label)
            })
            .track_focus(&self.model_controls.effort_focus)
            .tab_index(0)
            .mx(px(6.))
            .h(px(26.))
            .w(px(292.))
            .rounded_full()
            .when(disabled, |d| d.opacity(0.5))
            .when(boosted, |d| {
                d.shadow(vec![BoxShadow {
                    inset: false,
                    color: p.accent.opacity(if ultra { 0.48 } else { 0.24 }),
                    offset: point(px(0.), px(0.)),
                    blur_radius: px(if ultra { 18. } else { 12. }),
                    spread_radius: px(0.),
                }])
            })
            .child(
                canvas(
                    move |bounds, _, _| bounds_cell.set(bounds),
                    move |bounds, _, window, _| {
                        let track_bg = if boosted {
                            p.accent
                        } else {
                            p.elevated.blend(p.text.opacity(0.07))
                        };
                        if boosted {
                            let highlight = if ultra {
                                rgb(0x14b8a6).into()
                            } else {
                                p.accent
                            };
                            let center = Hsla::from(rgb(0xffffff)).blend(Hsla {
                                a: if ultra { 0.7 } else { 0.6 },
                                ..highlight
                            });
                            let half = bounds.size.width / 2.;
                            for (offset, from, to, left) in [
                                (px(0.), p.accent, center, true),
                                (half, center, p.accent, false),
                            ] {
                                let radii = Corners {
                                    top_left: if left { px(13.) } else { px(0.) },
                                    bottom_left: if left { px(13.) } else { px(0.) },
                                    top_right: if left { px(0.) } else { px(13.) },
                                    bottom_right: if left { px(0.) } else { px(13.) },
                                };
                                let rect = Bounds::new(
                                    point(bounds.left() + offset, bounds.top()),
                                    size(half, bounds.size.height),
                                );
                                window.paint_quad(
                                    fill(
                                        rect,
                                        linear_gradient(
                                            90.,
                                            linear_color_stop(from, 0.),
                                            linear_color_stop(to, 1.),
                                        ),
                                    )
                                    .corner_radii(radii),
                                );
                            }
                        } else {
                            window.paint_quad(rounded_fill(bounds, px(13.), track_bg));
                        }
                        if !boosted && fraction > 0. {
                            window.paint_quad(rounded_fill(
                                Bounds::new(
                                    bounds.origin,
                                    size(bounds.size.width * fraction, bounds.size.height),
                                ),
                                px(13.),
                                p.text.opacity(0.12),
                            ));
                        }
                        if boosted {
                            window.paint_quad(
                                outline(
                                    bounds,
                                    p.accent.opacity(if ultra { 0.75 } else { 0.45 }),
                                    BorderStyle::Solid,
                                )
                                .corner_radii(px(13.)),
                            );
                        }
                        for index in 0..count {
                            let x = bounds.left()
                                + px(12.)
                                + (bounds.size.width - px(24.)) * index as f32 / (count - 1) as f32;
                            window.paint_quad(rounded_fill(
                                Bounds::new(
                                    point(x - px(2.), bounds.top() + px(11.)),
                                    size(px(4.), px(4.)),
                                ),
                                px(2.),
                                p.text.opacity(0.28),
                            ));
                        }
                        let x = bounds.left() + (bounds.size.width - px(28.)) * fraction;
                        let thumb_bounds =
                            Bounds::new(point(x, bounds.top() + px(3.)), size(px(28.), px(20.)));
                        window.paint_quad(rounded_fill(thumb_bounds, px(10.), thumb));
                        if focus.is_focused(window) {
                            window.paint_quad(
                                outline(thumb_bounds.dilate(px(2.)), p.accent, BorderStyle::Solid)
                                    .corner_radii(px(12.)),
                            );
                        }
                    },
                )
                .size_full(),
            );
        track
            .when(!disabled, |track| {
                track
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(|this, event: &MouseDownEvent, window, cx| {
                            this.model_controls.effort_focus.focus(window, cx);
                            this.model_controls.effort_dragging = true;
                            this.preview_effort(event.position.x, cx);
                            cx.stop_propagation();
                        }),
                    )
                    .on_drag(EffortDrag, |drag, _, _, cx| {
                        cx.stop_propagation();
                        cx.new(|_| drag.clone())
                    })
                    .on_drag_move(
                        cx.listener(|this, event: &DragMoveEvent<EffortDrag>, _, cx| {
                            this.preview_effort(event.event.position.x, cx)
                        }),
                    )
                    .on_mouse_up(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.commit_effort_preview(cx)),
                    )
                    .on_mouse_up_out(
                        MouseButton::Left,
                        cx.listener(|this, _, _, cx| this.commit_effort_preview(cx)),
                    )
                    .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                        let thinking = this.thinking_selection();
                        let current = thinking.selected_index.unwrap_or(0);
                        let last = thinking.options.len().saturating_sub(1);
                        let next = match event.keystroke.key.as_str() {
                            "left" | "down" => current.saturating_sub(1),
                            "right" | "up" => (current + 1).min(last),
                            "home" | "pagedown" => 0,
                            "end" | "pageup" => last,
                            _ => return,
                        };
                        this.model_controls.effort_preview = Some(next);
                        this.model_controls.effort_dragging = true;
                        this.commit_effort_preview(cx);
                        window.prevent_default();
                        cx.stop_propagation();
                    }))
                    .on_a11y_action(AccessibleAction::Increment, {
                        let owner = cx.entity().downgrade();
                        move |_, _, cx| {
                            let _ = owner.update(cx, |this, cx| this.step_effort(1, cx));
                        }
                    })
                    .on_a11y_action(AccessibleAction::Decrement, {
                        let owner = cx.entity().downgrade();
                        move |_, _, cx| {
                            let _ = owner.update(cx, |this, cx| this.step_effort(-1, cx));
                        }
                    })
            })
            .into_any_element()
    }

    fn preview_effort(&mut self, x: Pixels, cx: &mut Context<Self>) {
        let bounds = self.model_controls.effort_bounds.get();
        let count = self.thinking_selection().options.len();
        if count < 2 {
            return;
        }
        let fraction =
            f32::from(x - bounds.left() - px(14.)) / f32::from(bounds.size.width - px(28.));
        self.model_controls.effort_preview =
            Some((fraction.clamp(0., 1.) * (count - 1) as f32).round() as usize);
        cx.notify();
    }
    fn commit_effort_preview(&mut self, cx: &mut Context<Self>) {
        if !self.model_controls.effort_dragging {
            return;
        }
        self.model_controls.effort_dragging = false;
        let next = self.model_controls.effort_preview.take();
        let thinking = self.thinking_selection();
        if let Some(stop) = next.and_then(|i| thinking.options.get(i))
            && (!thinking.override_active || thinking.value != stop.value)
            && let Some(target) = self.model_controls.target.clone()
        {
            self.apply_model_control_patch(target, json!({"thinkingLevel":stop.value}), cx);
        }
        cx.notify();
    }
    fn step_effort(&mut self, offset: isize, cx: &mut Context<Self>) {
        let thinking = self.thinking_selection();
        let last = thinking.options.len().saturating_sub(1);
        self.model_controls.effort_preview = Some(
            thinking
                .selected_index
                .unwrap_or(0)
                .saturating_add_signed(offset)
                .min(last),
        );
        self.model_controls.effort_dragging = true;
        self.commit_effort_preview(cx);
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

fn model_option_help(option: &PickerOption) -> String {
    let route = match (option.provider.as_str(), option.agent_runtime_id.as_deref()) {
        (_, Some("claude-cli")) | ("claude-cli", None) => {
            "Runs through Claude Code, using its native login or a selected saved account. An explicitly selected API-key account has separate API billing; CLI does not mean free or subscription-only."
        }
        ("anthropic", Some("openclaw")) => {
            "Uses the configured Anthropic API connection with OpenClaw's runtime. API-key usage is billed separately from a Claude subscription."
        }
        ("anthropic", None) => {
            "Anthropic models can use the API or Claude CLI, depending on their configured runtime and account. The provider name alone does not determine billing."
        }
        _ => "",
    };
    [
        route,
        if option.supports_tools == Some(false) {
            CHAT_ONLY_HELP
        } else {
            ""
        },
    ]
    .into_iter()
    .filter(|part| !part.is_empty())
    .collect::<Vec<_>>()
    .join(" ")
}

fn picker_row_action(selected: bool, shortcut: Option<usize>, p: Palette) -> AnyElement {
    if selected {
        Icon::new(IconName::Check)
            .size(px(14.))
            .text_color(p.accent)
            .into_any_element()
    } else if let Some(shortcut) = shortcut {
        div()
            .min_w(px(16.))
            .h(px(18.))
            .flex()
            .items_center()
            .justify_center()
            .text_size(px(11.))
            .font_weight(FontWeight::NORMAL)
            .text_color(p.muted)
            .child(shortcut.to_string())
            .into_any_element()
    } else {
        div().into_any_element()
    }
}

fn chip_color(p: Palette) -> Hsla {
    p.popover.blend(p.strong.opacity(0.65))
}
fn menu_surface(p: Palette) -> Div {
    div()
        .v_flex()
        .bg(p.elevated.blend(p.card.opacity(0.04)))
        .border_1()
        .border_color(p.border_strong.opacity(0.64))
        .rounded(px(17.5))
        .shadow_lg()
        .overflow_hidden()
}
fn setting_row(icon: IconName, title: &str, description: &str, p: Palette) -> Div {
    div()
        .h_flex()
        .flex_shrink_0()
        .items_center()
        .gap(px(8.))
        .px(px(12.))
        .py(px(11.))
        .border_t_1()
        .border_color(p.border.opacity(0.7))
        .child(if matches!(icon, IconName::Zap) {
            filled_zap(16., p.accent)
        } else {
            Icon::new(icon)
                .size(px(16.))
                .text_color(p.accent)
                .into_any_element()
        })
        .child(
            div()
                .v_flex()
                .gap(px(1.))
                .flex_1()
                .min_w_0()
                .child(
                    div()
                        .text_size(px(12.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .child(title.to_owned()),
                )
                .child(
                    div()
                        .text_size(px(10.))
                        .line_height(px(13.))
                        .text_color(p.muted)
                        .truncate()
                        .child(description.to_owned()),
                ),
        )
}
fn switch(id: &'static str, active: bool, disabled: bool, p: Palette) -> Button {
    Button::new(id)
        .ghost()
        .p_0()
        .w(px(36.))
        .h(px(22.))
        .flex_shrink_0()
        .rounded_full()
        .border_1()
        .border_color(if active { p.accent } else { p.border_strong })
        .bg(if active {
            p.card.blend(p.accent.opacity(0.58))
        } else {
            p.card.blend(p.text.opacity(0.12))
        })
        .disabled(disabled)
        .child(
            div().relative().w(px(34.)).h(px(20.)).child(
                div()
                    .absolute()
                    .top(px(3.))
                    .left(px(if active { 17. } else { 3. }))
                    .size(px(14.))
                    .rounded_full()
                    .bg(p.strong),
            ),
        )
}

fn provider_icon_name(provider: &str) -> Option<String> {
    let name = match provider {
        "acp-copilot" | "copilot-proxy" | "github-copilot" => "copilot",
        "anthropic" | "claude-cli" => "claude",
        "amazon-bedrock" | "aws-bedrock" => "bedrock",
        "cloudflare-ai-gateway" => "cloudflare",
        "google" | "google-gemini-cli" => "gemini",
        "kilocode" => "kilo",
        "kimi-coding" | "moonshot" => "kimi",
        "llama-cpp" => "llamacpp",
        "microsoft-foundry" => "microsoft",
        "minimax-portal" => "minimax",
        "ollama-cloud" => "ollama",
        "openai" => "codex",
        "opencode-go" => "opencodego",
        "opencode-zen" => "opencode",
        "qwen" | "qwen-token-plan" => "alibaba",
        "stepfun-plan" => "stepfun",
        "tencent-tokenhub" | "tencent-tokenplan" => "tencent",
        "xai" => "grok",
        "xiaomi" | "xiaomi-token-plan" => "mimo",
        "vercel-ai-gateway" => "vercel",
        "vertex-ai" => "vertexai",
        "z-ai" => "zai",
        other => other,
    };
    let path = format!("provider-icons/ProviderIcon-{name}.svg");
    crate::assets::PROVIDER_ICONS
        .iter()
        .any(|(p, _)| *p == path)
        .then_some(path)
}
fn provider_icon(provider: &str, size: f32, neutral: bool, p: Palette) -> AnyElement {
    if let Some(path) = provider_icon_name(provider) {
        let color = if neutral {
            chip_color(p)
        } else {
            match provider {
                "openai" => rgb(0x10a37f).into(),
                "anthropic" | "claude-cli" => rgb(0xd97757).into(),
                "google" => rgb(0x4285f4).into(),
                "ollama" | "lmstudio" | "llama-cpp" | "opencode" => p.strong,
                _ => p.muted,
            }
        };
        svg()
            .path(path)
            .size(px(size))
            .flex_shrink_0()
            .text_color(color)
            .into_any_element()
    } else {
        div()
            .size(px(size))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded(px(4.))
            .bg(p.hover)
            .text_size(px(9.))
            .font_weight(FontWeight::BOLD)
            .child(
                provider
                    .chars()
                    .next()
                    .unwrap_or('?')
                    .to_uppercase()
                    .to_string(),
            )
            .into_any_element()
    }
}

fn rounded_fill(bounds: Bounds<Pixels>, radius: Pixels, color: Hsla) -> PaintQuad {
    fill(bounds, color).corner_radii(radius)
}

fn filled_zap(size_px: f32, color: Hsla) -> AnyElement {
    canvas(
        |_, _, _| {},
        move |bounds, _, window, _| {
            let mut path = PathBuilder::fill();
            for (index, (x, y)) in [
                (13., 2.),
                (3., 14.),
                (12., 14.),
                (11., 22.),
                (21., 10.),
                (12., 10.),
                (13., 2.),
            ]
            .into_iter()
            .enumerate()
            {
                let point = point(
                    bounds.left() + bounds.size.width * (x / 24.),
                    bounds.top() + bounds.size.height * (y / 24.),
                );
                if index == 0 {
                    path.move_to(point);
                } else {
                    path.line_to(point);
                }
            }
            if let Ok(path) = path.build() {
                window.paint_path(path, color);
            }
        },
    )
    .size(px(size_px))
    .flex_shrink_0()
    .into_any_element()
}

// Search retires rows without pointer leave events. Element-owned tooltips retire with them.
trait PickerTooltip: InteractiveElement + Sized {
    fn picker_tooltip(mut self, text: impl Into<SharedString>) -> Self {
        let text = text.into();
        self.interactivity()
            .tooltip(move |window, cx| Tooltip::new(text.clone()).build(window, cx));
        self
    }
}
impl PickerTooltip for Button {}
