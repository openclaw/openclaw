# Provider-Neutral Brain Profile Router Design

**Date:** 2026-05-20
**Status:** Draft for Jared review
**Scope:** OpenClaw framework first, Quinn-Co runtime adapters second, Mission Control lockstep

## Goal

Replace OpenClaw's vendor-specific Economy / Executive / Einstein model routing with a provider-neutral "interchangeable brains" architecture.

The business-facing tiers remain stable:

- `economy`: cheapest acceptable result
- `baller`: Executive Mode, strong business default; internal key remains `baller` for backward compatibility
- `einstein`: best available reasoning

The implementation behind each tier becomes configurable through brain profiles that can point to OpenAI Codex OAuth, OpenAI API keys, Anthropic API keys, local/private OpenAI-compatible endpoints, Ollama, vLLM, or future providers.

## Current Problem

OpenClaw currently treats tiers as three Anthropic model strings:

```ts
economy -> anthropic/claude-haiku-4-5-20251001
baller -> anthropic/claude-sonnet-4-6
einstein -> anthropic/claude-opus-4-6
```

That design blocks the real product goal:

- Jared's personal Quinn-Co runtime should be able to use OpenAI Codex OAuth subscription limits.
- Commercial deployments should use customer-owned API keys or local/private models.
- Future deployments should be able to use local open-source models as cheap backstops.
- The system must avoid silent fallback from subscription OAuth to metered API billing.

## Relevant Findings

The migration report is saved at:

`C:\AI\handoffs\codex-model-migration.md`

Important findings from that report and follow-up scan:

- Main tier router lives in `C:\AI\openclaw\src\agents\model-tiers.ts`.
- Gateway RPC write-through lives in `C:\AI\openclaw\src\gateway\server-methods\model-mode.ts`.
- Mission Control duplicates tier mapping in `C:\Users\jared\Projects\mission-control\app\api\agent-modes\route.ts`.
- Quinn-Co inherits the OpenClaw router through compiled/runtime OpenClaw, but has runtime bypasses and metadata:
  - `C:\AI\quinn-co\workspace\services\nl-workflow-builder\parser.ts`
  - `C:\AI\quinn-co\workspace\services\voice\voice-session.ts`
  - `C:\AI\quinn-co\workspace\scripts\enrich-intake.mjs`
  - `C:\AI\quinn-co\workspace\enforcement\modules\04-token-metering\anthropic-proxy.ts`
  - `C:\AI\quinn-co\workspace\agent-registry.json`
  - `C:\AI\quinn-co\workspace\agents\*\IDENTITY.md`
- OpenAI Codex OAuth support exists in the OpenClaw checkout.
- `gpt-5.5` is not yet registered in Codex live-model filters or synthetic model catalog.
- Current tier resolution has no direct tests.

## Design Principles

1. **Tiers are intent, not vendors.**
   `economy`, `baller`, and `einstein` describe business intent. They should not imply Anthropic, OpenAI, API, OAuth, or local execution.

2. **Brain profiles are implementation.**
   A profile defines provider, model, auth route, billing route, params, and fallback policy.

3. **Billing route must be explicit.**
   Subscription OAuth, metered API, and local/private execution are different operational modes. They must be visible in config, status, logs, and UI.

4. **No silent paid fallback.**
   If a subscription/OAuth profile fails, OpenClaw must not silently fall back to a metered API profile unless config explicitly allows it.

5. **Local models are first-class.**
   Local/private OpenAI-compatible endpoints should be represented as normal profiles, not special-case hacks.

6. **Mission Control cannot guess.**
   Mission Control should consume the same resolved tier/brain data as OpenClaw, or at minimum use a shared-compatible model-to-tier lookup that does not string-match `"sonnet"` or `"opus"`.

7. **Quinn-Co bypasses must be classified.**
   Each Quinn-Co Anthropic reference should be classified as runtime call, config/registry metadata, security allowlist, docs/persona text, or tests. Runtime calls move first.

## New Concepts

### Brain Profile

A brain profile is a named model backend configuration:

```ts
export type BrainAuthType = "oauth" | "apiKey" | "none";
export type BrainBillingType = "subscription" | "metered" | "local";

export type BrainProfile = {
  id: string;
  label: string;
  provider: string;
  model: string;
  auth: BrainAuthType;
  billing: BrainBillingType;
  modelRef: string;
  params?: Record<string, unknown>;
  fallbacks?: string[];
  allowMeteredFallback?: boolean;
  commercialSafe: boolean;
  notes?: string;
};
```

`modelRef` is the existing full provider/model string, such as:

- `openai-codex/gpt-5.5`
- `openai/gpt-5.4-mini`
- `anthropic/claude-sonnet-4-6`
- `local-openai-compatible/local-default`

### Tier Routing

Tier routing maps the three business modes to profile ids:

```ts
export type BrainTierRouting = Record<ModelTierMode, string>;
```

Example personal Quinn-Co routing:

```json
{
  "globalMode": "einstein",
  "agentOverrides": {},
  "tierRouting": {
    "economy": "local-economy",
    "baller": "openai-api-balanced",
    "einstein": "openai-codex-subscription-best"
  }
}
```

Example commercial routing:

```json
{
  "globalMode": "baller",
  "agentOverrides": {},
  "tierRouting": {
    "economy": "openai-api-cheap",
    "baller": "openai-api-balanced",
    "einstein": "openai-api-premium"
  }
}
```

## Default Profiles

OpenClaw should ship with provider-neutral defaults that can work across personal and commercial deployments.

```ts
export const DEFAULT_BRAIN_PROFILES: Record<string, BrainProfile> = {
  "openai-codex-subscription-best": {
    id: "openai-codex-subscription-best",
    label: "OpenAI Codex GPT-5.5",
    provider: "openai-codex",
    model: "gpt-5.5",
    auth: "oauth",
    billing: "subscription",
    modelRef: "openai-codex/gpt-5.5",
    params: { reasoning_effort: "high" },
    fallbacks: [],
    allowMeteredFallback: false,
    commercialSafe: false,
    notes: "Best personal operator mode when ChatGPT/Codex OAuth is available."
  },
  "openai-api-balanced": {
    id: "openai-api-balanced",
    label: "OpenAI Balanced API",
    provider: "openai",
    model: "gpt-5.4",
    auth: "apiKey",
    billing: "metered",
    modelRef: "openai/gpt-5.4",
    params: { reasoning_effort: "medium" },
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
    notes: "Commercial default candidate for Executive Mode."
  },
  "openai-api-cheap": {
    id: "openai-api-cheap",
    label: "OpenAI Cheap API",
    provider: "openai",
    model: "gpt-5.4-mini",
    auth: "apiKey",
    billing: "metered",
    modelRef: "openai/gpt-5.4-mini",
    params: { reasoning_effort: "low" },
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
    notes: "Commercial default candidate for Economy Mode."
  },
  "local-economy": {
    id: "local-economy",
    label: "Local Economy Model",
    provider: "local-openai-compatible",
    model: "local-default",
    auth: "none",
    billing: "local",
    modelRef: "local-openai-compatible/local-default",
    params: {},
    fallbacks: [],
    allowMeteredFallback: false,
    commercialSafe: true,
    notes: "Reserved profile shape for Ollama, vLLM, LM Studio, or a private OpenAI-compatible model server."
  }
};
```

Exact OpenAI model names should be verified against available model catalog behavior during implementation. If `gpt-5.5` is accepted by `openai-codex` dynamic provider but not listed, add it to the catalog/filter so UI and diagnostics work.

## Config Shape

The existing `model-tiers.json` remains supported:

```json
{
  "globalMode": "economy",
  "agentOverrides": {}
}
```

The new shape adds optional fields:

```json
{
  "globalMode": "einstein",
  "agentOverrides": {},
  "tierRouting": {
    "economy": "local-economy",
    "baller": "openai-api-balanced",
    "einstein": "openai-codex-subscription-best"
  },
  "brainProfiles": {
    "openai-codex-subscription-best": {
      "id": "openai-codex-subscription-best",
      "label": "OpenAI Codex GPT-5.5",
      "provider": "openai-codex",
      "model": "gpt-5.5",
      "auth": "oauth",
      "billing": "subscription",
      "modelRef": "openai-codex/gpt-5.5",
      "params": { "reasoning_effort": "high" },
      "fallbacks": [],
      "allowMeteredFallback": false,
      "commercialSafe": false
    }
  }
}
```

Backward compatibility:

- If `tierRouting` is missing, use legacy defaults.
- If `brainProfiles` is missing, use built-in profiles.
- If a legacy file references `globalMode: "baller"`, preserve it.
- If invalid profiles are present, ignore invalid profile entries and fall back to safe built-ins rather than crashing tier UI.

## Resolver Behavior

Add a resolver with this effective order:

1. Load tier config from the active state dir via `resolveStateDir()`.
2. Determine requested mode:
   - per-agent override if present
   - otherwise global mode
3. Resolve mode to a brain profile id via `tierRouting`.
4. Resolve profile id to `BrainProfile`.
5. Build existing OpenClaw model config:
   - primary model ref from `profile.modelRef`
   - optional fallbacks from profile fallback ids
   - params merged into `agents.defaults.models[modelRef].params`
6. Refuse forbidden fallback:
   - if primary billing is `subscription`
   - and fallback billing is `metered`
   - and `allowMeteredFallback !== true`
   - then exclude or reject that fallback with an explicit error

The resolver should return both the model ref and metadata:

```ts
{
  mode: "einstein",
  profileId: "openai-codex-subscription-best",
  modelRef: "openai-codex/gpt-5.5",
  provider: "openai-codex",
  auth: "oauth",
  billing: "subscription",
  commercialSafe: false,
  params: { reasoning_effort: "high" },
  fallbacks: []
}
```

## Gateway Changes

`model-mode.get` should return:

- current `globalMode`
- `agentOverrides`
- tier labels/colors/cost hints
- `tierRouting`
- public-safe brain profile metadata
- resolved current profile for each tier

`model-mode.set` should:

- update `model-tiers.json`
- resolve the tier through the brain router
- patch `agents.defaults.model`
- patch agents in `agents.list`
- ensure `agents.defaults.models[modelRef].params` exists for the resolved profile
- preserve per-agent overrides
- avoid restarting the gateway

`model-mode.agent-set` should follow the same resolver path for per-agent overrides.

## Mission Control Changes

Mission Control currently has a duplicate model map and guesses tier from strings like `"sonnet"` and `"opus"`. That will fail after the migration.

Minimum acceptable change:

- Replace duplicate hardcoded Anthropic map with a provider-neutral mapping compatible with `tierRouting`.
- Infer active mode from `model-tiers.json.globalMode`, not from agent model string.
- When displaying per-agent mode, use `agentOverrides[agentId]` if present; otherwise inherit `globalMode`.
- Display provider/model/auth/billing metadata if available.

Better later change:

- Mission Control should call the OpenClaw gateway `model-mode.get/set` instead of editing `model-tiers.json` and `openclaw.json` directly.

This spec recommends the minimum acceptable change for the first implementation and a later gateway-only dashboard cleanup.

## Quinn-Co Adapter Scope

Quinn-Co has both runtime model calls and descriptive metadata.

### Must Handle Before Quinn-Co Default Switch

These can still call Anthropic even after OpenClaw tier routing changes:

- `services\nl-workflow-builder\parser.ts`
- `services\voice\voice-session.ts`
- `scripts\enrich-intake.mjs`
- `skills\autoresearch\lib\anthropic-client.mjs` in OpenClaw

These should be moved to shared profile resolution or explicitly configured provider/model refs before Quinn-Co is switched to Einstein.

### Metering and Security

`enforcement\modules\04-token-metering\anthropic-proxy.ts` should not be deleted in the first pass. It should be marked or wrapped as Anthropic-specific while a provider-neutral metering interface is introduced.

Security allowlists must account for the selected brain profile:

- Anthropic API: `api.anthropic.com`
- OpenAI API: `api.openai.com`
- OpenAI Codex OAuth backend: `chatgpt.com`
- Local/private: configured host, often `127.0.0.1`

No local profile should become active until a local model server exists and passes a smoke test.

### Metadata Last

These should be updated after runtime routing works:

- `agent-registry.json`
- `agents\*\IDENTITY.md`
- `IDENTITY.md`
- historical memory docs

Do not hand-edit all persona files before the resolver exists. Use a scripted/template update later.

## Error Handling

The system should surface clear errors for:

- selected OAuth profile but no OAuth credentials
- selected API profile but no API key
- selected local profile but base URL does not respond
- fallback blocked because it would cross from subscription billing to metered billing
- unknown profile id in tier routing
- unknown mode

Errors should include:

- tier mode
- profile id
- provider
- auth type
- billing type
- next action

Example:

```text
Einstein Mode selected openai-codex-subscription-best, but no OpenAI Codex OAuth profile is available. Run `openclaw models auth login --provider openai-codex` or choose another brain profile.
```

## Testing Requirements

Add focused tests before implementation changes:

1. `model-tiers` loads legacy config and produces legacy-compatible defaults.
2. `model-tiers` loads new `tierRouting` and `brainProfiles`.
3. `getProviderModelForTier("einstein")` resolves to configured profile model ref.
4. Subscription-to-metered fallback is blocked unless explicitly allowed.
5. Local profile requires no auth and preserves configured base URL/profile metadata.
6. `model-mode.set` writes valid config with `openai-codex/gpt-5.5`.
7. `model-mode.agent-set` respects per-agent overrides.
8. Mission Control route does not classify OpenAI/Local models as Economy by string fallback.
9. `gpt-5.5` appears in Codex model filter/catalog diagnostics.

## Rollout Plan

### Phase 1: Framework Router

Modify only `C:\AI\openclaw`:

- Add brain profile types/defaults/resolver.
- Extend `model-tiers.ts`.
- Add tier resolution tests.
- Add `gpt-5.5` Codex model catalog/filter support.
- Update `model-mode.ts` to use resolver.

### Phase 2: Mission Control Lockstep

Modify `C:\Users\jared\Projects\mission-control`:

- Remove Anthropic-specific duplicate assumptions from `/api/agent-modes`.
- Read `globalMode`, `agentOverrides`, and provider-neutral routing metadata.
- Avoid touching unrelated dirty files.

### Phase 3: Quinn-Co Runtime Bypasses

Modify Quinn-Co runtime only after its dirty worktree is cleaned or isolated:

- Replace direct Anthropic calls in workflow parser, voice session, and enrich-intake.
- Keep security allowlist aligned with active provider profiles.
- Add provider-neutral metering seam while preserving Anthropic proxy behavior.

### Phase 4: Quinn-Co Config Switch

After tests and bypass migration:

- Add `openai-codex` provider/profile data to Quinn-Co state config.
- Set `~\.openclaw-quinn-co\model-tiers.json.globalMode` to `einstein`.
- Verify a controlled OpenClaw task uses OpenAI Codex OAuth.
- Verify OpenAI API billing does not move for that OAuth-controlled task.

### Phase 5: Metadata Cleanup

Update:

- `agent-registry.json`
- persona `IDENTITY.md` model lines
- docs that describe Quinn-Co as Anthropic-only

Prefer a scripted update with review, not manual editing.

## Non-Goals

- Do not remove Anthropic support.
- Do not make local models active by default.
- Do not convert all Quinn-Co persona docs in the first implementation.
- Do not make commercial deployments depend on Jared's ChatGPT/Codex OAuth.
- Do not silently fall back from OAuth subscription to API billing.

## First Implementation Decisions

1. Default fallback lists should start empty. This avoids surprise API billing and forces fallbacks to be explicit.
2. `serviceTier` should be profile-level only in the first implementation. A runtime Fast/Priority toggle can come later after usage behavior is measured.
3. Mission Control should keep direct file writes for the first migration but stop guessing tiers from model-name strings. A gateway-write cleanup can follow after the router is stable.
4. Quinn-Co runtime bypass order should be: `enrich-intake.mjs` first because it affects scheduled/daily work, `parser.ts` second because it is a small direct call, and `voice-session.ts` third because voice flows have more live interaction risk.

## Recommendation

Implement the framework router first with empty fallbacks by default. Keep fallbacks explicit and visible.

For Jared's personal Quinn-Co runtime, use:

- `einstein -> openai-codex-subscription-best`
- `baller -> openai-api-balanced`
- `economy -> local-economy` only after a local server is installed and tested; until then use `openai-api-cheap` or legacy Anthropic.

For commercial deployments, default to API-key or local/private profiles, not Jared's OAuth subscription.
