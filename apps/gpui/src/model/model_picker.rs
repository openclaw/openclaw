use super::{model_controls::*, sessions::SessionRow};
use crate::gateway::composer_rpc::{
    ChatAccountSelection, ContextWindowOption, ModelAuthStatusResult, ModelChoice, ThinkingLevel,
    UserModelAccount,
};
use std::collections::HashSet;

pub const CHAT_ONLY_HELP: &str = "This model can chat, but it cannot use tools. Choose another model for files, commands, web, or media tasks.";

#[derive(Clone)]
pub enum PickerAction {
    Model(Box<PickerOption>),
    Account(String),
    CurrentAccount,
    Automatic,
    Loading,
    MoreAccounts,
    ManageAccounts,
}

#[derive(Clone)]
pub struct PickerMenuRow {
    pub key: String,
    pub label: String,
    pub description: Option<String>,
    pub selected: bool,
    pub disabled: bool,
    pub action: PickerAction,
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

pub enum PickerMenuEntry {
    Provider(PickerGroup),
    Accounts,
    Row(PickerMenuRow),
    AccountError(String),
}

pub struct MenuProjection<'a> {
    pub options: &'a [PickerOption],
    pub selection: &'a str,
    pub runtime: Option<&'a str>,
    pub query: &'a str,
    pub expanded_providers: &'a HashSet<String>,
    pub locked: bool,
    pub disabled: bool,
    pub pinned: bool,
    pub accounts_open: bool,
    pub accounts: Option<AccountInventory<'a>>,
    pub account_error: Option<&'a str>,
}

pub struct AccountInventory<'a> {
    pub selection: &'a ChatAccountSelection,
    pub accounts: &'a [UserModelAccount],
    pub auth: &'a ModelAuthStatusResult,
    pub model_reference: &'a str,
    pub automatic: bool,
    pub loading: bool,
    pub has_more: bool,
    pub disabled: bool,
}

pub fn menu_entries(input: MenuProjection<'_>) -> Vec<PickerMenuEntry> {
    if input.locked {
        return Vec::new();
    }
    let query = input.query.trim().to_lowercase();
    let mut entries = Vec::new();
    for group in group_picker_options(input.options) {
        let expanded = input.expanded_providers.contains(&group.provider);
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
                    selected: option.selected(input.selection, input.runtime),
                    disabled: input.disabled
                        || (!option.selectable(input.pinned) && !option.needs_auth()),
                    action: PickerAction::Model(Box::new(option)),
                }));
            }
        }
    }
    if let Some(accounts) = input.accounts {
        if query.is_empty() {
            entries.push(PickerMenuEntry::Accounts);
        }
        if input.accounts_open || !query.is_empty() {
            entries.extend(account_rows(accounts).into_iter().map(PickerMenuEntry::Row));
            if query.is_empty()
                && let Some(error) = input.account_error
            {
                entries.push(PickerMenuEntry::AccountError(error.into()));
            }
        }
    }
    if query.is_empty() {
        return entries;
    }
    let mut ranked = entries
        .into_iter()
        .filter_map(|entry| match entry {
            PickerMenuEntry::Row(row) => row.search_rank(&query).map(|rank| (rank, row)),
            _ => None,
        })
        .collect::<Vec<_>>();
    ranked.sort_by_key(|(rank, _)| *rank);
    ranked
        .into_iter()
        .map(|(_, row)| PickerMenuEntry::Row(row))
        .collect()
}

pub fn account_rows(input: AccountInventory<'_>) -> Vec<PickerMenuRow> {
    let selection = input.selection;
    let disabled = input.disabled;
    let reference = input.model_reference;
    let provider = reference
        .split_once('/')
        .map(|(p, _)| normalize_provider(p))
        .unwrap_or_default();
    let current = if selection.kind == "automatic" {
        None
    } else {
        selection.auth_profile_id.as_deref()
    };
    let subscriptions = input
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
        let account = input
            .accounts
            .iter()
            .find(|account| account.auth_profile_id == id)?;
        input
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
        input
            .accounts
            .iter()
            .filter(|account| {
                account.provider == provider && Some(account.auth_profile_id.as_str()) != current
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
    if input.automatic {
        rows.push(PickerMenuRow {
            key: "account:automatic".into(),
            label: "Automatic".into(),
            description: None,
            selected: false,
            disabled,
            action: PickerAction::Automatic,
        });
    }
    if input.loading {
        rows.push(PickerMenuRow {
            key: "account:loading".into(),
            label: "Loading…".into(),
            description: None,
            selected: false,
            disabled: true,
            action: PickerAction::Loading,
        });
    }
    if input.has_more {
        rows.push(PickerMenuRow {
            key: "account:more".into(),
            label: "Load more".into(),
            description: None,
            selected: false,
            disabled: disabled || input.loading,
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

pub fn project_thinking(
    row: &SessionRow,
    defaults: &SessionRow,
    model: Option<&ModelChoice>,
) -> ThinkingState {
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
    let owns_profile = |row: &SessionRow| {
        row.thinking_levels.is_some()
            || row.thinking_options.is_some()
            || row.thinking_default.is_some()
    };
    let profile = if owns_profile(row) {
        Some(row)
    } else if matching_defaults && owns_profile(defaults) {
        Some(defaults)
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

pub fn model_option_help(option: &PickerOption) -> String {
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

#[derive(Clone, Copy)]
pub enum ProviderAuthKind {
    Missing,
    Subscription,
    Api,
}
pub struct ProviderAuthLabel {
    pub kind: ProviderAuthKind,
    pub label: String,
}
pub fn provider_auth_label(
    provider: &str,
    auth: &ModelAuthStatusResult,
    selection: Option<&ChatAccountSelection>,
    options: &[PickerOption],
) -> Option<ProviderAuthLabel> {
    let records: Vec<_> = auth
        .providers
        .iter()
        .filter(|p| provider_group(&p.provider) == provider)
        .collect();
    let profiles: Vec<_> = records.iter().flat_map(|p| p.profiles.iter()).collect();
    let selected = selection
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
        if options
            .iter()
            .any(|o| o.provider == provider && o.needs_auth())
        {
            return None;
        }
        return Some(ProviderAuthLabel {
            kind: ProviderAuthKind::Missing,
            label: "Sign in needed".into(),
        });
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
        return Some(ProviderAuthLabel {
            kind: ProviderAuthKind::Subscription,
            label: detail.map(|d| format!("{label} · {d}")).unwrap_or(label),
        });
    }
    has_api.then(|| ProviderAuthLabel {
        kind: ProviderAuthKind::Api,
        label: "API".into(),
    })
}

pub struct ContextSelection {
    pub options: Vec<ContextWindowOption>,
    pub selected: String,
    pub default: String,
}

pub fn context_selection(
    row: &SessionRow,
    draft: bool,
    model: Option<&ModelChoice>,
) -> Option<ContextSelection> {
    let (options, default) = if draft && row.context_windows.is_none() {
        let model = model?;
        (
            model.context_windows.clone(),
            model.context_window_default.clone().unwrap_or_default(),
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
    let selected = row
        .context_window
        .clone()
        .unwrap_or_else(|| default.clone());
    options
        .iter()
        .any(|option| option.id == selected)
        .then_some(ContextSelection {
            options,
            selected,
            default,
        })
}
