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
        ..Default::default()
    });
    base.runtime_choices = vec![ModelRuntimeChoice {
        agent_runtime: AgentRuntime {
            id: "claude-cli".into(),
            source: "session".into(),
            ..Default::default()
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
        build_picker_options(&catalog, "anthropic/claude-example", "", true, false, false).len(),
        3
    );
}

#[test]
fn search_ranks_model_names_then_runtime_and_account_descriptions_then_provider_and_reference() {
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
        ..Default::default()
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
            ..Default::default()
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
