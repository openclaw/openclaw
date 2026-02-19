# ADR-002: Wizard Extension — Cloud.ru FM Auth Choice

## Status: ACCEPTED

## Date: 2026-02-13 (v2 — updated with DDD analysis + research findings)

## Bounded Context: Wizard Configuration (Onboarding)

## Context

OpenClaw's installation wizard (`configure.wizard.ts`) supports 18+ auth provider
groups (OpenAI, Anthropic, Google, Z.AI, etc.) via a two-step selection flow:

1. Select provider group (`promptAuthChoiceGrouped`)
2. Select specific auth method within group

Users who want to use Cloud.ru Evolution Foundation Models need a first-class
wizard experience that auto-configures both the cloud.ru provider AND the
`claude-cli` backend with proxy settings.

### Why First-Class (Not "Custom Provider")

From research:

- Cloud.ru is the only platform providing GPT-class models legally in Russia
- GLM-4.7-Flash is free — removes financial barrier completely
- MAX Messenger integration makes Cloud.ru the primary backend for Russian users
- Custom Provider flow doesn't handle Docker proxy setup or model presets

### Current Wizard Architecture

```
onboard-types.ts       -> AuthChoice union type (47+ members)
auth-choice-options.ts -> AuthChoiceGroupId union + AUTH_CHOICE_GROUP_DEFS array
auth-choice-prompt.ts  -> promptAuthChoiceGrouped() 2-step selection
auth-choice.apply.ts   -> Handler chain: Array<(p) => Promise<Result | null>>
```

### DDD: Handler Chain Pattern (CRITICAL)

Every auth handler MUST follow the pattern established by `auth-choice.apply.xai.ts`:

```typescript
1. Guard clause: if (authChoice !== "my-choice") return null;
2. Credential resolution: opts -> env -> prompt
3. applyAuthProfileConfig(config, { profileId, provider, mode })
4. applyDefaultModelChoice({ config, setDefaultModel, defaultModel, ... })
5. Return { config, agentModelOverride }
```

**CRIT-06 from brutal honesty**: Previous implementation missed steps 3 and 4.

## Decision

Add a `"cloudru-fm"` auth choice group to the wizard with 3 sub-choices:

| Choice ID          | Label                | Preset                                   | Free |
| ------------------ | -------------------- | ---------------------------------------- | ---- |
| `cloudru-fm-glm47` | GLM-4.7 (Full)       | BIG=GLM-4.7, MID=FlashX, SMALL=Flash     | No   |
| `cloudru-fm-flash` | GLM-4.7-Flash (Free) | All tiers = GLM-4.7-Flash                | Yes  |
| `cloudru-fm-qwen`  | Qwen3-Coder-480B     | BIG=Qwen3-Coder, MID=FlashX, SMALL=Flash | No   |

### Type Extensions (Already Implemented)

```typescript
// onboard-types.ts — 3 new AuthChoice values
| "cloudru-fm-glm47" | "cloudru-fm-flash" | "cloudru-fm-qwen"

// auth-choice-options.ts — new AuthChoiceGroupId
| "cloudru-fm"

// auth-choice-options.ts — AUTH_CHOICE_GROUP_DEFS entry
{ value: "cloudru-fm", label: "Cloud.ru FM",
  hint: "GLM-4.7 / Qwen3 via Claude Code proxy",
  choices: ["cloudru-fm-glm47", "cloudru-fm-flash", "cloudru-fm-qwen"] }

// auth-choice.apply.ts — handler registered in chain
applyAuthChoiceCloudruFm
```

### Wizard Flow

```
Step 1: Provider group -> "Cloud.ru FM"
Step 2: Model preset -> "GLM-4.7-Flash (Free)" [default]
Step 3: API Key -> [paste cloud.ru API key or use env CLOUDRU_API_KEY]
Step 4: applyAuthProfileConfig(config, { profileId: "cloudru-fm:default", provider: "cloudru-fm", mode: "api_key" })
Step 5: applyDefaultModelChoice with model ref from constants
Step 6: Return { config, agentModelOverride }
```

### Config Schema (CORRECT — per DDD analysis)

```typescript
// models.providers["cloudru-fm"] — Record<string, ProviderConfig>
cfg.models.providers["cloudru-fm"] = {
  baseUrl: "http://localhost:8082",
  api: "anthropic",
  apiKey: CLOUDRU_PROXY_SENTINEL_KEY,
  models: [preset.big, preset.middle, preset.small],
};

// auth.profiles["cloudru-fm:default"]
cfg.auth.profiles["cloudru-fm:default"] = {
  provider: "cloudru-fm",
  mode: "api_key",
};

// agents.defaults.cliBackends["claude-cli"].env
cfg.agents.defaults.cliBackends["claude-cli"].env = {
  ANTHROPIC_BASE_URL: "http://localhost:8082",
  ANTHROPIC_API_KEY: CLOUDRU_PROXY_SENTINEL_KEY,
};
```

## Consequences

### Positive

- First-class Cloud.ru FM wizard experience (not hidden in "Custom Provider")
- Auto-configures provider + backend + auth profile in one flow
- Default (GLM-4.7-Flash) is free — zero barrier to entry
- Follows handler chain pattern exactly (XAI reference)

### Negative

- 4 files modified + 1 new file per integration
- Maintenance burden if cloud.ru changes model IDs
- Proxy deployment adds complexity to wizard

### Domain Events

| Event                         | Trigger               | Handler                |
| ----------------------------- | --------------------- | ---------------------- |
| `CloudruFmProviderConfigured` | User completes wizard | Write to openclaw.json |
| `AuthProfileCreated`          | Provider configured   | Write auth.profiles    |
| `CliBackendConfigured`        | Provider configured   | Update cliBackends.env |

## References

- `src/commands/auth-choice.apply.xai.ts` — Reference handler pattern
- `src/commands/onboard-auth.ts` — applyAuthProfileConfig, applyDefaultModelChoice
- `src/commands/onboard-auth.config-core.ts` — applyZaiProviderConfig (correct config shape)
- `src/config/cloudru-fm.constants.ts` — CLOUDRU_FM_PRESETS, CLOUDRU_FM_MODELS
- `docs/ccli-max-cloudru-fm/RESEARCH.md` — Model comparison and recommendations
