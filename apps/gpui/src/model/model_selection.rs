//! Draft model intent, canonical references, and session-setting projections.
use super::{
    model_controls::{
        ModelControlsTarget, fast_mode_state, find_catalog_entry, normalize_provider,
        normalize_thinking, resolve_runtime_entry, split_model_auth_profile,
    },
    sessions::SessionRow,
};
use crate::gateway::composer_rpc::{ModelSelectionPolicy, ModelsResult};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Default)]
pub(crate) struct DraftSelections {
    values: HashMap<(String, ModelControlsTarget), Value>,
}

impl DraftSelections {
    pub(crate) fn remove(&mut self, gateway: &str, target: &ModelControlsTarget) {
        self.values.remove(&(gateway.to_owned(), target.clone()));
    }

    pub(crate) fn read(&self, gateway: &str, target: &ModelControlsTarget) -> Value {
        self.values
            .get(&(gateway.to_owned(), target.clone()))
            .cloned()
            .unwrap_or_else(|| json!({}))
    }

    pub(crate) fn apply(
        &mut self,
        gateway: &str,
        target: ModelControlsTarget,
        fields: &serde_json::Map<String, Value>,
        default_reference: &str,
    ) -> Value {
        let draft = self
            .values
            .entry((gateway.to_owned(), target))
            .or_insert_with(|| json!({}));
        let previous_ref = draft.get("model").and_then(Value::as_str).unwrap_or("");
        let mut next = fields.clone();
        let mut ordinary_model_choice = false;
        if let Some(value) = fields.get("model") {
            let (model, explicit_account) = split_model_auth_profile(value.as_str().unwrap_or(""));
            ordinary_model_choice = explicit_account.is_none();
            let reference = if model.is_empty() {
                default_reference
            } else {
                model
            };
            let previous_account = split_model_auth_profile(previous_ref).1.filter(|_| {
                previous_ref.split_once('/').map(|(provider, _)| provider)
                    == reference.split_once('/').map(|(provider, _)| provider)
            });
            if let Some(account) = explicit_account.or(previous_account) {
                next.insert("model".into(), json!(format!("{reference}@{account}")));
            }
        }
        let draft_fields = draft.as_object_mut().expect("draft patch is an object");
        draft_fields.extend(next);
        if ordinary_model_choice {
            draft_fields.remove("contextWindow");
            if !fields.contains_key("agentRuntime") {
                draft_fields.remove("agentRuntime");
            }
        }
        draft.clone()
    }

    pub(crate) fn reconcile(
        &mut self,
        gateway: &str,
        target: &ModelControlsTarget,
        catalog: &ModelsResult,
        defaults: &Value,
        default_reference: &str,
    ) {
        let draft = self
            .values
            .entry((gateway.to_owned(), target.clone()))
            .or_insert_with(|| json!({}));
        reconcile_draft_selection(draft, catalog, defaults, default_reference);
    }

    pub(crate) fn clear_account(&mut self, gateway: &str, target: &ModelControlsTarget) -> bool {
        let Some(draft) = self.values.get_mut(&(gateway.to_owned(), target.clone())) else {
            return false;
        };
        let Some(value) = draft.get("model").and_then(Value::as_str) else {
            return false;
        };
        let (model, account) = split_model_auth_profile(value);
        if account.is_none() {
            return false;
        }
        draft["model"] = json!(model);
        true
    }
}

pub(crate) fn default_model_reference(catalog: &ModelsResult, defaults: &Value) -> String {
    if let Some(policy) = &catalog.model_selection_policy
        && policy.restricted
    {
        return policy.default_model.clone().unwrap_or_default();
    }
    model_reference(
        defaults.get("model").and_then(Value::as_str),
        defaults.get("modelProvider").and_then(Value::as_str),
        catalog,
    )
}

pub(crate) fn model_reference(
    model: Option<&str>,
    provider: Option<&str>,
    catalog: &ModelsResult,
) -> String {
    let model = model.unwrap_or_default().trim();
    if model.is_empty() {
        return String::new();
    }
    let normalized_model = model.to_lowercase();
    let unique_catalog_value = || {
        let mut matched: Option<String> = None;
        for entry in &catalog.models {
            if entry.id.trim().to_lowercase() != normalized_model {
                continue;
            }
            let candidate = entry.reference();
            if let Some(previous) = &matched {
                if previous.to_lowercase() != candidate.to_lowercase() {
                    return None;
                }
            } else {
                matched = Some(candidate);
            }
        }
        matched
    };
    let Some(provider) = provider
        .map(str::trim)
        .filter(|provider| !provider.is_empty())
    else {
        return if model.contains('/') {
            model.to_owned()
        } else {
            unique_catalog_value().unwrap_or_else(|| model.to_owned())
        };
    };
    let qualified = if normalized_model.starts_with(&format!("{}/", provider.to_lowercase())) {
        model.to_owned()
    } else {
        format!("{provider}/{model}")
    };
    if !model.contains('/') {
        return unique_catalog_value()
            .filter(|value| value != model)
            .unwrap_or(qualified);
    }
    let contains = |value: &str| {
        catalog
            .models
            .iter()
            .any(|entry| entry.reference().to_lowercase() == value.to_lowercase())
    };
    let provider_owns_raw_id = catalog.models.iter().any(|entry| {
        entry.id.trim().to_lowercase() == normalized_model
            && normalize_provider(&entry.provider) == normalize_provider(provider)
    });
    if provider_owns_raw_id && contains(&qualified) {
        return qualified;
    }
    if contains(model) {
        return model.to_owned();
    }
    if contains(&qualified) {
        return qualified;
    }
    unique_catalog_value().unwrap_or_else(|| model.to_owned())
}

fn reconcile_draft_selection(
    patch: &mut Value,
    catalog: &ModelsResult,
    defaults: &Value,
    default_reference: &str,
) {
    let requested = patch.get("model").and_then(Value::as_str).unwrap_or("");
    let (model, account) = split_model_auth_profile(requested);
    let reference = if model.is_empty() {
        default_reference
    } else {
        model
    };
    let runtime = patch.get("agentRuntime").and_then(Value::as_str);
    let entry = find_catalog_entry(&catalog.models, reference)
        .and_then(|entry| resolve_runtime_entry(entry, runtime));
    if !model.is_empty()
        && entry.as_ref().is_none_or(|entry| {
            entry.available == Some(false) || entry.manual_selection_allowed == Some(false)
        })
    {
        // An explicit account remains visible for correction if its scoped catalog cannot serve it.
        if account.is_none() {
            for field in [
                "model",
                "agentRuntime",
                "thinkingLevel",
                "fastMode",
                "contextWindow",
            ] {
                patch
                    .as_object_mut()
                    .expect("draft patch object")
                    .remove(field);
            }
        }
        return;
    }
    let provider = reference
        .split_once('/')
        .map(|(provider, _)| provider)
        .unwrap_or("");
    let fast_supported =
        provider.is_empty() || fast_mode_state(entry.as_ref(), provider, None, None).supported;
    let default_profile = model.is_empty()
        && runtime.is_none()
        && ["thinkingLevels", "thinkingOptions", "thinkingDefault"]
            .iter()
            .any(|key| defaults.get(key).is_some_and(|value| !value.is_null()));
    let levels: Option<Vec<String>> = if default_profile {
        defaults
            .get("thinkingLevels")
            .and_then(Value::as_array)
            .map(|levels| {
                levels
                    .iter()
                    .filter_map(|level| level.get("id").and_then(Value::as_str))
                    .map(normalize_thinking)
                    .collect()
            })
            .or_else(|| {
                defaults
                    .get("thinkingOptions")
                    .and_then(Value::as_array)
                    .map(|levels| {
                        levels
                            .iter()
                            .filter_map(Value::as_str)
                            .map(normalize_thinking)
                            .collect()
                    })
            })
    } else {
        entry
            .as_ref()
            .and_then(|entry| entry.thinking_levels.as_ref())
            .map(|levels| {
                levels
                    .iter()
                    .map(|level| normalize_thinking(&level.id))
                    .collect()
            })
    };
    let clear_thinking = entry
        .as_ref()
        .is_some_and(|entry| entry.reasoning == Some(false))
        || patch
            .get("thinkingLevel")
            .and_then(Value::as_str)
            .is_some_and(|value| {
                levels
                    .as_ref()
                    .is_some_and(|levels| !levels.contains(&normalize_thinking(value)))
            });
    let clear_context = patch
        .get("contextWindow")
        .and_then(Value::as_str)
        .is_some_and(|selected| {
            entry.as_ref().is_some_and(|entry| {
                !entry
                    .context_windows
                    .iter()
                    .any(|option| option.id == selected)
            })
        });
    if !fast_supported && patch.get("fastMode").is_some_and(|value| !value.is_null()) {
        patch
            .as_object_mut()
            .expect("draft patch object")
            .remove("fastMode");
    }
    if clear_thinking
        && patch
            .get("thinkingLevel")
            .is_some_and(|value| !value.is_null())
    {
        patch
            .as_object_mut()
            .expect("draft patch object")
            .remove("thinkingLevel");
    }
    if clear_context {
        patch
            .as_object_mut()
            .expect("draft patch object")
            .remove("contextWindow");
    }
}

pub(crate) fn model_patch_access_reason(
    hello: &Value,
    target: &ModelControlsTarget,
    row: Option<&SessionRow>,
    patch: &Value,
) -> Option<String> {
    if !hello
        .pointer("/features/methods")
        .and_then(Value::as_array)
        .is_some_and(|methods| methods.iter().any(|method| method == "sessions.patch"))
    {
        return Some("This Gateway does not support changing session settings.".into());
    }
    let scopes = hello.pointer("/auth/scopes").and_then(Value::as_array);
    let has_scope =
        |scope: &str| scopes.is_some_and(|scopes| scopes.iter().any(|value| value == scope));
    let admin = has_scope("operator.admin");
    if hello
        .pointer("/auth/role")
        .and_then(Value::as_str)
        .is_some_and(|role| role != "operator")
    {
        return Some("Session settings require operator access.".into());
    }
    if patch.get("contextWindow").is_some() {
        return (!admin).then(|| "Changing context window requires operator.admin access.".into());
    }
    if admin || has_scope("operator.write") {
        return None;
    }
    if !has_scope("operator.sessions.write") {
        return Some("Changing session settings requires operator.sessions.write access.".into());
    }
    if target.session_key.is_some()
        && !row.is_some_and(|row| matches!(row.sharing_role.as_deref(), Some("owner" | "admin")))
    {
        return Some("Only the session owner can change these settings.".into());
    }
    None
}

pub(crate) fn project_model_controls_row(
    target: &ModelControlsTarget,
    base: Option<&SessionRow>,
    policy: Option<&ModelSelectionPolicy>,
    defaults: &Value,
    patch: &Value,
) -> SessionRow {
    let mut defaults = defaults.clone();
    if let Some(policy) = policy
        && policy.restricted
    {
        defaults["model"] = json!(policy.default_model);
        defaults["modelProvider"] = Value::Null;
    }
    let mut row = base.cloned().unwrap_or_else(|| {
        let mut row: SessionRow = serde_json::from_value(defaults.clone()).unwrap_or_default();
        row.agent_id = Some(target.agent_id.clone());
        row.key = target.session_key.clone().unwrap_or_default();
        row
    });
    if target.session_key.is_none()
        && patch.get("model").and_then(Value::as_str).is_some()
        && patch.get("agentRuntime").is_none()
    {
        // A draft model owns its configured route; the previous default is not a runtime pin.
        row.agent_runtime = None;
    }
    project_selection(&mut row, patch, &defaults);
    row
}

fn project_selection(row: &mut SessionRow, patch: &Value, defaults: &Value) {
    let Some(fields) = patch.as_object() else {
        return;
    };
    let mut projected = fields.clone();
    if let Some(value) = fields.get("model") {
        let model = value
            .as_str()
            .map(|value| split_model_auth_profile(value).0);
        if let Some(model) = model {
            projected.insert("model".into(), json!(model));
            if let Some((provider, model)) = model.split_once('/') {
                projected.insert("model".into(), json!(model));
                projected.insert("modelProvider".into(), json!(provider));
            }
            projected.insert("modelOverrideSource".into(), json!("user"));
        } else {
            projected.insert(
                "model".into(),
                defaults.get("model").cloned().unwrap_or(Value::Null),
            );
            projected.insert(
                "modelProvider".into(),
                defaults
                    .get("modelProvider")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            projected.insert("modelOverrideSource".into(), Value::Null);
        }
        for field in [
            "thinkingLevels",
            "thinkingOptions",
            "thinkingDefault",
            "contextWindows",
            "contextWindowDefault",
            "activeModel",
            "activeModelProvider",
        ] {
            projected.insert(field.into(), Value::Null);
        }
    }
    if let Some(runtime) = fields.get("agentRuntime") {
        projected.insert(
            "agentRuntime".into(),
            runtime
                .as_str()
                .map(|id| json!({"id": id, "source": "session"}))
                .unwrap_or(Value::Null),
        );
        for field in [
            "thinkingLevels",
            "thinkingOptions",
            "thinkingDefault",
            "contextWindows",
            "contextWindowDefault",
        ] {
            projected.insert(field.into(), Value::Null);
        }
    }
    if let Some(value) = fields.get("fastMode") {
        projected.insert("effectiveFastMode".into(), value.clone());
    }
    row.apply_patch(&Value::Object(projected));
}

#[cfg(test)]
mod tests;
