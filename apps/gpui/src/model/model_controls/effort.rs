use super::*;

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
