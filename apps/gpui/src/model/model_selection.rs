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
mod tests {
    use super::*;

    #[test]
    fn model_references_follow_web_stale_hint_and_nested_id_precedence() {
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[
            {"provider":"other", "id":"shared-model", "name":"Shared"},
            {"provider":"other", "id":"shared-model", "name":"Duplicate route"},
            {"provider":"route", "id":"nested/model", "name":"Nested raw ID"},
            {"provider":"nested", "id":"model", "name":"Qualified reference"}
        ]}))
        .unwrap();
        for (model, provider, expected) in [
            ("shared-model", Some("openai"), "other/shared-model"),
            (" SHARED-model ", Some(" stale "), "other/shared-model"),
            ("shared-model", None, "other/shared-model"),
            ("other/shared-model", Some("openai"), "other/shared-model"),
            ("nested/model", Some("route"), "route/nested/model"),
            ("nested/model", Some("stale"), "nested/model"),
            ("nested/model", None, "nested/model"),
            ("openai/unlisted", Some("stale"), "openai/unlisted"),
            ("unlisted", Some(" local "), "local/unlisted"),
        ] {
            assert_eq!(
                model_reference(Some(model), provider, &catalog),
                expected,
                "model={model} provider={provider:?}"
            );
        }
        let ambiguous: ModelsResult = serde_json::from_value(json!({"models":[
            {"provider":"one", "id":"shared", "name":"One"},
            {"provider":"two", "id":"shared", "name":"Two"}
        ]}))
        .unwrap();
        assert_eq!(
            model_reference(Some("shared"), Some("hint"), &ambiguous),
            "hint/shared"
        );
    }

    #[test]
    fn draft_choices_are_isolated_by_gateway_agent_and_draft_and_preserve_other_settings() {
        let mut drafts = DraftSelections::default();
        let target = ModelControlsTarget {
            agent_id: "work".into(),
            draft_id: Some("one".into()),
            ..Default::default()
        };
        drafts.apply(
            "gateway-a",
            target.clone(),
            json!({"model":"openai/gpt-5", "thinkingLevel":"high"})
                .as_object()
                .unwrap(),
            "",
        );
        drafts.apply(
            "gateway-a",
            target.clone(),
            json!({"thinkingLevel":null}).as_object().unwrap(),
            "",
        );
        assert_eq!(
            drafts.read("gateway-a", &target),
            json!({"model":"openai/gpt-5", "thinkingLevel":null})
        );
        assert_eq!(drafts.read("gateway-b", &target), json!({}));
        assert_eq!(
            drafts.read(
                "gateway-a",
                &ModelControlsTarget {
                    agent_id: "personal".into(),
                    ..target.clone()
                }
            ),
            json!({})
        );
        assert_eq!(
            drafts.read(
                "gateway-a",
                &ModelControlsTarget {
                    draft_id: Some("two".into()),
                    ..target
                }
            ),
            json!({})
        );
    }

    #[test]
    fn draft_model_intents_replace_runtime_while_account_only_intents_preserve_it() {
        let target = ModelControlsTarget {
            agent_id: "work".into(),
            ..Default::default()
        };
        let seed = json!({"model":"local/old@personal:one", "agentRuntime":"old-runtime", "contextWindow":"large", "thinkingLevel":"high"});
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[{
            "provider":"local", "id":"new", "name":"New", "agentRuntime":{"id":"openclaw", "source":"provider"}, "thinkingLevels":[{"id":"high", "label":"High"}]
        }]})).unwrap();
        let mut drafts = DraftSelections::default();
        for (previous_model, expected_model) in [
            ("local/old", "local/new"),
            ("local/old@personal:one", "local/new@personal:one"),
        ] {
            let mut previous = seed.clone();
            previous["model"] = json!(previous_model);
            drafts.apply(
                "gateway",
                target.clone(),
                previous.as_object().unwrap(),
                "local/default",
            );
            let mut changed = drafts.apply(
                "gateway",
                target.clone(),
                json!({"model":"local/new"}).as_object().unwrap(),
                "local/default",
            );
            assert_eq!(changed["model"], expected_model);
            assert!(changed.get("agentRuntime").is_none());
            assert!(changed.get("contextWindow").is_none());
            reconcile_draft_selection(&mut changed, &catalog, &json!({}), "local/default");
            assert_eq!(changed["model"], expected_model);
            assert_eq!(changed["thinkingLevel"], "high");
        }

        drafts.apply(
            "gateway",
            target.clone(),
            seed.as_object().unwrap(),
            "local/default",
        );
        let account = drafts.apply(
            "gateway",
            target.clone(),
            json!({"model":"local/old@personal:two"})
                .as_object()
                .unwrap(),
            "local/default",
        );
        assert_eq!(account["agentRuntime"], "old-runtime");
        assert_eq!(account["contextWindow"], "large");
        let runtime = drafts.apply(
            "gateway",
            target,
            json!({"model":"local/new", "agentRuntime":"new-runtime"})
                .as_object()
                .unwrap(),
            "local/default",
        );
        assert_eq!(runtime["agentRuntime"], "new-runtime");
    }

    #[test]
    fn draft_model_changes_drop_unsupported_settings_but_preserve_unknown_thinking_profiles() {
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[
            {"id":"binary", "provider":"local", "name":"Binary", "reasoning":true, "thinkingLevels":[{"id":"high","label":"On"}], "supportsFastMode":false, "contextWindows":[{"id":"small","label":"Small","contextWindow":32000}]},
            {"id":"unknown", "provider":"local", "name":"Unknown"},
            {"id":"none", "provider":"local", "name":"None", "thinkingLevels":[]}
        ]})).unwrap();
        let mut binary = json!({"model":"local/binary", "thinkingLevel":"medium", "fastMode":true, "contextWindow":"large"});
        reconcile_draft_selection(&mut binary, &catalog, &json!({}), "");
        assert_eq!(binary, json!({"model":"local/binary"}));
        let mut supported =
            json!({"model":"local/binary", "thinkingLevel":"high", "contextWindow":"small"});
        reconcile_draft_selection(&mut supported, &catalog, &json!({}), "");
        assert_eq!(
            supported,
            json!({"model":"local/binary", "thinkingLevel":"high", "contextWindow":"small"})
        );
        let mut unknown = json!({"model":"local/unknown", "thinkingLevel":"medium"});
        reconcile_draft_selection(&mut unknown, &catalog, &json!({}), "");
        assert_eq!(unknown["thinkingLevel"], "medium");
        let mut unsupported = json!({"model":"local/none", "thinkingLevel":"medium"});
        reconcile_draft_selection(&mut unsupported, &catalog, &json!({}), "");
        assert!(unsupported.get("thinkingLevel").is_none());
    }

    #[test]
    fn draft_model_projection_uses_selected_runtime_without_losing_explicit_pins() {
        let draft = ModelControlsTarget {
            agent_id: "work".into(),
            ..Default::default()
        };
        let defaults = json!({"model":"default", "modelProvider":"anthropic", "agentRuntime":{"id":"claude-cli", "source":"agent"}});
        let catalog: ModelsResult = serde_json::from_value(json!({"models":[{
            "id":"selected", "provider":"local", "name":"Selected",
            "agentRuntime":{"id":"openclaw", "source":"provider"},
            "thinkingLevels":[{"id":"high", "label":"High"}],
            "runtimeChoices":[{"agentRuntime":{"id":"worker", "source":"session"}, "thinkingLevels":[{"id":"medium", "label":"Medium"}]}]
        }]})).unwrap();
        for patch in [
            json!({"model":"local/selected"}),
            json!({"model":"local/selected@personal:fixture"}),
        ] {
            let row = project_model_controls_row(&draft, None, None, &defaults, &patch);
            let entry = &catalog.models[0];
            let capabilities = resolve_runtime_entry(
                entry,
                row.agent_runtime
                    .as_ref()
                    .map(|runtime| runtime.id.as_str()),
            );
            assert_eq!(
                capabilities
                    .and_then(|entry| entry.thinking_levels)
                    .map(|levels| levels[0].id.clone())
                    .as_deref(),
                Some("high")
            );
        }
        let pinned = project_model_controls_row(
            &draft,
            None,
            None,
            &defaults,
            &json!({"model":"local/selected@personal:fixture", "agentRuntime":"worker"}),
        );
        assert_eq!(
            pinned
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str()),
            Some("worker")
        );
        assert_eq!(pinned.model.as_deref(), Some("selected"));
        let inherited = project_model_controls_row(&draft, None, None, &defaults, &json!({}));
        assert_eq!(
            inherited
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str()),
            Some("claude-cli")
        );
        let session_target = ModelControlsTarget {
            session_key: Some("agent:work:chat".into()),
            ..draft
        };
        let existing = project_model_controls_row(
            &session_target,
            Some(&inherited),
            None,
            &defaults,
            &json!({"model":"local/selected"}),
        );
        assert_eq!(
            existing
                .agent_runtime
                .as_ref()
                .map(|runtime| runtime.id.as_str()),
            Some("claude-cli")
        );
    }

    #[test]
    fn optimistic_model_and_runtime_changes_retire_old_capabilities_and_hide_account_suffix() {
        let mut row: SessionRow = serde_json::from_value(json!({
            "key":"agent:work:chat", "label":"Keep this label", "model":"old", "modelProvider":"anthropic",
            "agentRuntime":{"id":"claude-cli", "source":"session"},
            "thinkingLevels":[{"id":"high", "label":"High"}], "thinkingDefault":"high",
            "contextWindows":[{"id":"large", "label":"Large", "contextWindow":200000}]
        })).unwrap();
        project_selection(
            &mut row,
            &json!({"model":"openai/gpt-5@personal:fixture", "agentRuntime":null}),
            &json!({}),
        );
        assert_eq!(row.model.as_deref(), Some("gpt-5"));
        assert_eq!(row.model_provider.as_deref(), Some("openai"));
        assert_eq!(row.model_override_source.as_deref(), Some("user"));
        assert!(row.agent_runtime.is_none());
        assert!(row.thinking_levels.is_none());
        assert!(row.context_windows.is_none());
        assert_eq!(row.label.as_deref(), Some("Keep this label"));
        project_selection(
            &mut row,
            &json!({"model":null, "fastMode":false}),
            &json!({"model":"default-model", "modelProvider":"local"}),
        );
        assert_eq!(row.model.as_deref(), Some("default-model"));
        assert_eq!(row.model_provider.as_deref(), Some("local"));
        assert!(row.model_override_source.is_none());
        assert_eq!(
            row.effective_fast_mode,
            Some(crate::gateway::composer_rpc::FastMode::Off)
        );
    }

    #[test]
    fn scoped_settings_require_ownership_but_context_windows_require_admin() {
        let hello = json!({"features":{"methods":["sessions.patch"]}, "auth":{"role":"operator", "scopes":["operator.sessions.write"]}});
        let target = ModelControlsTarget {
            agent_id: "work".into(),
            session_key: Some("agent:work:chat".into()),
            ..Default::default()
        };
        let owner = SessionRow {
            sharing_role: Some("owner".into()),
            ..Default::default()
        };
        assert!(
            model_patch_access_reason(&hello, &target, Some(&owner), &json!({"model":null}))
                .is_none()
        );
        assert!(
            model_patch_access_reason(
                &hello,
                &target,
                Some(&owner),
                &json!({"contextWindow":null})
            )
            .is_some()
        );
        assert!(
            model_patch_access_reason(
                &hello,
                &target,
                Some(&SessionRow::default()),
                &json!({"thinkingLevel":"high"})
            )
            .is_some()
        );
        let draft = ModelControlsTarget {
            session_key: None,
            ..target
        };
        assert!(
            model_patch_access_reason(&hello, &draft, None, &json!({"thinkingLevel":"high"}))
                .is_none()
        );
        let admin = json!({"features":{"methods":["sessions.patch"]}, "auth":{"role":"operator", "scopes":["operator.admin"]}});
        assert!(
            model_patch_access_reason(&admin, &draft, None, &json!({"contextWindow":"large"}))
                .is_none()
        );
    }
}
