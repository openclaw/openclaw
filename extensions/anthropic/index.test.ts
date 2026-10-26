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

// mock-isolation: Provider registration uses synthetic CLI auth status without probing local credentials.
vi.mock("./cli-auth-seam.js", () => ({ probeClaudeCliAuthStatus: probeClaudeCliAuthStatusMock }));

import { CLAUDE_CLI_NATIVE_AUTH_MARKER } from "./cli-constants.js";
import anthropicPlugin from "./index.js";
import {
  claude5ContractCases,
  createModelRegistry,
  expectFields,
  levelIds,
  makeModel,
} from "./model-contract-cases.test-support.js";

const modernLimits = { contextWindow: 1_000_000, contextTokens: 1_000_000, maxTokens: 128_000 };
const modelContracts: Array<(typeof claude5ContractCases)[number] & { directOnly?: boolean }> = [
  ...claude5ContractCases,
  {
    name: "resolves Mythos 5 with its direct-only mandatory-adaptive contract",
    modelId: "claude-mythos-5",
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" },
    thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
    checksMedia: true,
    directOnly: true,
  },
];
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
type Config = Parameters<NonNullable<typeof provider.applyConfigDefaults>>[0]["config"];
function defaults(config: Config) {
  return provider.applyConfigDefaults?.({ provider: "anthropic", env: {}, config });
}
function withDefaults(
  agentDefaults: NonNullable<NonNullable<Config["agents"]>["defaults"]>,
  extra: Config = {},
) {
  return defaults({ agents: { defaults: agentDefaults }, ...extra });
}
const cliAuth: Config["auth"] = {
  profiles: { "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" } },
};
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

function normalizeModel(model: ProviderRuntimeModel, config?: Config) {
  return provider.normalizeResolvedModel?.({
    provider: model.provider,
    modelId: model.id,
    model,
    config,
  });
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

const ANTHROPIC_SETUP_TOKEN = `sk-ant-oat01-${"a".repeat(80)}`;
function providerConfig(
  models: NonNullable<NonNullable<Config["models"]>["providers"]>[string]["models"],
  apiKey?: string,
): Config {
  return {
    models: {
      providers: {
        anthropic: { baseUrl: "https://api.anthropic.com", models, ...(apiKey ? { apiKey } : {}) },
      },
    },
  };
}

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
    const next = withDefaults(
      {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
      },
      { auth: { profiles: { "anthropic:api": { provider: "anthropic", mode: "api_key" } } } },
    );

    for (const id of ["opus-4-6", "sonnet-5-5", "sonnet-5", "sonnet-4-6"]) {
      expect(next?.agents?.defaults?.models?.[`anthropic/claude-${id}`]?.params).toMatchObject({
        cacheRetention: "short",
      });
    }
  });

  it("backfills Claude CLI routing from a retired provider-entry profile reference", async () => {
    const next = withDefaults(
      { model: { primary: "anthropic/claude-sonnet-4-6" } },
      providerConfig([], "anthropic:claude-cli"),
    );

    expect(next?.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.agentRuntime).toEqual({
      id: "claude-cli",
    });
  });

  it("backfills Claude CLI policy from shorthand model-map keys under Claude CLI auth", async () => {
    const next = defaults({
      auth: cliAuth,
      agents: {
        defaults: {
          models: { "anthropic/opus-4.7": { params: { maxTokens: 1200 } } },
        },
        entries: {
          main: {
            models: { "anthropic/sonnet-4.6": { alias: "Sonnet shorthand" } },
            name: "Main",
            workspace: "/tmp/openclaw-agent",
          },
        },
      },
    });

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expectFields(models, {
      "anthropic/opus-4.7": { params: { maxTokens: 1200 }, agentRuntime: { id: "claude-cli" } },
      "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
      "anthropic/sonnet-4.6": { agentRuntime: { id: "claude-cli" } },
      "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
    });
  });

  it("does not backfill Claude CLI policy from an unselected rollback profile", async () => {
    const next = withDefaults(
      {
        model: { primary: "anthropic/opus-4.7" },
        models: { "anthropic/opus-4.7": { params: { maxTokens: 1200 } } },
      },
      {
        auth: {
          ...cliAuth,
          order: { anthropic: ["anthropic:oauth", "anthropic:claude-cli"] },
          profiles: {
            ...cliAuth?.profiles,
            "anthropic:oauth": { provider: "anthropic", mode: "oauth" },
          },
        },
      },
    );

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-4.7"]).toEqual({ params: { maxTokens: 1200 } });
    expect(models["anthropic/claude-opus-4-7"]).toBeUndefined();
  });

  it("backfills Claude CLI policy for unknown future Anthropic refs without guessing aliases", async () => {
    const next = withDefaults(
      {
        model: { primary: "anthropic/opus-5.0" },
        models: { "anthropic/opus-5.0": { alias: "Future Opus" } },
      },
      { auth: cliAuth },
    );

    const models = requireRecord(next?.agents?.defaults?.models, "models");
    expect(models["anthropic/opus-5.0"]).toEqual({
      alias: "Future Opus",
      agentRuntime: { id: "claude-cli" },
    });
    expect(models["anthropic/claude-opus-5-0"]).toBeUndefined();
  });

  it.each(modelContracts)(
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
      directOnly,
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
      const normalized = normalizeModel(
        makeModel(modelId, {
          reasoning: false,
          cost: !restoresMissingCost
            ? cost
            : restoresMissingCost === "tiers" && cost
              ? {
                  input: cost.input,
                  output: cost.output,
                  cacheRead: cost.cacheRead,
                  cacheWrite: cost.cacheWrite,
                }
              : undefined,
        }),
      );
      expectFields(normalized, {
        reasoning: true,
        ...modernLimits,
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
      if (directOnly) {
        expect(resolveModel(modelId, { provider: "claude-cli" })).toBeUndefined();
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
      const config =
        pricingSource === "configured"
          ? providerConfig([makeModel(modelId, { cost: configuredCost, ...modernLimits })])
          : {};
      const configuredModel = makeModel(modelId, { cost: configuredCost, ...modernLimits });
      const resolvedModel = normalizeModel(configuredModel, config) ?? configuredModel;
      expect(resolvedModel.cost).toEqual(configuredCost);
    },
  );

  it("keeps published Sonnet 5 pricing after the launch window", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-01-01T00:00:00Z"));
    onTestFinished(() => clock.mockRestore());
    const expectedCost = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 };
    const model = makeModel("claude-sonnet-5", {
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

  it("does not forward-compat case-mismatched Anthropic model ids", () => {
    expect(
      resolveModel("CLAUDE-OPUS-4-7", {
        modelRegistry: createModelRegistry([
          makeModel("claude-opus-4-6", { name: "Claude Opus 4.6", maxTokens: 32_000 }),
        ]),
      }),
    ).toBeUndefined();
  });

  it.each([
    [makeModel("claude-mythos-preview"), { thinkingLevelMap: { max: "max" } }],
    [
      makeModel("claude-sonnet-4-6", { maxTokens: 128, maxTokensSource: "configured" }),
      { maxTokens: 128, maxTokensSource: "configured" },
    ],
    [
      makeModel("claude-opus-4-7", { provider: "claude-cli", contextTokens: 200_000 }),
      { contextWindow: 200_000, contextTokens: 200_000, maxTokens: 128_000 },
    ],
    [
      makeModel("claude-opus-4-7[1m]", { provider: "claude-cli", contextTokens: 200_000 }),
      modernLimits,
    ],
  ] as const)("normalizes model-specific limits and thinking for $0.id", (model, fields) => {
    expectFields(normalizeModel(model) ?? model, fields);
  });

  it("does not normalize numeric successors as known Claude contracts", () => {
    expect(normalizeModel(makeModel("claude-opus-4-60", { input: ["text"] }))).toBeUndefined();
  });

  it.each([
    [1_000, { expires: 3_601_000 }],
    [8_640_000_000_000_000, {}],
  ] as const)("stores only Date-safe setup-token expiry at %s", async (now, expiry) => {
    expect(await setupCredential(now)).toEqual({
      type: "token",
      provider: "anthropic",
      token: ANTHROPIC_SETUP_TOKEN,
      ...expiry,
    });
  });
  it.each([
    [{}, undefined],
    [
      { secretInputMode: "ref" },
      "Anthropic setup-token input cannot be stored with --secret-input-mode ref. Use --secret-input-mode plaintext.",
    ], // pragma: allowlist secret
    [{ tokenExpiresIn: "nope" }, "Invalid --token-expires-in"],
    [{ token: "" }, "Anthropic setup-token auth requires --token with a valid setup-token."],
  ] satisfies Array<
    [
      Parameters<NonNullable<(typeof provider.auth)[number]["validateNonInteractive"]>>[0]["opts"],
      string | undefined,
    ]
  >)("preflights setup-token options %j", async (opts, error) => {
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

  it("publishes native Claude auth only with a config capture", async () => {
    probeClaudeCliAuthStatusMock.mockResolvedValue({ status: "available" });
    expect(
      await provider.prepareSyntheticAuth?.({ config: {}, provider: "claude-cli" } as never),
    ).toEqual({
      apiKey: CLAUDE_CLI_NATIVE_AUTH_MARKER,
      source: "Claude CLI native auth",
      mode: "oauth",
      nativeAuth: { runtime: "claude-cli", mode: "oauth" },
    });
    expect(
      await provider.prepareSyntheticAuth?.({ provider: "claude-cli" } as never),
    ).toBeUndefined();
    expect(probeClaudeCliAuthStatusMock).toHaveBeenCalledOnce();
  });
});
