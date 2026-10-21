import { calculateCost, type Usage } from "openclaw/plugin-sdk/llm";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const { probeClaudeCliAuthStatusMock } = vi.hoisted(() => ({
  probeClaudeCliAuthStatusMock: vi.fn(),
}));

vi.mock("./cli-auth-seam.js", () => {
  return {
    probeClaudeCliAuthStatus: probeClaudeCliAuthStatusMock,
  };
});

import { CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";
import anthropicPlugin from "./index.js";
import {
  claude5ContractCases,
  createModelRegistry,
  expectFields,
  levelIds,
  makeModel,
} from "./model-contract-cases.test-support.js";
import anthropicProviderDiscovery from "./provider-discovery.js";

const modernLimits = { contextWindow: 1_000_000, contextTokens: 1_000_000, maxTokens: 128_000 };
let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
function thinking(modelId: string, providerId = "anthropic") {
  return provider.resolveThinkingProfile?.({ provider: providerId, modelId });
}
function resolveModel(
  modelId: string,
  overrides: Partial<ProviderResolveDynamicModelContext> = {},
) {
  return provider.resolveDynamicModel?.({
    provider: "anthropic",
    modelId,
    modelRegistry: createModelRegistry([]),
    ...overrides,
  } as ProviderResolveDynamicModelContext);
}
function defaults(
  config: Parameters<NonNullable<typeof provider.applyConfigDefaults>>[0]["config"],
) {
  return provider.applyConfigDefaults?.({ provider: "anthropic", env: {}, config });
}
async function setupCredential(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  try {
    const auth = provider.auth.find((entry) => entry.id === "setup-token");
    if (!auth) {
      throw new Error("expected Anthropic setup-token auth method");
    }
    const result = await auth.run({
      opts: { token: ANTHROPIC_SETUP_TOKEN, tokenExpiresIn: "1h" },
    } as never);
    return result?.profiles[0]?.credential;
  } finally {
    vi.useRealTimers();
  }
}

function normalizeModel(model: ProviderRuntimeModel) {
  return provider.normalizeResolvedModel?.({ provider: model.provider, modelId: model.id, model });
}

beforeEach(async () => {
  probeClaudeCliAuthStatusMock.mockReset();
  provider = await registerSingleProviderPlugin(anthropicPlugin);
});

afterAll(() => {
  vi.doUnmock("./cli-auth-seam.js");
  vi.resetModules();
});

const requireRecord = createRequireRecord("object", "expected-label");

function expectModelParams(models: unknown, modelId: string, params: Record<string, unknown>) {
  const model = requireRecord(requireRecord(models, "models")[modelId], modelId);
  expectFields(model.params, params);
}

const ANTHROPIC_SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;

describe("anthropic provider replay hooks", () => {
  it("lets native session discovery be disabled without disabling Anthropic", () => {
    const registerCliBackend = vi.fn();
    const registerNodeHostCommand = vi.fn();
    const registerNodeInvokePolicy = vi.fn();
    const registerProvider = vi.fn();
    const registerSessionCatalog = vi.fn();
    anthropicPlugin.register(
      createTestPluginApi({
        id: "anthropic",
        name: "Anthropic",
        source: "test",
        config: {},
        pluginConfig: { sessionCatalog: { enabled: false } },
        registerCliBackend,
        registerNodeHostCommand,
        registerNodeInvokePolicy,
        registerProvider,
        registerSessionCatalog,
      }),
    );

    expect(registerCliBackend).toHaveBeenCalledOnce();
    expect(registerNodeInvokePolicy).toHaveBeenCalledOnce();
    expect(registerProvider).toHaveBeenCalledOnce();
    expect(registerNodeHostCommand).not.toHaveBeenCalled();
    expect(registerSessionCatalog).not.toHaveBeenCalled();
  });

  it("owns native reasoning output mode for Claude transports", async () => {
    expect(
      provider.resolveReasoningOutputMode?.({
        provider: "anthropic",
        modelApi: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      } as never),
    ).toBe("native");
  });

  it("classifies Anthropic-native structured failover errors", async () => {
    const classify = (
      error: Partial<Parameters<NonNullable<typeof provider.classifyFailoverReason>>[0]>,
    ) => provider.classifyFailoverReason?.({ provider: "anthropic", errorMessage: "", ...error });
    for (const providerId of ["anthropic", "claude-cli"]) {
      expect(classify({ provider: providerId, errorType: "rate_limit_error" })).toBe("rate_limit");
      expect(classify({ provider: providerId, errorType: "api_error" })).toBe("server_error");
    }
    expect(classify({ errorType: "rate_limit_error", code: "API_ERROR" })).toBe("rate_limit");
    expect(classify({ code: "RATE_LIMIT_ERROR" })).toBe("rate_limit");
    expect(classify({ code: "API_ERROR" })).toBe("server_error");
    expect(classify({ errorType: "UNKNOWN_ERROR", code: "INSUFFICIENT_QUOTA" })).toBeUndefined();
  });

  it("backfills current Sonnet models into API-key agent model allowlists", async () => {
    const next = defaults({
      auth: {
        profiles: {
          "anthropic:api": { provider: "anthropic", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-6" },
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        },
      },
    });

    const models = next?.agents?.defaults?.models;
    expectFields(next?.agents?.defaults?.contextPruning, { mode: "cache-ttl", ttl: "1h" });
    expectFields(next?.agents?.defaults?.heartbeat, { every: "30m" });
    expectModelParams(models, "anthropic/claude-opus-4-6", { cacheRetention: "short" });
    expectModelParams(models, "anthropic/claude-sonnet-5-5", { cacheRetention: "short" });
    expectModelParams(models, "anthropic/claude-sonnet-5", { cacheRetention: "short" });
    expectModelParams(models, "anthropic/claude-sonnet-4-6", { cacheRetention: "short" });
  });

  it("backfills Claude CLI routing from a retired provider-entry profile reference", async () => {
    const next = defaults({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "anthropic:claude-cli",
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
        },
      },
    });

    expect(next?.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.agentRuntime).toEqual({
      id: "claude-cli",
    });
  });

  it("backfills Claude CLI policy from shorthand model-map keys under Claude CLI auth", async () => {
    const next = defaults({
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          models: {
            "anthropic/opus-4.7": { params: { maxTokens: 1200 } },
          },
        },
        entries: {
          main: {
            models: {
              "anthropic/sonnet-4.6": { alias: "Sonnet shorthand" },
            },
            name: "Main",
            workspace: "/tmp/openclaw-agent",
          },
        },
      },
    });

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-4.7"]).toEqual({
      params: { maxTokens: 1200 },
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/claude-opus-4-7"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/sonnet-4.6"]).toEqual({ agentRuntime: { id: "claude-cli" } });
    expect(models["anthropic/claude-sonnet-4-6"]).toEqual({
      agentRuntime: { id: "claude-cli" },
    });
  });

  it("does not backfill Claude CLI policy from an unselected rollback profile", async () => {
    const next = defaults({
      auth: {
        order: {
          anthropic: ["anthropic:oauth", "anthropic:claude-cli"],
        },
        profiles: {
          "anthropic:oauth": { provider: "anthropic", mode: "oauth" },
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/opus-4.7" },
          models: {
            "anthropic/opus-4.7": { params: { maxTokens: 1200 } },
          },
        },
      },
    });

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-4.7"]).toEqual({ params: { maxTokens: 1200 } });
    expect(models["anthropic/claude-opus-4-7"]).toBeUndefined();
  });

  it("backfills Claude CLI policy for unknown future Anthropic refs without guessing aliases", async () => {
    const next = defaults({
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/opus-5.0" },
          models: {
            "anthropic/opus-5.0": { alias: "Future Opus" },
          },
        },
      },
    });

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-5.0"]).toEqual({
      alias: "Future Opus",
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/claude-opus-5-0"]).toBeUndefined();
  });

  it.each(claude5ContractCases)(
    "$name",
    async ({
      modelId,
      defaultLevel = "high",
      cost,
      thinkingLevelMap,
      thinkingLevels,
      checksMedia,
      restoresMissingCost,
      checksCliPolicy,
    }) => {
      const resolved = resolveModel(modelId);
      expectFields(resolved, {
        provider: "anthropic",
        id: modelId,
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        cost,
        ...modernLimits,
        thinkingLevelMap,
      });
      if (checksMedia) {
        expect(requireRecord(resolved, `${modelId} model`).mediaInput).toEqual({
          image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
        });
      }
      const profile = thinking(modelId);
      expect(levelIds(profile)).toStrictEqual(thinkingLevels);
      expect(requireRecord(profile, `${modelId} thinking profile`).defaultLevel).toBe(defaultLevel);
      const normalized = provider.normalizeResolvedModel?.({
        provider: "anthropic",
        modelId,
        model: {
          ...(resolved as ProviderRuntimeModel),
          reasoning: false,
          ...(checksCliPolicy
            ? {}
            : { contextWindow: 200_000, contextTokens: 200_000, maxTokens: 64_000 }),
          ...(restoresMissingCost
            ? {
                cost:
                  restoresMissingCost === "tiers" && cost
                    ? {
                        input: cost.input,
                        output: cost.output,
                        cacheRead: cost.cacheRead,
                        cacheWrite: cost.cacheWrite,
                      }
                    : undefined,
              }
            : {}),
        } as ProviderRuntimeModel,
      } as never);
      expectFields(normalized, {
        reasoning: true,
        ...(checksCliPolicy
          ? {}
          : { contextWindow: 1_000_000, contextTokens: 1_000_000, maxTokens: 128_000 }),
        ...(restoresMissingCost ? { cost } : {}),
      });
      if (checksCliPolicy) {
        expect(resolveModel(modelId, { provider: "claude-cli" })).toBeUndefined();
        expect(thinking(modelId, "claude-cli")).toEqual(profile);
        expect(
          thinking("claude-opus-4-6", "claude-cli")?.levels.map((level) => level.id),
        ).toContain("max");
        expect(provider.isModernModelRef?.({ provider: "claude-cli", modelId })).toBe(false);
      }
    },
  );

  it.each([
    { modelId: "claude-sonnet-5-5", pricingSource: "configured" },
    { modelId: "claude-opus-4-8", pricingSource: "discovered" },
  ])(
    "uses $pricingSource $modelId pricing for assistant usage",
    async ({ modelId, pricingSource }) => {
      const configuredCost = { input: 777, output: 888, cacheRead: 999, cacheWrite: 666 };
      const config: NonNullable<ProviderResolveDynamicModelContext["config"]> = {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [
                {
                  id: modelId,
                  name: modelId,
                  reasoning: true,
                  input: ["text", "image"],
                  cost: configuredCost,
                  contextWindow: 1_000_000,
                  maxTokens: 128_000,
                },
              ],
            },
          },
        },
      };
      const discoveredModel = provider.resolveDynamicModel?.({
        config: pricingSource === "configured" ? config : {},
        provider: "anthropic",
        modelId,
        modelRegistry: createModelRegistry([]),
      } as ProviderResolveDynamicModelContext);
      expect(discoveredModel).toBeDefined();

      const configuredModel = {
        ...(discoveredModel as ProviderRuntimeModel),
        cost: configuredCost,
      };
      const resolvedModel =
        provider.normalizeResolvedModel?.({
          config: pricingSource === "configured" ? config : {},
          provider: "anthropic",
          modelId,
          model: configuredModel,
        } as never) ?? configuredModel;
      const usage: Usage = {
        input: 1_000,
        output: 1_000,
        cacheRead: 1_000,
        cacheWrite: 1_000,
        totalTokens: 4_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };

      calculateCost(resolvedModel as Parameters<typeof calculateCost>[0], usage);

      expect(resolvedModel.cost).toEqual(configuredCost);
      expect(usage.cost).toEqual({
        input: expect.closeTo(0.777),
        output: expect.closeTo(0.888),
        cacheRead: expect.closeTo(0.999),
        cacheWrite: expect.closeTo(0.666),
        total: expect.closeTo(3.33),
      });
    },
  );

  it("resolves Claude Mythos 5 with its direct-only mandatory-adaptive contract", async () => {
    const resolved = resolveModel("claude-mythos-5");

    expectFields(resolved, {
      provider: "anthropic",
      id: "claude-mythos-5",
      api: "anthropic-messages",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      ...modernLimits,
      thinkingLevelMap: {
        minimal: "low",
        xhigh: "xhigh",
        max: "max",
      },
    });
    expect(requireRecord(resolved, "Mythos model").mediaInput).toEqual({
      image: { maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
    });
    const thinkingProfile = thinking("claude-mythos-5");
    expect(thinkingProfile?.defaultLevel).toBe("high");
    expect(levelIds(thinkingProfile)).not.toContain("off");
    expect(resolveModel("claude-mythos-5", { provider: "claude-cli" })).toBeUndefined();
    expect(thinking("claude-mythos-5", "claude-cli")).toEqual({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
  });

  it.each(["2027-01-01T00:00:00Z"])("keeps published Sonnet 5 pricing on %s", async (timestamp) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(timestamp));
    onTestFinished(() => clock.mockRestore());
    const expectedCost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const model = makeModel("claude-sonnet-5", {
      name: "Claude Sonnet 5",
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      ...modernLimits,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });

    for (const candidate of [
      model,
      { ...model, id: "deployment-sonnet", params: { canonicalModelId: model.id } },
    ]) {
      expect(normalizeModel(candidate)?.cost).toEqual(expectedCost);
    }
    expect(resolveModel("claude-sonnet-5-20260901")?.cost).toEqual(expectedCost);
  });

  it("uses canonical model identity instead of a Fable-looking deployment alias", async () => {
    const model = makeModel("claude-fable-5-prod", {
      name: "Production Claude",
      baseUrl: "https://api.anthropic.com",
      reasoning: false,
      input: ["text"],
      params: { canonicalModelId: "claude-opus-4-8" },
      mediaInput: { image: { maxBytes: 1 } },
    });

    expectFields(normalizeModel(model), {
      reasoning: false,
      input: ["text", "image"],
      mediaInput: {
        image: { maxBytes: 1, maxSidePx: 2576, preferredSidePx: 2576, tokenMode: "provider" },
      },
      ...modernLimits,
      thinkingLevelMap: {
        xhigh: "xhigh",
        max: "max",
      },
    });
    expect(
      provider.resolveThinkingProfile?.({
        provider: "anthropic",
        modelId: model.id,
        params: model.params,
      } as never)?.defaultLevel,
    ).toBe("off");
  });

  it("does not forward-compat case-mismatched Anthropic model ids", async () => {
    const resolved = provider.resolveDynamicModel?.({
      provider: "anthropic",
      modelId: "CLAUDE-OPUS-4-7",
      modelRegistry: createModelRegistry([
        makeModel("claude-opus-4-6", { name: "Claude Opus 4.6", maxTokens: 32_000 }),
      ]),
    } as ProviderResolveDynamicModelContext);

    expect(resolved).toBeUndefined();
  });

  it("normalizes Claude Mythos Preview with native max but no xhigh thinking map", async () => {
    const normalized = normalizeModel(
      makeModel("claude-mythos-preview", {
        name: "Claude Mythos Preview",
        input: ["text", "image"],
      }),
    );

    expect(normalized?.thinkingLevelMap).toEqual({ max: "max" });
  });

  it("does not normalize numeric successors as known Claude contracts", async () => {
    const normalized = normalizeModel(
      makeModel("claude-opus-4-60", { name: "Claude Opus 4.60", input: ["text"] }),
    );

    expect(normalized).toBeUndefined();
  });

  it("preserves configured modern output limits", () => {
    const model = makeModel("claude-sonnet-4-6", {
      name: "Claude Sonnet 4.6",
      baseUrl: "https://api.anthropic.com",
      maxTokens: 128,
      maxTokensSource: "configured",
    });

    const normalized = normalizeModel(model) ?? model;

    expect(normalized).toMatchObject({ maxTokens: 128, maxTokensSource: "configured" });
  });

  it("keeps bare Claude CLI context plan-safe and honors explicit 1M variants", async () => {
    const baseModel = makeModel("claude-opus-4-7", {
      name: "Claude Opus 4.7",
      provider: "claude-cli",
      contextTokens: 200_000,
    });

    expectFields(normalizeModel(baseModel), {
      contextWindow: 200_000,
      contextTokens: 200_000,
      maxTokens: 128_000,
    });
    expectFields(normalizeModel({ ...baseModel, id: `${baseModel.id}[1m]` }), modernLimits);
  });

  it("stores setup-token expiry from a bounded duration", async () => {
    expect(await setupCredential(1_000)).toMatchObject({
      type: "token",
      provider: "anthropic",
      token: ANTHROPIC_SETUP_TOKEN,
      expires: 3_601_000,
    });
  });
  it.each([
    {
      name: "preflights non-interactive setup-token input without writing credentials",
      opts: {},
    },
    {
      name: "rejects setup-token ref storage during non-interactive preflight",
      opts: { secretInputMode: "ref" }, // pragma: allowlist secret
      error:
        "Anthropic setup-token input cannot be stored with --secret-input-mode ref. Use --secret-input-mode plaintext.",
    },
    {
      name: "rejects invalid setup-token expiry during non-interactive preflight",
      opts: { tokenExpiresIn: "nope" },
      error: "Invalid --token-expires-in",
    },
    {
      name: "rejects missing setup-token input during non-interactive preflight",
      opts: { token: "" },
      error: "Anthropic setup-token auth requires --token with a valid setup-token.",
    },
  ] as Array<{
    name: string;
    opts: Record<string, string>;
    error?: string;
  }>)("$name", async ({ opts, error }) => {
    const setupTokenAuth = provider.auth.find((entry) => entry.id === "setup-token");
    if (!setupTokenAuth?.validateNonInteractive) {
      throw new Error("expected setup-token reset preflight");
    }
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

    const validation = setupTokenAuth.validateNonInteractive({
      authChoice: "setup-token",
      config: {},
      baseConfig: {},
      opts: { token: ANTHROPIC_SETUP_TOKEN, ...opts },
      runtime,
      resolveApiKey: vi.fn(async () => null),
    });

    if (error) {
      await expect(validation).rejects.toThrow(error);
    } else {
      await expect(validation).resolves.toBe(true);
    }
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("omits setup-token expiry when duration overflows the Date range", async () => {
    expect(await setupCredential(8_640_000_000_000_000)).toEqual({
      type: "token",
      provider: "anthropic",
      token: ANTHROPIC_SETUP_TOKEN,
    });
  });
  it.each([
    { status: "available", authenticated: true },
    { status: "missing", authenticated: false },
  ] as const)(
    "publishes native Claude auth unless its CLI confirms logout: $status",
    async ({ status, authenticated }) => {
      probeClaudeCliAuthStatusMock.mockResolvedValue({ status });
      const config = {};

      const runtimeAuth = await provider.prepareSyntheticAuth?.({
        config,
        provider: "claude-cli",
      } as never);
      const discoveryAuth = await anthropicProviderDiscovery.prepareSyntheticAuth?.({
        config,
        provider: "claude-cli",
      } as never);
      for (const auth of [runtimeAuth, discoveryAuth]) {
        expect(auth).toEqual(
          authenticated
            ? {
                apiKey: CLAUDE_CLI_NATIVE_AUTH_MARKER,
                source: "Claude CLI native auth",
                mode: "oauth",
                nativeAuth: { runtime: "claude-cli", mode: "oauth" },
              }
            : undefined,
        );
      }
      expect(
        await provider.prepareSyntheticAuth?.({ provider: "claude-cli" } as never),
      ).toBeUndefined();
      expect(probeClaudeCliAuthStatusMock).toHaveBeenCalledOnce();
    },
  );
});
