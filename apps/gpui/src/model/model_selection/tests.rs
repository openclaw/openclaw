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
                ..target.clone()
            }
        ),
        json!({})
    );
    drafts.remove("gateway-b", &target);
    assert_eq!(drafts.read("gateway-a", &target)["model"], "openai/gpt-5");
    drafts.remove("gateway-a", &target);
    assert_eq!(drafts.read("gateway-a", &target), json!({}));
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
        model_patch_access_reason(&hello, &target, Some(&owner), &json!({"model":null})).is_none()
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
        model_patch_access_reason(&hello, &draft, None, &json!({"thinkingLevel":"high"})).is_none()
    );
    let admin = json!({"features":{"methods":["sessions.patch"]}, "auth":{"role":"operator", "scopes":["operator.admin"]}});
    assert!(
        model_patch_access_reason(&admin, &draft, None, &json!({"contextWindow":"large"}))
            .is_none()
    );
}
