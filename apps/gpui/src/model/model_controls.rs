//! Presentation projections shared by the session and draft composer model controls.
use crate::gateway::composer_rpc::{FastMode, ModelChoice, ThinkingLevel};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct ModelControlsTarget {
    pub agent_id: String,
    pub session_key: Option<String>,
    pub draft_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct PickerOption {
    pub value: String,
    pub commit_value: String,
    pub label: String,
    pub provider: String,
    pub is_default: bool,
    pub disabled: bool,
    pub unavailable_reason: Option<String>,
    pub agent_runtime: Option<String>,
    pub agent_runtime_id: Option<String>,
    pub runtime_override: Option<String>,
    /// A runtime-specific base with an unknown route matches only an unpinned selection.
    pub runtime_specific: bool,
    pub context_window: Option<u64>,
    pub context_tokens: Option<u64>,
    pub supports_tools: Option<bool>,
}

impl PickerOption {
    pub fn selected(&self, value: &str, runtime: Option<&str>) -> bool {
        (self.value == value || (self.is_default && value.is_empty()))
            && (!self.runtime_specific || self.agent_runtime.as_deref() == runtime)
    }

    pub fn selectable(&self, session_pinned: bool) -> bool {
        !self.disabled || (self.is_default && session_pinned)
    }

    pub fn needs_auth(&self) -> bool {
        self.disabled
            && matches!(
                self.unavailable_reason.as_deref(),
                Some("missing-auth" | "auth-failed")
            )
    }

    pub fn display_label(&self) -> String {
        let mut prefixes = [
            raw_provider_label(&self.provider),
            provider_label(&self.provider),
        ];
        prefixes.sort_by_key(|prefix| std::cmp::Reverse(prefix.len()));
        let label_lower = self.label.to_lowercase();
        for prefix in prefixes {
            let prefix_lower = prefix.to_lowercase();
            if label_lower.starts_with(&format!("{prefix_lower} ")) {
                return self
                    .label
                    .chars()
                    .skip(prefix.chars().count() + 1)
                    .collect();
            }
            let suffix = format!(" ({prefix_lower})");
            if label_lower.ends_with(&suffix) {
                return self
                    .label
                    .chars()
                    .take(self.label.chars().count() - suffix.chars().count())
                    .collect();
            }
        }
        self.label.clone()
    }

    pub fn runtime_label(&self) -> String {
        runtime_label(&self.provider, self.agent_runtime_id.as_deref())
    }

    pub fn metadata(&self) -> String {
        let runtime = self.runtime_label();
        if self.needs_auth() {
            return if matches!(self.provider.as_str(), "anthropic" | "claude-cli") {
                runtime
            } else {
                String::new()
            };
        }
        let context = match (self.context_tokens, self.context_window) {
            (Some(active), Some(maximum)) if active != maximum => format!(
                "{} active · {} max",
                format_context_capacity(active),
                format_context_capacity(maximum)
            ),
            (_, Some(maximum)) => format_context_capacity(maximum),
            _ => String::new(),
        };
        [context, runtime]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
    }
}

#[derive(Clone, Debug)]
pub struct PickerGroup {
    pub provider: String,
    pub label: String,
    pub options: Vec<PickerOption>,
}

pub fn normalize_provider(provider: &str) -> String {
    match provider.trim().to_lowercase().as_str() {
        "codex" | "openai-codex" => "openai".into(),
        normalized => normalized.to_owned(),
    }
}

pub fn provider_group(provider: &str) -> String {
    match normalize_provider(provider).as_str() {
        "google-gemini-cli" => "google".into(),
        "moonshot-ai" | "moonshotai" => "moonshot".into(),
        "opencode-go" | "opencode-zen" => "opencode".into(),
        normalized => normalized.to_owned(),
    }
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

fn raw_provider_label(provider: &str) -> String {
    provider
        .split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(capitalize)
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn provider_label(provider: &str) -> String {
    match provider {
        "acp-copilot" => "GitHub Copilot CLI",
        "anthropic" => "Anthropic",
        "claude-cli" => "Claude CLI",
        "google" => "Google",
        "github-copilot" => "GitHub",
        "llama-cpp" => "llama.cpp",
        "lmstudio" => "LM Studio",
        "longcat" => "LongCat",
        "openai" => "OpenAI",
        "moonshot" => "Moonshot AI",
        "opencode" => "OpenCode",
        "openrouter" => "OpenRouter",
        "qwen" => "Qwen Cloud",
        "zai" => "Z.AI",
        _ => return raw_provider_label(provider),
    }
    .into()
}

pub fn runtime_label(provider: &str, runtime: Option<&str>) -> String {
    match (provider, runtime) {
        (_, Some("claude-cli")) | ("claude-cli", None) => "Claude CLI · native".into(),
        ("anthropic", Some("openclaw")) => "API · OpenClaw".into(),
        ("anthropic", None) => "Configured route".into(),
        (_, Some("codex" | "codex-cli")) => "Codex".into(),
        (_, Some("google-gemini-cli")) => "Gemini CLI".into(),
        (_, Some("openclaw")) => "OpenClaw".into(),
        (_, Some(value)) => capitalize(&value.trim().to_lowercase()),
        (_, None) => String::new(),
    }
}

pub fn format_context_capacity(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{}M", (tokens as f64 / 100_000.0).floor() / 10.0)
    } else if tokens >= 1_000 {
        let thousands = (tokens as f64 / 100.0).round() / 10.0;
        if thousands >= 1_000.0 {
            "1M".into()
        } else {
            format!("{thousands}k")
        }
    } else {
        tokens.to_string()
    }
}

/// Mirrors the Gateway's model-ref-profile owner: dates and local quant suffixes belong to the model.
pub fn split_model_auth_profile(raw: &str) -> (&str, Option<&str>) {
    let raw = raw.trim();
    let suffix_start = raw.rfind('/').map_or(0, |index| index + 1);
    let Some(mut delimiter) = raw[suffix_start..]
        .find('@')
        .map(|index| index + suffix_start)
        .filter(|index| *index > 0)
    else {
        return (raw, None);
    };
    let segment = raw[delimiter + 1..].split('@').next().unwrap_or_default();
    if segment.len() == 8 && segment.bytes().all(|byte| byte.is_ascii_digit()) {
        let Some(next) = raw[delimiter + 1..].find('@') else {
            return (raw, None);
        };
        delimiter += next + 1;
    }
    let segment = raw[delimiter + 1..].split('@').next().unwrap_or_default();
    if is_quantization_suffix(segment) {
        let Some(next) = raw[delimiter + 1..].find('@') else {
            return (raw, None);
        };
        delimiter += next + 1;
    }
    let model = raw[..delimiter].trim();
    let profile = raw[delimiter + 1..].trim();
    if model.is_empty() || profile.is_empty() {
        (raw, None)
    } else {
        (model, Some(profile))
    }
}

fn is_quantization_suffix(suffix: &str) -> bool {
    let suffix = suffix.to_ascii_lowercase();
    if let Some(bits) = suffix.strip_suffix("bit") {
        return !bits.is_empty() && bits.bytes().all(|byte| byte.is_ascii_digit());
    }
    let Some(quant) = suffix
        .strip_prefix("iq")
        .or_else(|| suffix.strip_prefix('q'))
    else {
        return false;
    };
    let mut parts = quant.split('_');
    let digits = parts.next().unwrap_or_default();
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && parts
            .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn availability_key(value: &str) -> String {
    let value = value.trim().to_lowercase();
    value
        .split_once('/')
        .map(|(provider, id)| format!("{}/{}", normalize_provider(provider), id))
        .unwrap_or(value)
}

pub fn find_catalog_entry<'a>(catalog: &'a [ModelChoice], value: &str) -> Option<&'a ModelChoice> {
    let value = split_model_auth_profile(value).0;
    if value.is_empty() {
        return None;
    }
    let key = availability_key(value);
    let qualified: Vec<_> = catalog
        .iter()
        .filter(|entry| availability_key(&entry.reference()) == key)
        .collect();
    if !qualified.is_empty() {
        return qualified
            .iter()
            .copied()
            .find(|entry| entry.provider.trim().eq_ignore_ascii_case("openai"))
            .or_else(|| qualified.first().copied());
    }
    let mut matches = catalog
        .iter()
        .filter(|entry| entry.id.trim().eq_ignore_ascii_case(value));
    let first = matches.next();
    if matches.next().is_none() {
        first
    } else {
        None
    }
}

/// An alternative is a complete capability projection, never a partial overlay of the base harness.
pub fn resolve_runtime_entry(entry: &ModelChoice, runtime: Option<&str>) -> Option<ModelChoice> {
    if runtime.is_none() || entry.agent_runtime.as_ref().map(|route| route.id.as_str()) == runtime {
        return Some(entry.clone());
    }
    let choice = entry
        .runtime_choices
        .iter()
        .find(|choice| Some(choice.agent_runtime.id.as_str()) == runtime)?;
    Some(ModelChoice {
        id: entry.id.clone(),
        name: entry.name.clone(),
        provider: entry.provider.clone(),
        alias: entry.alias.clone(),
        tags: entry.tags.clone(),
        available: choice.available,
        manual_selection_allowed: choice.manual_selection_allowed,
        unavailable_reason: choice.unavailable_reason.clone(),
        context_window: choice.context_window,
        context_tokens: choice.context_tokens,
        context_windows: choice.context_windows.clone(),
        context_window_default: choice.context_window_default.clone(),
        reasoning: choice.reasoning,
        thinking_levels: choice.thinking_levels.clone(),
        thinking_default: choice.thinking_default.clone(),
        effective_fast_mode: choice.effective_fast_mode,
        supports_fast_mode: choice.supports_fast_mode,
        supports_tools: choice.supports_tools,
        agent_runtime: Some(choice.agent_runtime.clone()),
        runtime_choices: Vec::new(),
    })
}

fn catalog_name(entry: &ModelChoice) -> String {
    let name = entry.name.trim();
    let alias = entry.alias.as_deref().unwrap_or("").trim();
    if name.is_empty() {
        return alias.to_owned();
    }
    if alias.is_empty() || alias.eq_ignore_ascii_case(name) {
        return name.to_owned();
    }
    if alias.to_lowercase().contains(&name.to_lowercase()) {
        alias.to_owned()
    } else {
        format!("{name} · {alias}")
    }
}

fn catalog_labels(catalog: &[&ModelChoice]) -> HashMap<String, String> {
    let mut names: HashMap<String, HashSet<String>> = HashMap::new();
    let mut providers: HashMap<(String, String), HashSet<String>> = HashMap::new();
    for entry in catalog {
        let name = catalog_name(entry).to_lowercase();
        let key = availability_key(&entry.reference());
        names.entry(name.clone()).or_default().insert(key.clone());
        providers
            .entry((name, entry.provider.trim().to_lowercase()))
            .or_default()
            .insert(key);
    }
    catalog
        .iter()
        .map(|entry| {
            let name = catalog_name(entry);
            let lower = name.to_lowercase();
            let provider = entry.provider.trim();
            let label = if normalize_provider(provider) == "openai" && !entry.name.trim().is_empty()
            {
                entry.name.trim().to_owned()
            } else if name.is_empty() {
                format!("{} · {provider}", entry.id)
            } else if names.get(&lower).is_none_or(|values| values.len() <= 1) {
                name
            } else if providers
                .get(&(lower, provider.to_lowercase()))
                .is_none_or(|values| values.len() <= 1)
            {
                format!("{name} · {provider}")
            } else {
                format!("{name} · {} · {provider}", entry.id)
            };
            (entry.reference().to_lowercase(), label)
        })
        .collect()
}

pub fn build_picker_options(
    catalog: &[ModelChoice],
    default_ref: &str,
    current_ref: &str,
    runtime_locked: bool,
    session_pinned: bool,
    restricted: bool,
) -> Vec<PickerOption> {
    let available: HashSet<_> = catalog
        .iter()
        .filter(|entry| entry.available != Some(false))
        .map(|entry| availability_key(&entry.reference()))
        .collect();
    let mut retained: Vec<_> = catalog
        .iter()
        .filter(|entry| {
            entry.available != Some(false)
                || !available.contains(&availability_key(&entry.reference()))
        })
        .collect();
    let labels = catalog_labels(&retained);
    retained.sort_by_key(|entry| {
        (
            entry.available == Some(false),
            entry.provider.trim().to_lowercase() != normalize_provider(&entry.provider),
        )
    });
    let default_entry = find_catalog_entry(catalog, default_ref);
    let default_key = default_entry
        .map(|entry| availability_key(&entry.reference()))
        .unwrap_or_else(|| availability_key(default_ref));
    let mut seen = HashSet::new();
    let mut options = Vec::new();
    for entry in retained {
        let value = entry.reference();
        if entry.manual_selection_allowed == Some(false)
            || value.is_empty()
            || !seen.insert(value.to_lowercase())
        {
            continue;
        }
        let is_default = availability_key(&value) == default_key;
        let runtime_specific = !runtime_locked && !entry.runtime_choices.is_empty();
        let runtime = entry.agent_runtime.as_ref();
        let show_runtime = runtime_specific
            || runtime.is_some_and(|route| {
                matches!(route.source.as_str(), "model" | "provider")
                    || route.id == "claude-cli"
                    || entry.provider == "anthropic"
            });
        let label = labels
            .get(&value.to_lowercase())
            .cloned()
            .unwrap_or_else(|| entry.name.clone());
        let provider = provider_group(&entry.provider);
        options.push(PickerOption {
            commit_value: if is_default {
                String::new()
            } else {
                value.clone()
            },
            value: value.clone(),
            label: label.clone(),
            provider: provider.clone(),
            is_default,
            disabled: entry.available == Some(false),
            unavailable_reason: entry.unavailable_reason.clone(),
            agent_runtime: if runtime_specific {
                runtime.map(|route| route.id.clone())
            } else {
                None
            },
            agent_runtime_id: if show_runtime {
                runtime.map(|route| route.id.clone())
            } else {
                None
            },
            runtime_override: None,
            runtime_specific,
            context_window: entry.context_window,
            context_tokens: None,
            supports_tools: entry.supports_tools,
        });
        if runtime_locked {
            continue;
        }
        for choice in &entry.runtime_choices {
            if choice.manual_selection_allowed == Some(false) {
                continue;
            }
            options.push(PickerOption {
                value: value.clone(),
                commit_value: value.clone(),
                label: label.clone(),
                provider: provider.clone(),
                agent_runtime: Some(choice.agent_runtime.id.clone()),
                agent_runtime_id: Some(choice.agent_runtime.id.clone()),
                runtime_override: Some(choice.agent_runtime.id.clone()),
                runtime_specific: true,
                disabled: choice.available == Some(false),
                unavailable_reason: choice.unavailable_reason.clone(),
                context_window: choice.context_window,
                supports_tools: choice.supports_tools,
                ..Default::default()
            });
        }
    }
    if !default_ref.is_empty()
        && (session_pinned || restricted)
        && !options.iter().any(|option| option.is_default)
    {
        options.insert(
            0,
            PickerOption {
                value: default_ref.to_owned(),
                label: default_entry
                    .map(|entry| entry.name.clone())
                    .unwrap_or_else(|| {
                        default_ref
                            .split_once('/')
                            .map(|(provider, model)| format!("{model} · {provider}"))
                            .unwrap_or_else(|| default_ref.to_owned())
                    }),
                provider: provider_group(
                    default_entry
                        .map(|entry| entry.provider.as_str())
                        .unwrap_or_else(|| {
                            default_ref
                                .split_once('/')
                                .map_or("other", |(provider, _)| provider)
                        }),
                ),
                is_default: true,
                ..Default::default()
            },
        );
    }
    let current = split_model_auth_profile(current_ref).0;
    if !current.is_empty()
        && !restricted
        && !options.is_empty()
        && !options.iter().any(|option| option.value == current)
        && find_catalog_entry(catalog, current)
            .is_none_or(|entry| entry.manual_selection_allowed != Some(false))
    {
        options.push(PickerOption {
            value: current.into(),
            commit_value: current.into(),
            label: current.into(),
            provider: provider_group(
                current
                    .split_once('/')
                    .map_or("other", |(provider, _)| provider),
            ),
            ..Default::default()
        });
    }
    options
}

pub fn group_picker_options(options: &[PickerOption]) -> Vec<PickerGroup> {
    let mut groups: Vec<PickerGroup> = Vec::new();
    for option in options {
        let group = if let Some(index) = groups
            .iter()
            .position(|group| group.provider == option.provider)
        {
            &mut groups[index]
        } else {
            groups.push(PickerGroup {
                provider: option.provider.clone(),
                label: provider_label(&option.provider),
                options: Vec::new(),
            });
            groups.last_mut().expect("inserted provider group")
        };
        if option.is_default {
            group.options.insert(0, option.clone());
        } else {
            group.options.push(option.clone());
        }
    }
    if let Some(index) = groups
        .iter()
        .position(|group| group.options.iter().any(|option| option.is_default))
    {
        let default = groups.remove(index);
        groups.insert(0, default);
    }
    groups
}

/// Shared ordering for model names, runtime/Default keywords, account descriptions, and references.
pub fn picker_search_rank(
    name: &str,
    keywords: &str,
    provider: &str,
    reference: &str,
    query: &str,
) -> Option<u8> {
    let query = query.trim().to_lowercase();
    let name = name.to_lowercase();
    let provider = provider.to_lowercase();
    if name.starts_with(&query) {
        Some(0)
    } else if name.contains(&query) {
        Some(1)
    } else if keywords.to_lowercase().contains(&query) {
        Some(2)
    } else if provider.starts_with(&query) {
        Some(3)
    } else if provider.contains(&query) {
        Some(4)
    } else if reference.to_lowercase().contains(&query) {
        Some(5)
    } else {
        None
    }
}

pub fn selection_patch(option: &PickerOption, auth_profile_id: Option<&str>) -> Value {
    let model = if let Some(profile) = auth_profile_id.filter(|id| !id.is_empty()) {
        Value::String(format!(
            "{}@{profile}",
            split_model_auth_profile(&option.value).0
        ))
    } else if option.commit_value.is_empty() {
        Value::Null
    } else {
        Value::String(option.commit_value.clone())
    };
    let mut patch = json!({"model": model});
    if auth_profile_id.is_none() && (option.is_default || option.runtime_specific) {
        patch["agentRuntime"] = json!(option.runtime_override);
    }
    patch
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThinkingOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug)]
pub struct ThinkingState {
    pub options: Vec<ThinkingOption>,
    pub value: String,
    pub label: String,
    pub inherited_label: String,
    pub selected_index: Option<usize>,
    pub override_active: bool,
}

fn known_thinking_level(raw: &str) -> Option<&'static str> {
    let key = raw.trim().to_lowercase();
    let collapsed: String = key
        .chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '_' | '-'))
        .collect();
    match collapsed.as_str() {
        "adaptive" | "auto" => return Some("adaptive"),
        "maximum" | "max" => return Some("max"),
        "xhigh" | "extrahigh" => return Some("xhigh"),
        "ultra" => return Some("ultra"),
        _ => {}
    }
    Some(match key.as_str() {
        "off" | "none" => "off",
        "on" | "enable" | "enabled" | "low" | "thinkhard" | "think-hard" | "think_hard" => "low",
        "min" | "minimal" | "think" => "minimal",
        "mid" | "med" | "medium" | "thinkharder" | "think-harder" | "harder" => "medium",
        "high" | "ultrathink" | "thinkhardest" | "highest" => "high",
        _ => return None,
    })
}

pub fn normalize_thinking(raw: &str) -> String {
    known_thinking_level(raw)
        .map(str::to_owned)
        .unwrap_or_else(|| raw.trim().to_lowercase())
}

fn thinking_label(value: &str) -> String {
    let value = value.trim();
    if matches!(
        value.trim().to_lowercase().as_str(),
        "on" | "enable" | "enabled"
    ) {
        return "On".into();
    }
    match normalize_thinking(value).as_str() {
        "xhigh" => "Extra high".into(),
        "max" => "Maximum".into(),
        "" | "off" => "Off".into(),
        "adaptive" | "minimal" | "low" | "medium" | "high" | "ultra" => {
            capitalize(&normalize_thinking(value))
        }
        _ => capitalize(value),
    }
}

pub fn thinking_state(
    levels: &[ThinkingLevel],
    default_level: Option<&str>,
    reasoning: Option<bool>,
    current_override: Option<&str>,
) -> ThinkingState {
    let non_reasoning = reasoning == Some(false)
        && !levels.is_empty()
        && levels
            .iter()
            .all(|level| normalize_thinking(&level.id) == "off");
    let mut seen = HashSet::new();
    let options: Vec<_> = levels
        .iter()
        .filter(|_| !non_reasoning)
        .filter_map(|level| {
            let value = normalize_thinking(&level.id);
            if value.is_empty() || !seen.insert(value.clone()) {
                return None;
            }
            let label = if value == "off" {
                "Off".into()
            } else {
                thinking_label(if level.label.trim().is_empty() {
                    &value
                } else {
                    &level.label
                })
            };
            Some(ThinkingOption { value, label })
        })
        .collect();
    let inherited_value = normalize_thinking(default_level.unwrap_or(""));
    let inherited_label = if inherited_value.is_empty() {
        "Unknown".into()
    } else {
        thinking_label(&inherited_value)
    };
    let persisted = current_override.unwrap_or("").trim();
    let mut override_value = known_thinking_level(persisted)
        .unwrap_or(persisted)
        .to_owned();
    if non_reasoning && override_value == "off" {
        override_value.clear();
    }
    let override_active = !override_value.is_empty();
    let value = if override_active {
        override_value
    } else {
        inherited_value.clone()
    };
    let selected_index = options.iter().position(|option| option.value == value);
    let label = if override_active {
        selected_index
            .map(|index| options[index].label.clone())
            .unwrap_or_else(|| thinking_label(&normalize_thinking(&value)))
    } else {
        inherited_label.clone()
    };
    ThinkingState {
        options,
        value,
        label,
        inherited_label,
        selected_index,
        override_active,
    }
}

#[derive(Clone, Debug)]
pub struct FastModeState {
    pub supported: bool,
    pub active: bool,
    pub label: &'static str,
    pub next: Option<FastMode>,
}

pub fn fast_mode_state(
    entry: Option<&ModelChoice>,
    provider: &str,
    configured: Option<FastMode>,
    effective: Option<FastMode>,
) -> FastModeState {
    let provider = normalize_provider(provider);
    let request_supported = entry
        .and_then(|entry| entry.supports_fast_mode)
        .unwrap_or(matches!(
            provider.as_str(),
            "anthropic" | "minimax" | "minimax-portal" | "openai" | "xai"
        ));
    let mode = effective.or(configured);
    let active = matches!(mode, Some(FastMode::On | FastMode::Auto));
    let label = match mode {
        Some(FastMode::Auto) => "Auto",
        Some(FastMode::On) => "Fast",
        Some(FastMode::Off) | None if provider == "openai" || configured == Some(FastMode::Off) => {
            "Standard"
        }
        Some(FastMode::Off) | None => "Default",
    };
    FastModeState {
        supported: request_supported || configured.is_some(),
        active,
        label,
        next: if !request_supported {
            None
        } else if active {
            Some(FastMode::Off)
        } else {
            Some(FastMode::On)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gateway::composer_rpc::{AgentRuntime, ModelRuntimeChoice, ModelsResult};

    fn model(provider: &str, id: &str, name: &str) -> ModelChoice {
        ModelChoice {
            provider: provider.into(),
            id: id.into(),
            name: name.into(),
            ..Default::default()
        }
    }

    #[test]
    fn catalog_groups_default_first_preserves_routes_and_excludes_forbidden_choices() {
        let mut unavailable_alias = model("openai-codex", "sample", "Duplicate unavailable");
        unavailable_alias.available = Some(false);
        let mut forbidden = model("private", "hidden", "Restricted");
        forbidden.manual_selection_allowed = Some(false);
        let mut base = model("anthropic", "claude-example", "Claude Example");
        base.agent_runtime = Some(AgentRuntime {
            id: "openclaw".into(),
            source: "provider".into(),
        });
        base.runtime_choices = vec![ModelRuntimeChoice {
            agent_runtime: AgentRuntime {
                id: "claude-cli".into(),
                source: "session".into(),
            },
            available: Some(false),
            unavailable_reason: Some("unsupported-runtime".into()),
            ..Default::default()
        }];
        let catalog = vec![
            model("google-gemini-cli", "sample", "Gemini Sample"),
            base,
            forbidden,
            unavailable_alias,
            model("openai", "sample", "Sample"),
        ];
        let options = build_picker_options(
            &catalog,
            "anthropic/claude-example",
            "",
            false,
            false,
            false,
        );
        let groups = group_picker_options(&options);
        assert_eq!(
            groups
                .iter()
                .map(|group| group.provider.as_str())
                .collect::<Vec<_>>(),
            ["anthropic", "google", "openai"]
        );
        assert_eq!(groups[0].options.len(), 2);
        assert!(groups[0].options[0].is_default);
        assert_eq!(groups[0].options[0].runtime_label(), "API · OpenClaw");
        assert_eq!(
            groups[0].options[1].unavailable_reason.as_deref(),
            Some("unsupported-runtime")
        );
        assert!(!groups[0].options[1].selectable(false));
        assert_eq!(groups[2].options[0].label, "Sample");
        assert_eq!(options.len(), 4);
        assert_eq!(
            build_picker_options(&catalog, "anthropic/claude-example", "", true, false, false)
                .len(),
            3
        );
    }

    #[test]
    fn search_ranks_model_names_then_runtime_and_account_descriptions_then_provider_and_reference()
    {
        let rows = [
            ("Ordinary", "", "OpenAI", "openai/first"),
            ("Elsewhere", "", "Other", "other/openai-reference"),
            ("My OpenAI example", "", "Other", "other/name"),
            ("OpenAI example", "", "Other", "other/prefix"),
            ("Chosen", "Default Codex", "Other", "other/default"),
            (
                "Personal",
                "mail+openai@example.test",
                "account",
                "account:personal",
            ),
        ];
        let ranks = rows
            .iter()
            .map(|(name, keywords, provider, reference)| {
                picker_search_rank(name, keywords, provider, reference, " OpenAI ")
            })
            .collect::<Vec<_>>();
        assert_eq!(ranks, [Some(3), Some(5), Some(1), Some(0), None, Some(2)]);
        assert_eq!(
            picker_search_rank(
                "Chosen",
                "Default Codex",
                "Other",
                "other/default",
                "default"
            ),
            Some(2)
        );
        assert_eq!(
            picker_search_rank("Chosen", "Default Codex", "Other", "other/default", "codex"),
            Some(2)
        );
        assert_eq!(
            picker_search_rank(
                "Personal",
                "mail@example.test",
                "account",
                "account:personal",
                "no match"
            ),
            None
        );
    }

    #[test]
    fn effort_uses_catalog_order_normalizes_aliases_and_keeps_unknown_selection_unanchored() {
        let levels = [
            ThinkingLevel {
                id: "none".into(),
                label: "None".into(),
            },
            ThinkingLevel {
                id: "on".into(),
                label: "On".into(),
            },
            ThinkingLevel {
                id: "low".into(),
                label: "Low".into(),
            },
            ThinkingLevel {
                id: "extra-high".into(),
                label: "Extra High".into(),
            },
            ThinkingLevel {
                id: "maximum".into(),
                label: "Maximum".into(),
            },
        ];
        let inherited = thinking_state(&levels, Some("on"), Some(true), None);
        assert_eq!(
            inherited
                .options
                .iter()
                .map(|level| (level.value.as_str(), level.label.as_str()))
                .collect::<Vec<_>>(),
            [
                ("off", "Off"),
                ("low", "On"),
                ("xhigh", "Extra high"),
                ("max", "Maximum")
            ]
        );
        assert_eq!(inherited.selected_index, Some(1));
        assert_eq!(inherited.label, "Low");
        assert!(!inherited.override_active);
        let pinned = thinking_state(&levels, Some("low"), Some(true), Some("extra_high"));
        assert_eq!(
            (
                pinned.selected_index,
                pinned.label.as_str(),
                pinned.override_active
            ),
            (Some(2), "Extra high", true)
        );
        let unanchored = thinking_state(&levels, Some("medium"), Some(true), Some("ultra"));
        assert_eq!(unanchored.selected_index, None);
        assert_eq!(unanchored.value, "ultra");
        let unsupported = thinking_state(&levels[..1], Some("off"), Some(false), Some("off"));
        assert!(unsupported.options.is_empty());
        assert!(!unsupported.override_active);
    }

    #[test]
    fn alternate_runtime_does_not_inherit_base_effort_context_or_speed() {
        let mut base = model("openai", "sample", "Sample");
        base.agent_runtime = Some(AgentRuntime {
            id: "codex".into(),
            source: "provider".into(),
        });
        base.thinking_levels = Some(vec![ThinkingLevel {
            id: "high".into(),
            label: "High".into(),
        }]);
        base.thinking_default = Some("high".into());
        base.supports_fast_mode = Some(true);
        base.context_window = Some(1_000_000);
        base.runtime_choices = vec![ModelRuntimeChoice {
            agent_runtime: AgentRuntime {
                id: "openclaw".into(),
                source: "model".into(),
            },
            ..Default::default()
        }];
        let alternative = resolve_runtime_entry(&base, Some("openclaw")).unwrap();
        assert!(alternative.thinking_levels.is_none());
        assert_eq!(alternative.thinking_default, None);
        assert_eq!(alternative.context_window, None);
        assert_eq!(alternative.supports_fast_mode, None);
        assert!(resolve_runtime_entry(&base, Some("unknown")).is_none());
        base.runtime_choices[0].thinking_levels = Some(Vec::new());
        let unsupported = resolve_runtime_entry(&base, Some("openclaw")).unwrap();
        assert_eq!(unsupported.thinking_levels, Some(Vec::new()));
    }

    #[test]
    fn selection_wire_contract_distinguishes_default_runtime_pin_and_account_pin() {
        for (reference, model, profile) in [
            (
                "openai/sample@20251001@profile:mail@example.test",
                "openai/sample@20251001",
                Some("profile:mail@example.test"),
            ),
            (
                "lmstudio/model@iq3_xxs@work",
                "lmstudio/model@iq3_xxs",
                Some("work"),
            ),
            ("lmstudio/model@q8_0", "lmstudio/model@q8_0", None),
            ("cloudflare/@cf/model", "cloudflare/@cf/model", None),
            ("provider/model@20251001", "provider/model@20251001", None),
        ] {
            assert_eq!(split_model_auth_profile(reference), (model, profile));
            let option = PickerOption {
                value: reference.into(),
                commit_value: reference.into(),
                ..Default::default()
            };
            assert_eq!(
                selection_patch(&option, Some("chosen"))["model"],
                format!("{model}@chosen")
            );
        }
        let catalog = [model("local", "available", "Available")];
        let ordinary = build_picker_options(&catalog, "remote/missing", "", false, false, false);
        assert!(!ordinary.iter().any(|option| option.is_default));
        let reset = build_picker_options(&catalog, "remote/missing", "", false, true, false);
        assert!(reset[0].is_default);
        assert_eq!(reset[0].label, "missing · remote");
        assert_eq!(
            selection_patch(&reset[0], None),
            json!({"model":null,"agentRuntime":null})
        );
        let restricted = build_picker_options(&catalog, "", "remote/missing", false, true, true);
        assert_eq!(restricted.len(), 1);
        assert!(!restricted[0].is_default);
        let base = PickerOption {
            value: "anthropic/claude-example".into(),
            is_default: true,
            runtime_specific: true,
            agent_runtime: Some("openclaw".into()),
            ..Default::default()
        };
        assert_eq!(
            selection_patch(&base, None),
            json!({"model":null,"agentRuntime":null})
        );
        assert_eq!(
            selection_patch(&base, Some("personal:sample")),
            json!({"model":"anthropic/claude-example@personal:sample"})
        );
        let alternate = PickerOption {
            commit_value: base.value.clone(),
            runtime_override: Some("claude-cli".into()),
            is_default: false,
            ..base
        };
        assert_eq!(
            selection_patch(&alternate, None),
            json!({"model":"anthropic/claude-example","agentRuntime":"claude-cli"})
        );
        let mut unavailable = alternate;
        unavailable.is_default = true;
        unavailable.disabled = true;
        assert!(!unavailable.selectable(false));
        assert!(unavailable.selectable(true));
    }

    #[test]
    fn gateway_catalog_and_speed_preserve_false_auto_and_runtime_capabilities() {
        let result: ModelsResult = serde_json::from_value(json!({"models":[{"id":"sample","name":"Sample","provider":"openai","effectiveFastMode":"auto","supportsFastMode":false,"runtimeChoices":[{"agentRuntime":{"id":"openclaw","source":"model"},"thinkingLevels":[{"id":"off","label":"Off"}],"contextWindows":[{"id":"long","label":"1M","contextWindow":1000000}]}]}]})).unwrap();
        let entry = &result.models[0];
        assert!(entry.thinking_levels.is_none());
        assert_eq!(
            entry.runtime_choices[0].thinking_levels.as_deref().unwrap()[0].id,
            "off"
        );
        let unsupported: ModelChoice = serde_json::from_value(
            json!({"id":"unsupported","name":"Unsupported","provider":"local","thinkingLevels":[]}),
        )
        .unwrap();
        assert_eq!(unsupported.thinking_levels, Some(Vec::new()));
        let speed = fast_mode_state(
            Some(entry),
            "openai",
            Some(FastMode::Auto),
            entry.effective_fast_mode,
        );
        assert!(speed.supported);
        assert!(speed.active);
        assert_eq!(speed.label, "Auto");
        assert_eq!(speed.next, None);
        let inherited = fast_mode_state(None, "anthropic", None, Some(FastMode::Off));
        assert_eq!(inherited.label, "Default");
        assert_eq!(inherited.next, Some(FastMode::On));
        assert_eq!(
            fast_mode_state(None, "anthropic", Some(FastMode::Off), None).label,
            "Standard"
        );
        assert_eq!(
            entry.runtime_choices[0].context_windows[0].context_window,
            1_000_000
        );
        assert_eq!(serde_json::to_value(FastMode::Off).unwrap(), json!(false));
        assert_eq!(format_context_capacity(272_000), "272k");
        assert_eq!(format_context_capacity(1_048_576), "1M");
    }
}
