# Provider-Neutral Brain Profile Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenClaw's Anthropic-only tier router with provider-neutral brain profiles while preserving legacy `model-tiers.json` files and avoiding silent subscription-to-metered fallback.

**Architecture:** Add a focused brain-profile resolver under `src/agents/`, extend `model-tiers.ts` to normalize optional `tierRouting` and `brainProfiles`, then update the gateway model-mode writer to patch `openclaw.json` from resolved profile metadata. Keep Quinn-Co runtime bypasses and Mission Control changes out of this OpenClaw worktree; they need separate isolated plans because they are separate workspaces and Quinn-Co is dirty.

**Tech Stack:** TypeScript, Vitest, OpenClaw gateway config merge/validation, existing `model-tiers.json` state file, existing `agents.defaults.model` and `agents.defaults.models` config shape.

---

## Scope Check

This plan implements Phase 1 from the spec in the isolated OpenClaw worktree:

- Brain profile types/defaults/resolver.
- Backward-compatible `model-tiers.json` loading/saving.
- Gateway `model-mode.get`, `model-mode.set`, and `model-mode.agent-set` behavior.
- `openai-codex/gpt-5.5` catalog/filter/forward-compat diagnostics.

This plan does not edit:

- `C:\Users\jared\Projects\mission-control\app\api\agent-modes\route.ts`
- `C:\AI\quinn-co\workspace\...`
- `C:\Users\jared\.openclaw\openclaw.json`
- `C:\Users\jared\.openclaw-quinn-co\openclaw.json`

Separate plans after this:

- Phase 2: Mission Control lockstep route update in a Mission Control worktree.
- Phase 3: Quinn-Co runtime bypass migration after dirty worktree is cleaned or isolated.
- Phase 4: Quinn-Co config switch to `einstein`.
- Phase 5: Quinn-Co metadata/persona cleanup.

## File Structure

- Create `src/agents/brain-profiles.ts`
  - Owns profile types, built-in profiles, legacy profile/routing defaults, validation, fallback guard, and resolved tier metadata.
- Create `src/agents/brain-profiles.test.ts`
  - Unit coverage for legacy defaults, configured routing/profiles, fallback blocking, local profile metadata, and invalid-entry cleanup.
- Modify `src/agents/model-tiers.ts`
  - Extends `ModelTierConfig`, preserves old tier keys, uses brain-profile resolver, and keeps legacy Anthropic fallback when `tierRouting` is missing.
- Create `src/agents/model-tiers.test.ts`
  - File I/O coverage using temporary `OPENCLAW_STATE_DIR`.
- Create `src/agents/brain-config-patch.ts`
  - Pure config patch helpers for global and per-agent tier writes, including `agents.defaults.models[modelRef].params`.
- Create `src/agents/brain-config-patch.test.ts`
  - Pure tests for global patch, per-agent patch, object model preservation, fallback preservation, and params insertion.
- Modify `src/gateway/server-methods/model-mode.ts`
  - Replace direct `MODEL_TIER_MAP` writes with resolved brain profiles and pure patch helpers.
- Create `src/gateway/server-methods/model-mode.brain-profiles.test.ts`
  - Handler-level coverage for `get`, `set`, and `agent-set` response payloads and write-through.
- Modify `src/agents/live-model-filter.ts`
  - Adds `gpt-5.5` as a modern `openai-codex` model.
- Modify `src/agents/model-catalog.ts`
  - Adds synthetic catalog fallback for `openai-codex/gpt-5.5`.
- Modify `src/agents/model-forward-compat.ts`
  - Adds forward-compatible runtime model resolution for `openai-codex/gpt-5.5`.
- Modify `src/agents/model-catalog.test.ts`
  - Verifies synthetic `gpt-5.5`.
- Modify `src/agents/model-compat.test.ts`
  - Verifies `isModernModelRef` and forward-compat resolution for `openai-codex/gpt-5.5`.
- Modify `src/extensionAPI.ts`
  - Re-exports new brain profile types/helpers needed by downstream consumers.

## Task 1: Brain Profile Resolver

**Files:**
- Create: `src/agents/brain-profiles.ts`
- Test: `src/agents/brain-profiles.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Add `src/agents/brain-profiles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BRAIN_PROFILES,
  LEGACY_TIER_ROUTING,
  normalizeBrainTierConfigParts,
  resolveBrainProfileForMode,
  resolveBrainProfileForAgent,
} from "./brain-profiles.js";

describe("brain profile resolver", () => {
  it("uses legacy-compatible tier routing when no routing is configured", () => {
    const normalized = normalizeBrainTierConfigParts({});

    expect(normalized.tierRouting).toEqual(LEGACY_TIER_ROUTING);
    expect(resolveBrainProfileForMode(normalized, "economy")).toMatchObject({
      profileId: "legacy-anthropic-haiku",
      modelRef: "anthropic/claude-haiku-4-5-20251001",
      billing: "metered",
      commercialSafe: true,
    });
  });

  it("resolves configured routing and configured profile metadata", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: {
        economy: "openai-api-cheap",
        baller: "openai-api-balanced",
        einstein: "openai-codex-subscription-best",
      },
      brainProfiles: DEFAULT_BRAIN_PROFILES,
    });

    expect(resolveBrainProfileForMode(normalized, "einstein")).toMatchObject({
      mode: "einstein",
      profileId: "openai-codex-subscription-best",
      modelRef: "openai-codex/gpt-5.5",
      provider: "openai-codex",
      auth: "oauth",
      billing: "subscription",
      commercialSafe: false,
      params: { reasoning_effort: "high" },
      fallbacks: [],
    });
  });

  it("blocks subscription to metered fallback unless explicitly allowed", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "codex-with-metered-fallback" },
      brainProfiles: {
        "codex-with-metered-fallback": {
          id: "codex-with-metered-fallback",
          label: "Codex with API fallback",
          provider: "openai-codex",
          model: "gpt-5.5",
          auth: "oauth",
          billing: "subscription",
          modelRef: "openai-codex/gpt-5.5",
          fallbacks: ["openai-api-balanced"],
          allowMeteredFallback: false,
          commercialSafe: false,
        },
      },
    });

    const resolved = resolveBrainProfileForMode(normalized, "einstein");
    expect(resolved.fallbacks).toEqual([]);
    expect(resolved.blockedFallbacks).toEqual([
      {
        profileId: "openai-api-balanced",
        modelRef: "openai/gpt-5.4",
        reason: "subscription_to_metered_blocked",
      },
    ]);
  });

  it("allows subscription to metered fallback only when profile opts in", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "codex-with-allowed-fallback" },
      brainProfiles: {
        "codex-with-allowed-fallback": {
          id: "codex-with-allowed-fallback",
          label: "Codex with API fallback",
          provider: "openai-codex",
          model: "gpt-5.5",
          auth: "oauth",
          billing: "subscription",
          modelRef: "openai-codex/gpt-5.5",
          fallbacks: ["openai-api-balanced"],
          allowMeteredFallback: true,
          commercialSafe: false,
        },
      },
    });

    expect(resolveBrainProfileForMode(normalized, "einstein").fallbacks).toEqual([
      "openai/gpt-5.4",
    ]);
  });

  it("keeps local profile metadata without requiring auth", () => {
    const normalized = normalizeBrainTierConfigParts({
      tierRouting: { economy: "local-economy" },
    });

    expect(resolveBrainProfileForMode(normalized, "economy")).toMatchObject({
      profileId: "local-economy",
      provider: "local-openai-compatible",
      auth: "none",
      billing: "local",
      modelRef: "local-openai-compatible/local-default",
      commercialSafe: true,
    });
  });

  it("uses agent override before global mode", () => {
    const normalized = normalizeBrainTierConfigParts({
      globalMode: "economy",
      agentOverrides: { quinn: "einstein" },
      tierRouting: {
        economy: "openai-api-cheap",
        einstein: "openai-codex-subscription-best",
      },
    });

    expect(resolveBrainProfileForAgent(normalized, "quinn")).toMatchObject({
      mode: "einstein",
      modelRef: "openai-codex/gpt-5.5",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/brain-profiles.test.ts
```

Expected: FAIL because `src/agents/brain-profiles.ts` does not exist.

- [ ] **Step 3: Implement resolver**

Create `src/agents/brain-profiles.ts`:

```ts
import type { ModelTierMode } from "./model-tiers.js";

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

export type BrainTierRouting = Partial<Record<ModelTierMode, string>>;

export type BrainTierConfigParts = {
  globalMode?: ModelTierMode;
  agentOverrides?: Record<string, ModelTierMode>;
  tierRouting?: Record<string, unknown>;
  brainProfiles?: Record<string, unknown>;
};

export type NormalizedBrainTierConfig = {
  globalMode: ModelTierMode;
  agentOverrides: Record<string, ModelTierMode>;
  tierRouting: Required<Record<ModelTierMode, string>>;
  brainProfiles: Record<string, BrainProfile>;
};

export type BlockedBrainFallback = {
  profileId: string;
  modelRef: string;
  reason: "subscription_to_metered_blocked" | "unknown_profile";
};

export type ResolvedBrainProfile = {
  mode: ModelTierMode;
  profileId: string;
  modelRef: string;
  provider: string;
  model: string;
  auth: BrainAuthType;
  billing: BrainBillingType;
  commercialSafe: boolean;
  params: Record<string, unknown>;
  fallbacks: string[];
  blockedFallbacks: BlockedBrainFallback[];
  label: string;
};

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
    notes: "Best personal operator mode when ChatGPT/Codex OAuth is available.",
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
    notes: "Commercial default candidate for Executive Mode.",
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
    notes: "Commercial default candidate for Economy Mode.",
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
    notes: "Reserved profile shape for Ollama, vLLM, LM Studio, or private OpenAI-compatible servers.",
  },
};

export const LEGACY_BRAIN_PROFILES: Record<string, BrainProfile> = {
  "legacy-anthropic-haiku": {
    id: "legacy-anthropic-haiku",
    label: "Legacy Anthropic Haiku",
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    auth: "apiKey",
    billing: "metered",
    modelRef: "anthropic/claude-haiku-4-5-20251001",
    params: {},
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
  },
  "legacy-anthropic-sonnet": {
    id: "legacy-anthropic-sonnet",
    label: "Legacy Anthropic Sonnet",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    auth: "apiKey",
    billing: "metered",
    modelRef: "anthropic/claude-sonnet-4-6",
    params: {},
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
  },
  "legacy-anthropic-opus": {
    id: "legacy-anthropic-opus",
    label: "Legacy Anthropic Opus",
    provider: "anthropic",
    model: "claude-opus-4-6",
    auth: "apiKey",
    billing: "metered",
    modelRef: "anthropic/claude-opus-4-6",
    params: {},
    fallbacks: [],
    allowMeteredFallback: true,
    commercialSafe: true,
  },
};

export const LEGACY_TIER_ROUTING: Required<Record<ModelTierMode, string>> = {
  economy: "legacy-anthropic-haiku",
  baller: "legacy-anthropic-sonnet",
  einstein: "legacy-anthropic-opus",
};

const MODE_ORDER: readonly ModelTierMode[] = ["economy", "baller", "einstein"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAuthType(value: unknown): value is BrainAuthType {
  return value === "oauth" || value === "apiKey" || value === "none";
}

function isBillingType(value: unknown): value is BrainBillingType {
  return value === "subscription" || value === "metered" || value === "local";
}

function normalizeProfile(id: string, raw: unknown): BrainProfile | undefined {
  if (!isRecord(raw)) return undefined;
  const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : id;
  const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const modelRef =
    typeof raw.modelRef === "string" && raw.modelRef.trim()
      ? raw.modelRef.trim()
      : provider && model
        ? `${provider}/${model}`
        : "";
  if (!id || !provider || !model || !modelRef) return undefined;
  if (!isAuthType(raw.auth) || !isBillingType(raw.billing)) return undefined;

  return {
    id,
    label,
    provider,
    model,
    auth: raw.auth,
    billing: raw.billing,
    modelRef,
    params: isRecord(raw.params) ? { ...raw.params } : {},
    fallbacks: Array.isArray(raw.fallbacks)
      ? raw.fallbacks.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : [],
    allowMeteredFallback: raw.allowMeteredFallback === true,
    commercialSafe: raw.commercialSafe === true,
    notes: typeof raw.notes === "string" ? raw.notes : undefined,
  };
}

export function normalizeBrainTierConfigParts(
  config: BrainTierConfigParts,
): NormalizedBrainTierConfig {
  const suppliedProfiles = isRecord(config.brainProfiles) ? config.brainProfiles : {};
  const brainProfiles: Record<string, BrainProfile> = {
    ...LEGACY_BRAIN_PROFILES,
    ...DEFAULT_BRAIN_PROFILES,
  };

  for (const [id, rawProfile] of Object.entries(suppliedProfiles)) {
    const normalized = normalizeProfile(id, rawProfile);
    if (normalized) {
      brainProfiles[id] = normalized;
    }
  }

  const configuredRouting = isRecord(config.tierRouting) ? config.tierRouting : {};
  const tierRouting = { ...LEGACY_TIER_ROUTING };
  for (const mode of MODE_ORDER) {
    const profileId = configuredRouting[mode];
    if (typeof profileId === "string" && brainProfiles[profileId]) {
      tierRouting[mode] = profileId;
    }
  }

  return {
    globalMode: config.globalMode ?? "economy",
    agentOverrides: { ...(config.agentOverrides ?? {}) },
    tierRouting,
    brainProfiles,
  };
}

export function resolveBrainProfileForMode(
  config: NormalizedBrainTierConfig,
  mode: ModelTierMode,
): ResolvedBrainProfile {
  const profileId = config.tierRouting[mode] ?? LEGACY_TIER_ROUTING[mode];
  const profile =
    config.brainProfiles[profileId] ??
    config.brainProfiles[LEGACY_TIER_ROUTING[mode]] ??
    LEGACY_BRAIN_PROFILES[LEGACY_TIER_ROUTING[mode]];
  const fallbacks: string[] = [];
  const blockedFallbacks: BlockedBrainFallback[] = [];

  for (const fallbackId of profile.fallbacks ?? []) {
    const fallback = config.brainProfiles[fallbackId];
    if (!fallback) {
      blockedFallbacks.push({ profileId: fallbackId, modelRef: "", reason: "unknown_profile" });
      continue;
    }
    if (
      profile.billing === "subscription" &&
      fallback.billing === "metered" &&
      profile.allowMeteredFallback !== true
    ) {
      blockedFallbacks.push({
        profileId: fallbackId,
        modelRef: fallback.modelRef,
        reason: "subscription_to_metered_blocked",
      });
      continue;
    }
    fallbacks.push(fallback.modelRef);
  }

  return {
    mode,
    profileId: profile.id,
    modelRef: profile.modelRef,
    provider: profile.provider,
    model: profile.model,
    auth: profile.auth,
    billing: profile.billing,
    commercialSafe: profile.commercialSafe,
    params: { ...(profile.params ?? {}) },
    fallbacks,
    blockedFallbacks,
    label: profile.label,
  };
}

export function resolveBrainProfileForAgent(
  config: NormalizedBrainTierConfig,
  agentId: string,
): ResolvedBrainProfile {
  const mode = config.agentOverrides[agentId] ?? config.globalMode;
  return resolveBrainProfileForMode(config, mode);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/brain-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/brain-profiles.ts src/agents/brain-profiles.test.ts
git commit -m "feat: add brain profile resolver" -m "[codex] Add provider-neutral brain profile resolver with fallback billing guards."
```

## Task 2: Model Tier Config Backward Compatibility

**Files:**
- Modify: `src/agents/model-tiers.ts`
- Test: `src/agents/model-tiers.test.ts`

- [ ] **Step 1: Write failing model-tier config tests**

Add `src/agents/model-tiers.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getProviderModelForTier,
  loadModelTierConfig,
  saveModelTierConfig,
} from "./model-tiers.js";

let tempStateDir = "";
let previousStateDir: string | undefined;

beforeEach(() => {
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-tiers-"));
  process.env.OPENCLAW_STATE_DIR = tempStateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  fs.rmSync(tempStateDir, { recursive: true, force: true });
});

function writeTierFile(value: unknown): void {
  fs.writeFileSync(path.join(tempStateDir, "model-tiers.json"), JSON.stringify(value, null, 2));
}

describe("model tier config", () => {
  it("loads missing config as legacy-compatible economy mode", () => {
    const config = loadModelTierConfig();

    expect(config.globalMode).toBe("economy");
    expect(config.agentOverrides).toEqual({});
    expect(config.tierRouting.economy).toBe("legacy-anthropic-haiku");
    expect(getProviderModelForTier("economy", config)).toBe(
      "anthropic/claude-haiku-4-5-20251001",
    );
  });

  it("loads new tierRouting and brainProfiles", () => {
    writeTierFile({
      globalMode: "einstein",
      agentOverrides: { quinn: "baller" },
      tierRouting: {
        economy: "openai-api-cheap",
        baller: "openai-api-balanced",
        einstein: "openai-codex-subscription-best",
      },
      brainProfiles: {},
    });

    const config = loadModelTierConfig();

    expect(config.globalMode).toBe("einstein");
    expect(config.agentOverrides).toEqual({ quinn: "baller" });
    expect(getProviderModelForTier("einstein", config)).toBe("openai-codex/gpt-5.5");
    expect(getProviderModelForTier("baller", config)).toBe("openai/gpt-5.4");
  });

  it("drops invalid modes, invalid overrides, and invalid profile references", () => {
    writeTierFile({
      globalMode: "not-real",
      agentOverrides: { quinn: "einstein", bad: "opus" },
      tierRouting: { einstein: "missing-profile" },
    });

    const config = loadModelTierConfig();

    expect(config.globalMode).toBe("economy");
    expect(config.agentOverrides).toEqual({ quinn: "einstein" });
    expect(config.tierRouting.einstein).toBe("legacy-anthropic-opus");
  });

  it("saves normalized config with provider-neutral fields", () => {
    const config = loadModelTierConfig();
    config.globalMode = "einstein";
    config.tierRouting.einstein = "openai-codex-subscription-best";
    saveModelTierConfig(config);

    const raw = JSON.parse(fs.readFileSync(path.join(tempStateDir, "model-tiers.json"), "utf-8"));
    expect(raw.globalMode).toBe("einstein");
    expect(raw.tierRouting.einstein).toBe("openai-codex-subscription-best");
    expect(raw.brainProfiles["openai-codex-subscription-best"].modelRef).toBe(
      "openai-codex/gpt-5.5",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/model-tiers.test.ts
```

Expected: FAIL because `ModelTierConfig` has no `tierRouting`/`brainProfiles` fields and `getProviderModelForTier` does not accept config.

- [ ] **Step 3: Extend `model-tiers.ts`**

Modify `src/agents/model-tiers.ts`:

```ts
import {
  normalizeBrainTierConfigParts,
  resolveBrainProfileForMode,
  type BrainProfile,
  type BrainTierRouting,
} from "./brain-profiles.js";
```

Change `ModelTierConfig`:

```ts
export type ModelTierConfig = {
  globalMode: ModelTierMode;
  agentOverrides: Record<string, ModelTierMode>;
  tierRouting: Required<Record<ModelTierMode, string>>;
  brainProfiles: Record<string, BrainProfile>;
};
```

Keep `MODEL_TIER_MAP` and `MODEL_TO_TIER` exported for legacy callers, but mark them as legacy in comments:

```ts
/** Legacy fallback map used when model-tiers.json has no tierRouting. */
export const MODEL_TIER_MAP: Record<ModelTierMode, string> = {
  economy: "claude-haiku-4-5-20251001",
  baller: "claude-sonnet-4-6",
  einstein: "claude-opus-4-6",
};
```

Replace the final return in `loadModelTierConfig()`:

```ts
return normalizeBrainTierConfigParts({
  globalMode,
  agentOverrides,
  tierRouting:
    raw.tierRouting && typeof raw.tierRouting === "object"
      ? (raw.tierRouting as Record<string, unknown>)
      : undefined,
  brainProfiles:
    raw.brainProfiles && typeof raw.brainProfiles === "object"
      ? (raw.brainProfiles as Record<string, unknown>)
      : undefined,
});
```

Replace the catch return:

```ts
return normalizeBrainTierConfigParts({});
```

Change `getProviderModelForTier`:

```ts
export function getProviderModelForTier(
  mode: ModelTierMode,
  config = loadModelTierConfig(),
): string {
  return resolveBrainProfileForMode(config, mode).modelRef;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/brain-profiles.test.ts src/agents/model-tiers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/model-tiers.ts src/agents/model-tiers.test.ts
git commit -m "feat: extend model tiers with brain profile routing" -m "[codex] Keep legacy tier files working while adding provider-neutral tierRouting and brainProfiles."
```

## Task 3: Pure Config Patch Helpers

**Files:**
- Create: `src/agents/brain-config-patch.ts`
- Test: `src/agents/brain-config-patch.test.ts`

- [ ] **Step 1: Write failing patch-helper tests**

Add `src/agents/brain-config-patch.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeBrainTierConfigParts } from "./brain-profiles.js";
import {
  applyAgentBrainTierPatch,
  applyGlobalBrainTierPatch,
} from "./brain-config-patch.js";

describe("brain config patch helpers", () => {
  it("patches global default model, agent strings, and profile params", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "openai-codex-subscription-best" },
    });
    const next = applyGlobalBrainTierPatch(
      {
        agents: {
          defaults: { model: "anthropic/claude-haiku-4-5-20251001", models: {} },
          list: [{ id: "quinn", model: "anthropic/claude-haiku-4-5-20251001" }],
        },
      },
      "einstein",
      tierConfig,
    );

    expect(next.agents.defaults.model).toBe("openai-codex/gpt-5.5");
    expect(next.agents.defaults.models["openai-codex/gpt-5.5"]).toMatchObject({
      params: { reasoning_effort: "high" },
    });
    expect(next.agents.list[0].model).toBe("openai-codex/gpt-5.5");
  });

  it("preserves object model shape and fallbacks when patching primary", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { baller: "openai-api-balanced" },
    });
    const next = applyGlobalBrainTierPatch(
      {
        agents: {
          defaults: {},
          list: [
            {
              id: "quinn",
              model: { primary: "anthropic/claude-haiku-4-5-20251001", fallbacks: ["x/y"] },
            },
          ],
        },
      },
      "baller",
      tierConfig,
    );

    expect(next.agents.list[0].model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["x/y"],
    });
  });

  it("writes profile fallbacks for string-form agent models", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "codex-with-local-fallback" },
      brainProfiles: {
        "codex-with-local-fallback": {
          id: "codex-with-local-fallback",
          label: "Codex with local fallback",
          provider: "openai-codex",
          model: "gpt-5.5",
          auth: "oauth",
          billing: "subscription",
          modelRef: "openai-codex/gpt-5.5",
          fallbacks: ["local-economy"],
          allowMeteredFallback: false,
          commercialSafe: false,
        },
      },
    });

    const next = applyGlobalBrainTierPatch(
      { agents: { defaults: {}, list: [{ id: "quinn", model: "anthropic/claude-haiku-4-5-20251001" }] } },
      "einstein",
      tierConfig,
    );

    expect(next.agents.defaults.model).toEqual({
      primary: "openai-codex/gpt-5.5",
      fallbacks: ["local-openai-compatible/local-default"],
    });
    expect(next.agents.list[0].model).toEqual({
      primary: "openai-codex/gpt-5.5",
      fallbacks: ["local-openai-compatible/local-default"],
    });
  });

  it("uses agent override when globally patching agent list", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      agentOverrides: { quinn: "einstein" },
      tierRouting: {
        baller: "openai-api-balanced",
        einstein: "openai-codex-subscription-best",
      },
    });
    const next = applyGlobalBrainTierPatch(
      { agents: { defaults: {}, list: [{ id: "quinn" }, { id: "main" }] } },
      "baller",
      tierConfig,
    );

    expect(next.agents.list[0].model).toBe("openai-codex/gpt-5.5");
    expect(next.agents.list[1].model).toBe("openai/gpt-5.4");
  });

  it("patches one agent override and inserts missing agent entries", () => {
    const tierConfig = normalizeBrainTierConfigParts({
      tierRouting: { einstein: "openai-codex-subscription-best" },
    });

    const next = applyAgentBrainTierPatch(
      { agents: { defaults: {}, list: [] } },
      "new-agent",
      "einstein",
      tierConfig,
    );

    expect(next.agents.list).toEqual([{ id: "new-agent", model: "openai-codex/gpt-5.5" }]);
  });

  it("clears explicit model when an agent returns to inherit", () => {
    const tierConfig = normalizeBrainTierConfigParts({});

    const next = applyAgentBrainTierPatch(
      { agents: { defaults: {}, list: [{ id: "quinn", model: "openai-codex/gpt-5.5" }] } },
      "quinn",
      "inherit",
      tierConfig,
    );

    expect(next.agents.list[0]).toEqual({ id: "quinn" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/brain-config-patch.test.ts
```

Expected: FAIL because `src/agents/brain-config-patch.ts` does not exist.

- [ ] **Step 3: Implement patch helpers**

Create `src/agents/brain-config-patch.ts`:

```ts
import type { ModelTierMode } from "./model-tiers.js";
import {
  resolveBrainProfileForMode,
  type NormalizedBrainTierConfig,
  type ResolvedBrainProfile,
} from "./brain-profiles.js";

type ConfigObject = Record<string, any>;

function cloneConfig(config: Record<string, unknown>): ConfigObject {
  return JSON.parse(JSON.stringify(config ?? {}));
}

function ensureAgentDefaults(config: ConfigObject): ConfigObject {
  config.agents = config.agents && typeof config.agents === "object" ? config.agents : {};
  config.agents.defaults =
    config.agents.defaults && typeof config.agents.defaults === "object"
      ? config.agents.defaults
      : {};
  config.agents.defaults.models =
    config.agents.defaults.models && typeof config.agents.defaults.models === "object"
      ? config.agents.defaults.models
      : {};
  config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];
  return config;
}

function modelValueForResolved(current: unknown, resolved: ResolvedBrainProfile): unknown {
  const modelObject =
    resolved.fallbacks.length > 0
      ? { primary: resolved.modelRef, fallbacks: resolved.fallbacks }
      : { primary: resolved.modelRef };
  if (current && typeof current === "object" && !Array.isArray(current)) {
    return { ...(current as Record<string, unknown>), ...modelObject };
  }
  return resolved.fallbacks.length > 0 ? modelObject : resolved.modelRef;
}

function ensureModelParams(config: ConfigObject, resolved: ResolvedBrainProfile): void {
  const models = config.agents.defaults.models as Record<string, Record<string, unknown>>;
  const existing = models[resolved.modelRef] ?? {};
  models[resolved.modelRef] = {
    ...existing,
    params: {
      ...((existing.params as Record<string, unknown> | undefined) ?? {}),
      ...resolved.params,
    },
  };
}

export function applyGlobalBrainTierPatch(
  config: Record<string, unknown>,
  mode: ModelTierMode,
  tierConfig: NormalizedBrainTierConfig,
): ConfigObject {
  const next = ensureAgentDefaults(cloneConfig(config));
  const globalResolved = resolveBrainProfileForMode(tierConfig, mode);
  next.agents.defaults.model =
    modelValueForResolved(undefined, globalResolved);
  ensureModelParams(next, globalResolved);

  next.agents.list = next.agents.list.map((entry: Record<string, unknown>) => {
    const agentId = typeof entry.id === "string" ? entry.id : "";
    if (!agentId) return entry;
    const effectiveMode = tierConfig.agentOverrides[agentId] ?? mode;
    const resolved = resolveBrainProfileForMode(tierConfig, effectiveMode);
    ensureModelParams(next, resolved);
    return { ...entry, model: modelValueForResolved(entry.model, resolved) };
  });

  return next;
}

export function applyAgentBrainTierPatch(
  config: Record<string, unknown>,
  agentId: string,
  mode: ModelTierMode | "inherit",
  tierConfig: NormalizedBrainTierConfig,
): ConfigObject {
  const next = ensureAgentDefaults(cloneConfig(config));
  const list = next.agents.list as Array<Record<string, unknown>>;
  const agentIndex = list.findIndex(
    (entry) => typeof entry.id === "string" && entry.id.toLowerCase() === agentId.toLowerCase(),
  );

  if (mode === "inherit") {
    if (agentIndex >= 0) {
      delete list[agentIndex].model;
    }
    return next;
  }

  const resolved = resolveBrainProfileForMode(tierConfig, mode);
  ensureModelParams(next, resolved);

  if (agentIndex >= 0) {
    list[agentIndex] = {
      ...list[agentIndex],
      model: modelValueForResolved(list[agentIndex].model, resolved),
    };
  } else {
    list.push({ id: agentId, model: modelValueForResolved(undefined, resolved) });
  }

  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/brain-config-patch.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/brain-config-patch.ts src/agents/brain-config-patch.test.ts
git commit -m "feat: patch agent configs from brain profiles" -m "[codex] Add pure config patch helpers for provider-neutral tier writes."
```

## Task 4: Gateway Model Mode Integration

**Files:**
- Modify: `src/gateway/server-methods/model-mode.ts`
- Test: `src/gateway/server-methods/model-mode.brain-profiles.test.ts`

- [ ] **Step 1: Write failing gateway handler tests**

Add `src/gateway/server-methods/model-mode.brain-profiles.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { modelModeHandlers } from "./model-mode.js";

const readConfigFileSnapshotForWrite = vi.fn();
const writeConfigFile = vi.fn();

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshotForWrite,
  writeConfigFile,
}));

vi.mock("../../config/validation.js", () => ({
  validateConfigObjectWithPlugins: (config: unknown) => ({ ok: true, config }),
}));

vi.mock("../control-plane-audit.js", () => ({
  resolveControlPlaneActor: () => ({ actor: "test" }),
  formatControlPlaneActor: () => "actor=test",
}));

function captureRespond() {
  const calls: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

function context() {
  return { logGateway: { info: vi.fn() } };
}

describe("model-mode brain profiles", () => {
  let tempStateDir = "";
  let previousStateDir: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    tempStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-model-mode-"));
    process.env.OPENCLAW_STATE_DIR = tempStateDir;
    readConfigFileSnapshotForWrite.mockResolvedValue({
      snapshot: {
        valid: true,
        config: {
          agents: {
            defaults: { model: "anthropic/claude-haiku-4-5-20251001", models: {} },
            list: [{ id: "quinn", model: "anthropic/claude-haiku-4-5-20251001" }],
          },
        },
      },
      writeOptions: {},
    });
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    fs.rmSync(tempStateDir, { recursive: true, force: true });
  });

  it("returns public-safe brain metadata from get", () => {
    const { calls, respond } = captureRespond();

    modelModeHandlers["model-mode.get"]({ respond } as any);

    expect(calls[0].ok).toBe(true);
    expect(calls[0].payload).toMatchObject({
      globalMode: "economy",
      tierRouting: expect.any(Object),
      brainProfiles: expect.any(Object),
      tiers: {
        economy: expect.objectContaining({
          label: "Economy Mode",
          modelRef: "anthropic/claude-haiku-4-5-20251001",
          provider: "anthropic",
          billing: "metered",
        }),
      },
    });
  });

  it("set writes resolved configured brain profile model refs", async () => {
    const { calls, respond } = captureRespond();

    await modelModeHandlers["model-mode.set"]({
      params: { mode: "einstein" },
      respond,
      client: {},
      context: context(),
    } as any);

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          defaults: expect.objectContaining({
            model: "anthropic/claude-opus-4-6",
          }),
        }),
      }),
      {},
    );
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: expect.objectContaining({
        ok: true,
        globalMode: "einstein",
        modelRef: "anthropic/claude-opus-4-6",
        billing: "metered",
      }),
    });
  });

  it("agent-set writes per-agent resolved model refs", async () => {
    const { calls, respond } = captureRespond();

    await modelModeHandlers["model-mode.agent-set"]({
      params: { agentId: "quinn", mode: "einstein" },
      respond,
      client: {},
      context: context(),
    } as any);

    expect(writeConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          list: [expect.objectContaining({ id: "quinn", model: "anthropic/claude-opus-4-6" })],
        }),
      }),
      {},
    );
    expect(calls[0]).toMatchObject({
      ok: true,
      payload: expect.objectContaining({
        agentId: "quinn",
        effectiveModel: "anthropic/claude-opus-4-6",
      }),
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run --config vitest.gateway.config.ts src/gateway/server-methods/model-mode.brain-profiles.test.ts
```

Expected: FAIL because current payload has only legacy `model` fields and gateway does not call brain patch helpers.

- [ ] **Step 3: Update gateway imports**

Modify `src/gateway/server-methods/model-mode.ts` imports:

```ts
import {
  resolveBrainProfileForMode,
  type NormalizedBrainTierConfig,
} from "../../agents/brain-profiles.js";
import {
  applyAgentBrainTierPatch,
  applyGlobalBrainTierPatch,
} from "../../agents/brain-config-patch.js";
```

Remove `applyMergePatch`, `MODEL_TIER_MAP`, and `getProviderModelForTier` imports if they become unused.

- [ ] **Step 4: Update `model-mode.get` payload**

Replace the `tiers` object construction:

```ts
tiers: Object.fromEntries(
  (["economy", "baller", "einstein"] as const).map((mode) => {
    const resolved = resolveBrainProfileForMode(tierConfig, mode);
    return [
      mode,
      {
        label: MODEL_TIER_LABELS[mode],
        model: resolved.model,
        modelRef: resolved.modelRef,
        profileId: resolved.profileId,
        provider: resolved.provider,
        auth: resolved.auth,
        billing: resolved.billing,
        commercialSafe: resolved.commercialSafe,
        cost: MODEL_TIER_COST[mode],
        color: MODEL_TIER_COLORS[mode],
      },
    ];
  }),
),
tierRouting: tierConfig.tierRouting,
brainProfiles: Object.fromEntries(
  Object.entries(tierConfig.brainProfiles).map(([id, profile]) => [
    id,
    {
      id,
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      modelRef: profile.modelRef,
      auth: profile.auth,
      billing: profile.billing,
      commercialSafe: profile.commercialSafe,
      notes: profile.notes,
    },
  ]),
),
```

- [ ] **Step 5: Update write helpers to use pure patch functions**

Replace `writeAgentModelPatch` body after snapshot validation with:

```ts
const config = applyAgentBrainTierPatch(
  snapshot.config as Record<string, unknown>,
  agentId,
  mode,
  tierConfig as NormalizedBrainTierConfig,
);
const validated = validateConfigObjectWithPlugins(config);
const configToWrite = validated.ok ? validated.config : config;
```

Replace `writeGlobalTierChange` body after snapshot validation with:

```ts
const config = applyGlobalBrainTierPatch(
  snapshot.config as Record<string, unknown>,
  mode,
  tierConfig as NormalizedBrainTierConfig,
);
const validated = validateConfigObjectWithPlugins(config);
if (!validated.ok) {
  return { ok: false, error: "config validation failed" };
}
```

- [ ] **Step 6: Update `set` and `agent-set` responses**

In `model-mode.set`, compute after `saveModelTierConfig(tierConfig)`:

```ts
const resolved = resolveBrainProfileForMode(tierConfig, mode as ModelTierMode);
```

Return:

```ts
{
  ok: true,
  globalMode: mode,
  model: resolved.model,
  modelRef: resolved.modelRef,
  profileId: resolved.profileId,
  provider: resolved.provider,
  auth: resolved.auth,
  billing: resolved.billing,
  label: MODEL_TIER_LABELS[mode as ModelTierMode],
}
```

In `model-mode.agent-set`, compute:

```ts
const resolved = resolveBrainProfileForMode(tierConfig, effectiveMode);
```

Return:

```ts
{
  ok: true,
  agentId,
  mode: mode === "inherit" ? "inherit" : mode,
  effectiveMode,
  effectiveModel: resolved.modelRef,
  profileId: resolved.profileId,
  provider: resolved.provider,
  auth: resolved.auth,
  billing: resolved.billing,
}
```

- [ ] **Step 7: Run gateway tests**

Run:

```bash
pnpm exec vitest run --config vitest.gateway.config.ts src/gateway/server-methods/model-mode.brain-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/server-methods/model-mode.ts src/gateway/server-methods/model-mode.brain-profiles.test.ts
git commit -m "feat: route model mode through brain profiles" -m "[codex] Resolve gateway model-mode writes through provider-neutral brain profiles."
```

## Task 5: GPT-5.5 Catalog, Filter, and Forward Compatibility

**Files:**
- Modify: `src/agents/live-model-filter.ts`
- Modify: `src/agents/model-catalog.ts`
- Modify: `src/agents/model-forward-compat.ts`
- Modify: `src/agents/model-catalog.test.ts`
- Modify: `src/agents/model-compat.test.ts`

- [ ] **Step 1: Write failing GPT-5.5 tests**

In `src/agents/model-compat.test.ts`, update the OpenAI modern selection test:

```ts
expect(isModernModelRef({ provider: "openai-codex", id: "gpt-5.5" })).toBe(true);
```

Add a forward-compat test:

```ts
it("resolves openai-codex gpt-5.5 via codex template fallback", () => {
  const registry = createRegistry({
    "openai-codex/gpt-5.4": createOpenAICodexTemplateModel("gpt-5.4"),
  });
  const model = resolveForwardCompatModel("openai-codex", "gpt-5.5", registry);
  expectResolvedForwardCompat(model, { provider: "openai-codex", id: "gpt-5.5" });
  expect(model?.api).toBe("openai-codex-responses");
  expect(model?.baseUrl).toBe("https://chatgpt.com/backend-api");
  expect(model?.reasoning).toBe(true);
});
```

In `src/agents/model-catalog.test.ts`, inside `adds gpt-5.4 forward-compat catalog entries when template models exist`, add:

```ts
expect(result).toContainEqual(
  expect.objectContaining({
    provider: "openai-codex",
    id: "gpt-5.5",
    name: "gpt-5.5",
  }),
);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/model-compat.test.ts src/agents/model-catalog.test.ts
```

Expected: FAIL because `gpt-5.5` is not listed in modern Codex models and no forward/catalog fallback exists.

- [ ] **Step 3: Update live model filter**

Modify `src/agents/live-model-filter.ts`:

```ts
const CODEX_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.1-codex-max",
];
```

- [ ] **Step 4: Update catalog synthetic fallback**

Modify `src/agents/model-catalog.ts` constants:

```ts
const OPENAI_CODEX_GPT55_MODEL_ID = "gpt-5.5";
```

Add this before the existing Codex `gpt-5.4` fallback:

```ts
{
  provider: CODEX_PROVIDER,
  id: OPENAI_CODEX_GPT55_MODEL_ID,
  templateIds: ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"],
},
```

- [ ] **Step 5: Update forward compatibility**

Modify `src/agents/model-forward-compat.ts`:

```ts
const OPENAI_CODEX_GPT_55_MODEL_ID = "gpt-5.5";
const OPENAI_CODEX_GPT_55_CONTEXT_TOKENS = 1_050_000;
const OPENAI_CODEX_GPT_55_MAX_TOKENS = 128_000;
const OPENAI_CODEX_GPT_55_TEMPLATE_MODEL_IDS = ["gpt-5.4", "gpt-5.3-codex", "gpt-5.2-codex"] as const;
```

In `resolveOpenAICodexForwardCompatModel`, add the first branch:

```ts
if (lower === OPENAI_CODEX_GPT_55_MODEL_ID) {
  templateIds = OPENAI_CODEX_GPT_55_TEMPLATE_MODEL_IDS;
  eligibleProviders = CODEX_GPT54_ELIGIBLE_PROVIDERS;
  patch = {
    contextWindow: OPENAI_CODEX_GPT_55_CONTEXT_TOKENS,
    maxTokens: OPENAI_CODEX_GPT_55_MAX_TOKENS,
  };
} else if (lower === OPENAI_CODEX_GPT_54_MODEL_ID) {
```

- [ ] **Step 6: Run tests to verify they pass**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/model-compat.test.ts src/agents/model-catalog.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/agents/live-model-filter.ts src/agents/model-catalog.ts src/agents/model-forward-compat.ts src/agents/model-catalog.test.ts src/agents/model-compat.test.ts
git commit -m "feat: add codex gpt-5.5 model compatibility" -m "[codex] Register GPT-5.5 for Codex filtering, catalog fallback, and forward compatibility."
```

## Task 6: Extension API Exports and Focused Regression Run

**Files:**
- Modify: `src/extensionAPI.ts`

- [ ] **Step 1: Export brain profile API**

Modify `src/extensionAPI.ts`:

```ts
export {
  DEFAULT_BRAIN_PROFILES,
  LEGACY_BRAIN_PROFILES,
  LEGACY_TIER_ROUTING,
  normalizeBrainTierConfigParts,
  resolveBrainProfileForMode,
  resolveBrainProfileForAgent,
  type BrainAuthType,
  type BrainBillingType,
  type BrainProfile,
  type BrainTierRouting,
  type ResolvedBrainProfile,
} from "./agents/brain-profiles.ts";
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/brain-profiles.test.ts src/agents/model-tiers.test.ts src/agents/brain-config-patch.test.ts src/agents/model-compat.test.ts src/agents/model-catalog.test.ts
pnpm exec vitest run --config vitest.gateway.config.ts src/gateway/server-methods/model-mode.brain-profiles.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck/lint for touched surfaces**

Run:

```bash
pnpm tsgo
pnpm lint
```

Expected: PASS. If repo-wide lint reveals unrelated pre-existing failures, capture exact failing file/rule and run the narrower command that covers touched files if the repo supports it.

- [ ] **Step 4: Commit**

```bash
git add src/extensionAPI.ts
git commit -m "chore: export brain profile router API" -m "[codex] Expose provider-neutral brain profile helpers to downstream consumers."
```

## Task 7: Self-Review and Handoff Notes

**Files:**
- Modify: `docs/superpowers/plans/2026-05-20-provider-neutral-brain-profile-router.md` only if implementation discoveries change the plan.

- [ ] **Step 1: Verify spec coverage**

Check these requirements against code:

```text
Legacy model-tiers.json loads.
Configured tierRouting and brainProfiles load.
getProviderModelForTier can resolve openai-codex/gpt-5.5.
Subscription to metered fallback is blocked by default.
Local profile metadata is first-class.
model-mode.get returns public-safe profile metadata.
model-mode.set patches agents.defaults.model, agents.list, and agents.defaults.models params.
model-mode.agent-set respects per-agent overrides and inherit.
gpt-5.5 appears in Codex modern model filter and catalog fallback.
No Quinn-Co runtime files changed.
No Mission Control files changed.
```

- [ ] **Step 2: Inspect diff**

Run:

```bash
git status --short
git diff --stat HEAD
git diff --check
```

Expected:

```text
git status shows only intended OpenClaw files before each commit, or clean after the final commit.
git diff --check exits 0.
```

- [ ] **Step 3: Final verification command**

Run:

```bash
pnpm exec vitest run --config vitest.config.ts src/agents/brain-profiles.test.ts src/agents/model-tiers.test.ts src/agents/brain-config-patch.test.ts src/agents/model-compat.test.ts src/agents/model-catalog.test.ts
pnpm exec vitest run --config vitest.gateway.config.ts src/gateway/server-methods/model-mode.brain-profiles.test.ts
pnpm tsgo
```

Expected: PASS.

- [ ] **Step 4: Update Codex handoff after implementation approval and completion**

Update `C:\AI\handoffs\codex.md` with:

```md
- OpenClaw provider-neutral Brain Profile Router framework implementation completed in isolated worktree `C:\Users\jared\.config\superpowers\worktrees\openclaw\codex-brain-profile-router` on branch `codex/brain-profile-router`.
- Implemented files: brain profile resolver, model-tier config normalization, gateway model-mode integration, Codex GPT-5.5 catalog/filter/forward-compat.
- Verification: <paste exact commands and pass/fail>.
- Not done: Mission Control route, Quinn-Co runtime bypasses, Quinn-Co config switch, metadata cleanup.
- Root `C:\AI\openclaw\CLAUDE.md` in-flight banner remains until downstream phases are handed off or shipped.
```

## Separate Plan Required: Mission Control Lockstep

Do not execute this from the OpenClaw worktree. Create a separate Mission Control worktree and plan first.

Minimum Phase 2 files:

- `C:\Users\jared\Projects\mission-control\app\api\agent-modes\route.ts`
- Tests under Mission Control's existing API route test pattern.

Required behavior:

- Read `model-tiers.json.globalMode` for master mode.
- Read `agentOverrides[agentId]` for per-agent mode.
- Stop deriving mode from model strings containing `sonnet` or `opus`.
- Display provider/model/auth/billing metadata when present.
- Keep direct file writes for this first migration; gateway-only writes can follow later.

## Separate Plan Required: Quinn-Co Runtime and Config

Do not touch `C:\AI\quinn-co\workspace` until its dirty worktree is handled or Jared approves a separate isolated plan.

Minimum Phase 3 files after isolation:

- `services\nl-workflow-builder\parser.ts`
- `services\voice\voice-session.ts`
- `scripts\enrich-intake.mjs`
- `enforcement\modules\04-token-metering\anthropic-proxy.ts`

Minimum Phase 4 state/config files after runtime bypasses pass:

- `C:\Users\jared\.openclaw-quinn-co\model-tiers.json`
- `C:\Users\jared\.openclaw-quinn-co\openclaw.json`

Required Quinn-Co verification before default switch:

- Controlled OpenClaw task uses `openai-codex/gpt-5.5` through OAuth.
- OpenAI API billing does not move for OAuth-controlled task.
- Direct Anthropic REST bypasses are gone or explicitly configured as provider-specific exceptions.
- Security allowlists include `chatgpt.com` for Codex OAuth and do not remove Anthropic allowlist before Anthropic paths are retired.
