import { describe, expect, it, vi } from "vitest";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import type { AuthProfileStore } from "../../auth-profiles.js";
import type { AgentHarness } from "../../harness/types.js";
import { buildEmbeddedRunModelAuthPlan } from "./model-auth-plan.js";

const MODEL = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-responses",
  baseUrl: "https://api.openai.test/v1",
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  provider: "openai",
  input: "chat",
  maxTokens: 4096,
  contextWindow: 128_000,
  reasoning: true,
} as unknown as ProviderRuntimeModel;

const EMPTY_AUTH_STORE: AuthProfileStore = {
  version: 1,
  profiles: {},
};

function harness(id: string): AgentHarness {
  return {
    id,
    label: id,
    supports: () => ({ supported: true }),
    runAttempt: async () => ({ payloads: [], meta: {} }) as never,
  };
}

function createDeps(options?: {
  authStore?: AuthProfileStore;
  forwardedAuthProfileId?: string;
  harnessId?: string;
  profileOrder?: string[];
  providerPreferredProfileId?: string;
  shouldPreferExplicitConfigApiKeyAuth?: boolean;
}) {
  const authStore = options?.authStore ?? EMPTY_AUTH_STORE;
  return {
    buildAgentRuntimeAuthPlan: vi.fn(() => ({
      authProfileProviderForAuth: "openai-codex",
      forwardedAuthProfileId: options?.forwardedAuthProfileId,
      providerForAuth: "codex",
    })),
    createEmptyAuthProfileStore: vi.fn(() => EMPTY_AUTH_STORE),
    ensureAuthProfileStore: vi.fn(() => authStore),
    ensureOpenClawModelsJson: vi.fn(async () => ({ agentDir: "/tmp/agent", wrote: false })),
    resolveAuthProfileEligibility: vi.fn(() => ({ eligible: true, reasonCode: "ok" as const })),
    resolveAuthProfileOrder: vi.fn(() => options?.profileOrder ?? []),
    resolveEffectiveRuntimeModel: vi.fn(() => ({
      ctxInfo: { tokens: 128_000, source: "model" as const },
      effectiveModel: MODEL,
    })),
    resolveModelAsync: vi.fn(async () => ({
      model: MODEL,
      authStorage: { kind: "auth-storage" } as never,
      modelRegistry: { kind: "model-registry" } as never,
    })),
    resolveProviderAuthProfileId: vi.fn(() => options?.providerPreferredProfileId),
    resolveProviderIdForAuth: vi.fn((provider: string) => provider),
    selectAgentHarness: vi.fn(() => harness(options?.harnessId ?? "pi")),
    shouldPreferExplicitConfigApiKeyAuth: vi.fn(
      () => options?.shouldPreferExplicitConfigApiKeyAuth ?? false,
    ),
  };
}

describe("embedded run model/auth plan", () => {
  it("lets plugin harnesses own transport without bootstrapping PI auth stores", async () => {
    const deps = createDeps({
      harnessId: "codex",
      shouldPreferExplicitConfigApiKeyAuth: true,
    });

    const plan = await buildEmbeddedRunModelAuthPlan({
      provider: "codex",
      modelId: "gpt-5.4",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      authProfileId: "openai-codex:work",
      authProfileIdSource: "user",
      deps,
    });

    expect(plan.pluginHarnessOwnsTransport).toBe(true);
    expect(plan.lockedProfileId).toBeUndefined();
    expect(plan.profileCandidates).toEqual([undefined]);
    expect(deps.createEmptyAuthProfileStore).toHaveBeenCalledTimes(1);
    expect(deps.ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(deps.ensureOpenClawModelsJson).not.toHaveBeenCalled();
    expect(deps.resolveAuthProfileEligibility).not.toHaveBeenCalled();
  });

  it("keeps user-locked plugin auth when RuntimePlan forwards it", async () => {
    const deps = createDeps({
      harnessId: "codex",
      forwardedAuthProfileId: "openai-codex:work",
    });

    const plan = await buildEmbeddedRunModelAuthPlan({
      provider: "codex",
      modelId: "gpt-5.4",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      authProfileId: "openai-codex:work",
      authProfileIdSource: "user",
      deps,
    });

    expect(plan.lockedProfileId).toBe("openai-codex:work");
    expect(plan.profileCandidates).toEqual(["openai-codex:work"]);
    expect(deps.buildAgentRuntimeAuthPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        harnessId: "codex",
        provider: "codex",
        sessionAuthProfileId: "openai-codex:work",
      }),
    );
  });

  it("clears a Pi locked profile when its provider does not match the run provider", async () => {
    const deps = createDeps({
      authStore: {
        version: 1,
        profiles: {
          "anthropic:work": {
            type: "api_key",
            provider: "anthropic",
            key: "secret",
          },
        },
      },
      profileOrder: ["openai:rotating"],
      providerPreferredProfileId: "openai:rotating",
    });

    const plan = await buildEmbeddedRunModelAuthPlan({
      provider: "openai",
      modelId: "gpt-5.4",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      authProfileId: "anthropic:work",
      authProfileIdSource: "user",
      deps,
    });

    expect(plan.pluginHarnessOwnsTransport).toBe(false);
    expect(plan.lockedProfileId).toBeUndefined();
    expect(plan.profileCandidates).toEqual(["openai:rotating"]);
    expect(deps.resolveAuthProfileEligibility).not.toHaveBeenCalled();
  });

  it("keeps an eligible Pi locked profile as the only profile candidate", async () => {
    const deps = createDeps({
      authStore: {
        version: 1,
        profiles: {
          "openai:work": {
            type: "api_key",
            provider: "openai",
            key: "secret",
          },
        },
      },
      profileOrder: ["openai:rotating"],
      providerPreferredProfileId: "openai:rotating",
    });

    const plan = await buildEmbeddedRunModelAuthPlan({
      provider: "openai",
      modelId: "gpt-5.4",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      deps,
    });

    expect(plan.lockedProfileId).toBe("openai:work");
    expect(plan.profileCandidates).toEqual(["openai:work"]);
    expect(deps.resolveAuthProfileEligibility).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        profileId: "openai:work",
      }),
    );
  });
});
