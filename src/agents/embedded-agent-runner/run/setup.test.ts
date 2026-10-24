import { describe, expect, it, vi } from "vitest";
import { resolveCompactionThreshold } from "../../../auto-reply/reply/memory-flush.js";
import { resolveContextTokens } from "../../../auto-reply/reply/model-selection-context.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../../plugins/provider-runtime-model.types.js";
import { AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE } from "../../../sessions/agent-harness-session-key.js";
import { createNativeModelOwnedRuntimeModel } from "../../defaults.js";
import { AuthStorage } from "../../sessions/auth-storage.js";
import { ModelRegistry } from "../../sessions/model-registry.js";
import { resolveEmbeddedRunEffectiveModel } from "./model-harness.js";
import {
  buildBeforeModelResolveAttachments,
  resolveAgentHarnessRunAdmissionError,
  resolveEmbeddedRuntimeModelPolicy,
  resolveHookModelSelection,
} from "./setup.js";

const hookContext = { sessionId: "session-1", workspaceDir: "/tmp/workspace" };

type EffectiveModelInput = Parameters<typeof resolveEmbeddedRunEffectiveModel>[0];
function effectiveModel(
  runParams: Partial<EffectiveModelInput["runParams"]> = {},
  overrides: Partial<Omit<EffectiveModelInput, "runParams">> = {},
) {
  return resolveEmbeddedRunEffectiveModel({
    provider: "openai",
    modelConfigProvider: "openai",
    modelId: "gpt-5.5",
    agentHarnessId: "openclaw",
    nativeModelOwned: false,
    runtimeModel: createRuntimeModel(),
    ...overrides,
    runParams: {
      sessionId: "test-session",
      workspaceDir: hookContext.workspaceDir,
      prompt: "hello",
      runId: "test-run",
      timeoutMs: 5_000,
      ...runParams,
    },
  });
}

function modelConfig(
  models: ModelDefinitionConfig[],
  provider = "openai",
  baseUrl = "https://api.openai.com/v1",
): OpenClawConfig {
  return { models: { providers: { [provider]: { baseUrl, models } } } };
}

function expectBudget(
  result: ReturnType<typeof resolveEmbeddedRuntimeModelPolicy>,
  tokens: number,
  source?: "resolved-v1",
) {
  expect(result).toMatchObject({
    contextTokenBudget: tokens,
    effectiveModel: { contextWindow: tokens },
  });
  expect(result.contextTokensSource).toBe(source);
}

function modelPolicy(overrides: Partial<Parameters<typeof resolveEmbeddedRuntimeModelPolicy>[0]>) {
  return resolveEmbeddedRuntimeModelPolicy({
    cfg: {},
    provider: "openai",
    modelId: "gpt-5.5",
    nativeModelOwned: false,
    runtimeModel: createRuntimeModel(),
    ...overrides,
  });
}

describe("agent harness run admission", () => {
  const sessionKey = "agent:main:harness:codex:supervision:native-thread";
  const entry: SessionEntry = {
    agentHarnessId: "codex",
    modelSelectionLocked: true,
    sessionId: "native-session",
    updatedAt: 1,
  };
  const admissionError = (
    overrides: Partial<Parameters<typeof resolveAgentHarnessRunAdmissionError>[0]> = {},
  ) =>
    resolveAgentHarnessRunAdmissionError({
      agentHarnessId: "codex",
      entry,
      modelSelectionLocked: true,
      sessionId: "native-session",
      sessionKey,
      ...overrides,
    });

  it("accepts only the matching requested and durable harness lock", () => {
    expect(admissionError()).toBeUndefined();
  });

  it("keeps a pre-existing unlocked harness-prefixed session on the ordinary runtime path", () => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        entry: { agentHarnessId: "openclaw", sessionId: "legacy-session", updatedAt: 1 },
        sessionId: "legacy-session",
        sessionKey: "agent:main:harness:notes",
      }),
    ).toBeUndefined();
  });

  it("accepts an ordinary-key session with the exact durable harness lock", () => {
    expect(admissionError({ sessionKey: "agent:main:main" })).toBeUndefined();
  });

  it("keeps a legacy model-selection lock on the ordinary runtime path", () => {
    expect(
      resolveAgentHarnessRunAdmissionError({
        entry: { modelSelectionLocked: true, sessionId: "legacy-session", updatedAt: 1 },
        sessionId: "legacy-session",
        sessionKey: "agent:main:main",
      }),
    ).toBeUndefined();
  });

  it.each([
    ["a different session id", { sessionId: "other-session" }],
    ["an omitted runtime lock", { modelSelectionLocked: undefined }],
    ["a different harness", { agentHarnessId: "openclaw" }],
  ])("rejects an ordinary-key locked session with %s", (_label, overrides) => {
    expect(admissionError({ sessionKey: "agent:main:main", ...overrides })).toBe(
      AGENT_HARNESS_SESSION_ID_LOCKED_MESSAGE,
    );
  });

  it.each([
    { agentHarnessId: "openclaw", modelSelectionLocked: true, entry },
    { agentHarnessId: "codex", modelSelectionLocked: false, entry },
    { agentHarnessId: "codex", modelSelectionLocked: true, entry: undefined },
    {
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      entry: { ...entry, sessionId: "stale-session" },
    },
  ])("rejects a mismatched or missing reserved runtime", (params) => {
    expect(admissionError(params)).toContain("reserved");
  });
});

describe("buildBeforeModelResolveAttachments", () => {
  it("maps prompt image metadata to before_model_resolve attachments", () => {
    expect(
      buildBeforeModelResolveAttachments([{ mimeType: "image/png" }, { mimeType: "image/jpeg" }]),
    ).toEqual([
      { kind: "image", mimeType: "image/png" },
      { kind: "image", mimeType: "image/jpeg" },
    ]);
  });

  it("omits attachments when there are no images", () => {
    expect(buildBeforeModelResolveAttachments(undefined)).toBeUndefined();
    expect(buildBeforeModelResolveAttachments([])).toBeUndefined();
  });
});

describe("resolveHookModelSelection", () => {
  it("does not expose locked model selection to routing hooks", async () => {
    const hookRunner = { hasHooks: vi.fn(() => true), runBeforeModelResolve: vi.fn() };

    await expect(
      resolveHookModelSelection({
        prompt: "private review transcript",
        provider: "foreground-provider",
        modelId: "foreground-model",
        modelSelectionLocked: true,
        hookRunner,
        hookContext,
      }),
    ).resolves.toEqual({ provider: "foreground-provider", modelId: "foreground-model" });
    expect(hookRunner.hasHooks).not.toHaveBeenCalled();
    expect(hookRunner.runBeforeModelResolve).not.toHaveBeenCalled();
  });

  it("passes attachment metadata and normalizes the provider returned by routing hooks", async () => {
    const attachments = [{ kind: "image" as const, mimeType: "image/png" }];
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => ({
        providerOverride: "  VISION-PROVIDER  ",
        modelOverride: "vision-model",
      })),
    };

    const result = await resolveHookModelSelection({
      prompt: "describe this image",
      attachments,
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "describe this image", attachments },
      hookContext,
    );
    expect(result).toEqual({ provider: "vision-provider", modelId: "vision-model" });
  });

  it("omits the attachments key for text-only before_model_resolve hooks", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) => hookName === "before_model_resolve"),
      runBeforeModelResolve: vi.fn(async () => undefined),
    };

    await resolveHookModelSelection({
      prompt: "text only",
      provider: "default-provider",
      modelId: "default-model",
      hookRunner,
      hookContext,
    });

    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledWith(
      { prompt: "text only" },
      hookContext,
    );
  });
});

function createRuntimeModel(overrides: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel {
  return {
    provider: "openai",
    id: "gpt-5.5",
    name: "gpt-5.5",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_050_000,
    contextTokens: 272_000,
    maxTokens: 128_000,
    ...overrides,
  };
}

function createConfiguredModel(
  overrides: Partial<ModelDefinitionConfig> = {},
): ModelDefinitionConfig {
  const { id, name, reasoning, input, cost, contextWindow, maxTokens } = createRuntimeModel();
  return {
    id,
    name,
    reasoning,
    input,
    cost,
    contextWindow,
    maxTokens,
    contextTokens: 1_000_000,
    ...overrides,
  };
}

function selectableModel(id: string, contextTokens?: number) {
  return createRuntimeModel({
    provider: "anthropic",
    id,
    name: id,
    baseUrl: "https://api.anthropic.com",
    api: "anthropic-messages",
    input: ["text"],
    contextWindow: 1_000_000,
    contextTokens,
    contextWindows: [
      { id: "200k", label: "200K", contextWindow: 200_000 },
      { id: "1m", label: "1M", contextWindow: 1_000_000 },
    ],
    contextWindowDefault: "1m",
  });
}

describe("resolveEmbeddedRuntimeModelPolicy", () => {
  it.each([
    { fastMode: "ultrafast" as const, serviceTier: undefined, expected: 260_000 },
    { fastMode: true, serviceTier: undefined, expected: 922_000 },
    { fastMode: false, serviceTier: "ultrafast", expected: 922_000 },
    { fastMode: "ultrafast" as const, serviceTier: "priority", expected: 260_000 },
    { fastMode: "ultrafast" as const, serviceTier: "default", expected: 260_000 },
  ])(
    "caps client compaction only for the effective Ultrafast tier: $fastMode/$serviceTier",
    ({ fastMode, serviceTier, expected }) => {
      const result = effectiveModel(
        {
          fastMode,
          config: {
            agents: {
              defaults: {
                models: { "openai/gpt-5.5": { params: { fastMode: true, serviceTier } } },
              },
            },
          },
        },
        { runtimeModel: createRuntimeModel({ contextTokens: 922_000 }) },
      );
      expect(result.contextTokenBudget).toBe(expected);
      expect(result.effectiveModel.contextWindow).toBe(expected);
      if (expected === 260_000) {
        expect(result.contextWindowInfo?.referenceTokens).toBe(922_000);
        expect(result.contextTokensSource).toBeUndefined();
      }
    },
  );

  it("ignores undefined stream overrides when budgeting configured Ultrafast", () => {
    const result = effectiveModel(
      {
        streamParams: { fastMode: undefined },
        config: {
          agents: {
            defaults: { params: { fastMode: "ultrafast", responsesServerCompaction: false } },
          },
        },
      },
      { runtimeModel: createRuntimeModel({ contextTokens: 922_000 }) },
    );
    expect(result.contextTokenBudget).toBe(260_000);
  });

  it.each([["default", "priority"], ["default"]])(
    "preserves the budget when model policy downgrades Ultrafast: %j",
    (...requestServiceTiers) => {
      const params = {
        cfg: {},
        provider: "openai",
        modelId: "gpt-5.5",
        runtimeModel: createRuntimeModel({ contextTokens: 922_000 }),
        nativeModelOwned: false,
        requestServiceTiers,
      };
      expect(
        modelPolicy({ ...params, requestExtraParams: { fastMode: "ultrafast" } })
          .contextTokenBudget,
      ).toBe(922_000);
      expect(
        modelPolicy({ ...params, requestExtraParams: { serviceTier: "ultrafast" } })
          .contextTokenBudget,
      ).toBe(260_000);
    },
  );

  it("keeps an unknown model's generic fallback untrusted", () => {
    const result = modelPolicy({
      provider: "local-fixture",
      modelId: "unknown-window",
      runtimeModel: createRuntimeModel({ contextTokens: undefined, contextWindow: 0 }),
    });

    expect(result.contextWindowInfo).toEqual({ source: "default", tokens: 200_000 });
    expect(result.contextTokensSource).toBeUndefined();
  });

  it("rejects an authored context window below the floor despite a larger contextTokens cap", () => {
    const model = createConfiguredModel({
      id: "tiny-model",
      name: "Tiny model",
      contextWindow: 3_000,
      contextTokens: 16_000,
      maxTokens: 256,
    });
    const cfg = modelConfig([model], "custom", "https://models.example.test/v1");

    expect(() =>
      modelPolicy({
        cfg,
        provider: "custom",
        modelId: "tiny-model",
        runtimeModel: createRuntimeModel({
          id: model.id,
          name: model.name,
          provider: "custom",
          baseUrl: "https://models.example.test/v1",
          contextWindow: model.contextWindow,
          contextTokens: model.contextTokens,
          maxTokens: model.maxTokens,
        }),
      }),
    ).toThrow(
      "Model context window too small (3000 tokens; source=modelsConfig). Minimum is 4000.",
    );
  });

  it("uses the registered prompt budget for both reply maintenance and inference after replacement", () => {
    const registry = ModelRegistry.inMemory(AuthStorage.inMemory());
    const provider = "fixture-runtime";
    const id = "shared-model";
    // A -> B -> A metadata replacement models account-scoped rematerialization;
    // no credential selection, provider request, or operator state is involved.
    for (const contextTokens of [872_000, 64_000, 872_000]) {
      registry.registerProvider(provider, {
        api: "openai-responses",
        baseUrl: "https://models.example/v1",
        models: [
          {
            id,
            name: "Shared model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 1_000_000,
            contextTokens,
            maxTokens: 128_000,
          },
        ],
      });
      const runtimeModel = registry.find(provider, id)!;
      const earlyBudget = resolveContextTokens({
        cfg: {},
        provider,
        model: id,
        modelContextTokens: runtimeModel.contextTokens,
        modelContextWindow: runtimeModel.contextWindow,
      });
      expect(earlyBudget).toBe(contextTokens);
      expect(
        resolveCompactionThreshold({
          contextWindowTokens: earlyBudget,
          reserveTokensFloor: 20_000,
        }),
      ).toBe(contextTokens - 20_000);
      const inference = modelPolicy({ provider, modelId: id, runtimeModel });
      expect(inference.contextTokenBudget).toBe(contextTokens);
      expect(inference.contextTokensSource).toBe("resolved-v1");
      expect(inference.effectiveModel.contextWindow).toBe(contextTokens);
      expect(inference.effectiveModel.maxTokens).toBe(128_000);
      expect(runtimeModel.contextWindow).toBe(1_000_000);
    }
  });

  it.each([
    ["openai", "modelsConfig", 1_000_000, undefined],
    [undefined, "model", 272_000, "resolved-v1"],
  ] as const)(
    "resolves native context via %s",
    (contextConfigProvider, source, tokens, tokenSource) => {
      const cfg = modelConfig(
        [createConfiguredModel()],
        "openai",
        "https://chatgpt.com/backend-api/codex",
      );
      const result = modelPolicy({ cfg, provider: "codex", contextConfigProvider });
      expect(result.contextWindowInfo).toEqual({ source, tokens });
      expectBudget(result, tokens, tokenSource);
    },
  );

  it("caps the native run budget with the session-selected context window", () => {
    const runtimeModel = selectableModel("claude-fable-5");
    const resolve = (contextWindow?: string) =>
      modelPolicy({
        cfg: undefined,
        provider: "anthropic",
        modelId: "claude-fable-5",
        runtimeModel,
        ...(contextWindow ? { contextWindow } : {}),
      });

    const selected = resolve("200k");
    expectBudget(selected, 200_000);

    const unselected = resolve(undefined);
    expectBudget(unselected, 1_000_000);
  });

  it("keeps the session-selected context window ahead of discovered and configured caps", () => {
    const runtimeModel = selectableModel("claude-sonnet-5", 272_000);
    const resolve = (params: { cfg?: OpenClawConfig; contextWindow?: string }) =>
      modelPolicy({
        cfg: params.cfg,
        provider: "anthropic",
        modelId: "claude-sonnet-5",
        runtimeModel,
        ...(params.contextWindow ? { contextWindow: params.contextWindow } : {}),
      });

    const discovered = resolve({ contextWindow: "200k" });
    expectBudget(discovered, 200_000);

    const configured = resolve({
      contextWindow: "200k",
      cfg: modelConfig(
        [createConfiguredModel({ id: "claude-sonnet-5", contextTokens: 1_000_000 })],
        "anthropic",
        "https://api.anthropic.com",
      ),
    });
    expectBudget(configured, 200_000);

    const unselected = resolve({});
    expect(unselected.contextTokenBudget).toBe(272_000);
    expect(unselected.effectiveModel.contextWindow).toBe(272_000);
  });

  it("preserves the effective budget and adds an authored cap for plugin transports (#124702)", () => {
    const resolve = (models: ModelDefinitionConfig[]) =>
      effectiveModel({ config: modelConfig(models) }, { agentHarnessId: "claude-cli" });

    const capped = resolve([createConfiguredModel({ contextTokens: 32_000 })]);
    expect(capped.contextTokenBudget).toBe(32_000);
    expect(capped.contextTokensSource).toBeUndefined();
    expect(capped.authoredContextTokenCap).toBe(32_000);

    const discovered = resolve([]);
    expect(discovered.contextTokenBudget).toBe(272_000);
    expect(discovered).not.toHaveProperty("authoredContextTokenCap");
  });

  it("caps the effective attempt budget with the caller limit", () => {
    const result = effectiveModel({ contextTokenBudget: 32_000 });

    expectBudget(result, 32_000);
    expect(result.contextWindowInfo).toEqual({
      source: "model",
      tokens: 32_000,
      referenceTokens: 272_000,
    });
  });

  it("does not let the caller budget widen a smaller fallback model", () => {
    const result = effectiveModel(
      { contextTokenBudget: 32_000 },
      {
        provider: "fallback",
        modelConfigProvider: "fallback",
        modelId: "small-model",
        runtimeModel: createRuntimeModel({ id: "small-model", contextTokens: 16_000 }),
      },
    );

    expect(result.contextTokenBudget).toBe(16_000);
    expect(result.effectiveModel.contextWindow).toBe(16_000);
  });
});

describe("native model-owned harness policy", () => {
  it.each([
    ["native-large-a", 500_000, undefined, 500_000],
    ["native-large-b", 500_000, 64_000, 64_000],
    ["native-small-c", 24_000, 500_000, 24_000],
  ] as const)(
    "honors the authored exact-model budget for %s",
    (modelId, contextTokens, callerBudget, expected) => {
      const runtimeModel = createNativeModelOwnedRuntimeModel({ provider: "openai", modelId });
      const result = effectiveModel(
        {
          contextTokenBudget: callerBudget,
          config: modelConfig([createConfiguredModel({ id: modelId, contextTokens })]),
        },
        { modelId, agentHarnessId: "codex", runtimeModel, nativeModelOwned: true },
      );

      expect(result.contextTokenBudget).toBe(expected);
      expect(result.contextWindowInfo?.source).toBe("modelsConfig");
      expect(result.contextTokensSource).toBeUndefined();
      expect(result.authoredContextTokenCap).toBe(contextTokens);
      // Authored policy must not become discovered native capacity metadata.
      expect(result.effectiveModel).toBe(runtimeModel);
    },
  );

  it.each(["unknown-model", "gpt-5.5"])(
    "does not infer an unauthored native budget for %s",
    (modelId) => {
      const runtimeModel = createNativeModelOwnedRuntimeModel({ provider: "openai", modelId });
      const result = effectiveModel(
        {
          contextTokenBudget: 500_000,
          config: modelConfig([createConfiguredModel({ contextTokens: undefined })]),
        },
        { modelId, agentHarnessId: "codex", runtimeModel, nativeModelOwned: true },
      );

      expect(result).toEqual({ effectiveModel: runtimeModel });
    },
  );

  it("does not apply outer context guards, budgets, or authored caps to a pinned native session", () => {
    const runtimeModel = createRuntimeModel();
    const result = effectiveModel(
      {
        contextTokenBudget: 32_000,
        config: modelConfig([createConfiguredModel({ contextWindow: 1, contextTokens: 1 })]),
      },
      {
        modelId: runtimeModel.id,
        agentHarnessId: "codex",
        pinnedHarnessId: "codex",
        runtimeModel,
        nativeModelOwned: true,
      },
    );

    expect(result).toEqual({ effectiveModel: runtimeModel });
  });
});

describe("actual setup native prompt coherence", () => {
  it.each([
    [undefined, 777_000, 128_000],
    ["synthetic", 777_000, 777_000],
    ["synthetic", undefined, 128_000],
  ] as const)(
    "budgets native source %s with reported prompt %s",
    (contextWindowSource, contextTokens, expected) => {
      const result = modelPolicy({
        runtimeModel: createRuntimeModel({
          contextWindow: 128_000,
          contextTokens,
          contextWindowSource,
        }),
      });
      expect(result.contextTokenBudget).toBe(expected);
    },
  );
});
