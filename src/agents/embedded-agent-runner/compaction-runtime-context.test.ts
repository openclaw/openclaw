import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import * as manifestModelIdNormalization from "../../plugins/manifest-model-id-normalization.js";
import { addSession, deleteSession } from "../bash-process-registry.js";
import { createProcessSessionFixture } from "../bash-process-registry.test-helpers.js";
import {
  configFor,
  createPlatformAuthRoute,
  modelDefinition,
  providerEntry,
} from "../model-auth.fixtures.test-support.js";
import * as providerModelNormalizationRuntime from "../provider-model-normalization.runtime.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveCompactionContextTokenBudget,
  resolveCompactionHarnessRuntime,
  resolveEmbeddedCompactionThinkingLevel,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import { buildContextEngineCompactionSessionTarget } from "./run/session-bootstrap.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type ContextInput = Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0];
type TargetInput = Parameters<typeof resolveEmbeddedCompactionTarget>[0];
type ThinkingInput = Parameters<typeof resolveEmbeddedCompactionThinkingLevel>[0];
type ModelAliases = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
const openAI = {
  provider: "openai",
  modelId: "gpt-5.5",
  defaultProvider: "openai",
  defaultModel: "gpt-5.5",
};
const modelWithWindow = (contextWindow: number) =>
  ({ contextWindow }) as Parameters<typeof resolveCompactionContextTokenBudget>[0]["model"];
const aliases = { "openai/gpt-5.4-mini": { alias: "gpt54mini" } };

function context(params: Omit<ContextInput, "workspaceDir"> = {}) {
  return buildEmbeddedCompactionRuntimeContext({
    workspaceDir: "/tmp/workspace",
    agentDir: "/tmp/agent",
    ...params,
  });
}
function config(model: string, models?: ModelAliases): OpenClawConfig {
  return { agents: { defaults: { compaction: { model }, models } } };
}
function checkTarget(params: TargetInput, provider: string, model: string, authProfileId?: string) {
  const result = resolveEmbeddedCompactionTarget({ ...openAI, ...params });
  expect({
    provider: result.provider,
    model: result.model,
    authProfileId: result.authProfileId,
  }).toEqual({ provider, model, authProfileId });
  return result;
}
function think(params: Partial<ThinkingInput> = {}) {
  return resolveEmbeddedCompactionThinkingLevel({
    provider: "demo",
    modelId: "demo-model",
    ...params,
  });
}

describe("compaction runtime context", () => {
  it.each([
    [100_000, 500_000, 100_000],
    [500_000, 64_000, 64_000],
  ])("caps requested %i tokens by model window %i", (requested, contextWindow, expected) => {
    expect(
      resolveCompactionContextTokenBudget({
        provider: "openai",
        modelId: "mock-model",
        model: modelWithWindow(contextWindow),
        requestedTokenBudget: requested,
      }),
    ).toBe(expected);
  });

  it.each([
    [16_000, 3_000],
    [2_000, 2_000],
  ])(
    "caps requested %i by the authored native window despite a larger contextTokens cap",
    (requestedTokenBudget, expected) => {
      expect(
        resolveCompactionContextTokenBudget({
          config: configFor("custom", "https://models.example.test/v1", {
            models: [
              modelDefinition("tiny-model", {
                reasoning: false,
                contextWindow: 3_000,
                contextTokens: 16_000,
                maxTokens: 256,
              }),
            ],
          }),
          provider: "custom",
          modelId: "tiny-model",
          model: modelWithWindow(3_000),
          requestedTokenBudget,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    [undefined, "high", "off"],
    ["low", "high", "low"],
    ["inherit", "high", "high"],
    ["inherit", undefined, "off"],
  ] as const)(
    "resolves configured thinking %s with inherited %s",
    (thinkingLevel, inheritedLevel, expected) => {
      expect(
        think({
          config: { agents: { defaults: { compaction: { thinkingLevel } } } },
          inheritedLevel,
          compactionThinkingDefault: "off",
        }),
      ).toBe(expected);
    },
  );

  it.each([undefined, "medium"] as const)(
    "defaults thinking to low, not session %s",
    (inheritedLevel) => {
      expect(think({ inheritedLevel })).toBe("low");
    },
  );

  it("revalidates provider-denied default thinking", () => {
    expect(
      think({
        provider: "custom",
        modelId: "reasoning-model",
        catalog: [
          {
            provider: "custom",
            id: "reasoning-model",
            reasoning: true,
            thinkingLevelMap: { minimal: null, low: null, medium: null },
          },
        ],
      }),
    ).toBe("high");
  });

  it("inherits thinking for reasoning-capable Ollama models", () => {
    expect(
      think({
        config: { agents: { defaults: { compaction: { thinkingLevel: "inherit" } } } },
        provider: "ollama",
        modelId: "qwen3.5:4b",
        inheritedLevel: "high",
        catalog: [{ provider: "ollama", id: "qwen3.5:4b", reasoning: true }],
      }),
    ).toBe("high");
  });

  it("preserves routing, sender authority and delegated tool allowlist", () => {
    const routing = {
      sessionKey: "agent:main:thread:1",
      pinnedWidgetAuthoring: true,
      messageChannel: "slack",
      messageProvider: "slack",
      chatType: "channel",
      agentAccountId: "acct-1",
      conversationRoutePeerId: "peer",
      currentChannelId: "C123",
      currentThreadTs: "thread-9",
      currentMessageId: "msg-42",
      authProfileId: "openai:p1",
      workspaceDir: "/tmp/workspace",
      bootstrapWorkspaceDir: "/tmp/agent-workspace",
      cwd: "/tmp/task-repo",
      requireWorkspaceOnly: true,
      agentDir: "/tmp/agent",
      config: {},
      senderIsOwner: true,
      senderId: "user-123",
      toolsAllow: ["read"],
    } satisfies ContextInput;
    expect(context({ ...routing, provider: "openai", modelId: "gpt-5.4" })).toMatchObject({
      ...routing,
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("normalizes nullable routing fields", () => {
    expect(
      context({
        sessionKey: null,
        messageChannel: null,
        messageProvider: null,
        chatType: null,
        agentAccountId: null,
        currentChannelId: null,
        currentThreadTs: null,
        currentMessageId: null,
        authProfileId: null,
        senderId: null,
        provider: null,
        modelId: null,
      }),
    ).toMatchObject({
      sessionKey: undefined,
      messageChannel: undefined,
      messageProvider: undefined,
      chatType: undefined,
      agentAccountId: undefined,
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      authProfileId: undefined,
      senderId: undefined,
      provider: undefined,
      model: undefined,
    });
  });

  it.each([undefined, { "openai/gpt-5.4-mini": { alias: "fast" } }])(
    "resolves literal overrides without activating unrelated provider plugins (%j)",
    (models) => {
      const forbidden = () => {
        throw new Error("literal overrides must not discover or activate plugins");
      };
      const manifest = vi
        .spyOn(manifestModelIdNormalization, "resolveManifestModelIdNormalizationPolicies")
        .mockImplementation(forbidden);
      const runtime = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation(forbidden);
      try {
        expect(
          context({
            config: config("gpt-4o", models),
            provider: "openai",
            modelId: "gpt-3.5-turbo",
            authProfileId: "openai:p1",
          }),
        ).toMatchObject({ provider: "openai", model: "gpt-4o", authProfileId: "openai:p1" });
      } finally {
        runtime.mockRestore();
        manifest.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "applies cross-provider override without leaking credentials (%s)",
    (override) => {
      expect(
        context({
          config: override ? config("anthropic/claude-opus-4-6") : {},
          provider: "ollama",
          modelId: "minimax-m2.7:cloud",
          authProfileId: "ollama:default",
        }),
      ).toMatchObject(
        override
          ? { provider: "anthropic", model: "claude-opus-4-6", authProfileId: undefined }
          : { provider: "ollama", model: "minimax-m2.7:cloud", authProfileId: "ollama:default" },
      );
    },
  );

  it("includes only processes from the current session scope", () => {
    const scopeKey = "agent:main:compaction-runtime-context";
    const startedAt = Date.now() - 1_000;
    const active = createProcessSessionFixture({
      id: "compaction-runtime-active",
      command: "sleep 600",
      backgrounded: true,
      pid: 1234,
      startedAt,
    });
    const other = createProcessSessionFixture({
      id: "compaction-runtime-other",
      command: "sleep 600",
      backgrounded: true,
    });
    active.scopeKey = scopeKey;
    other.scopeKey = "agent:other";
    addSession(active);
    addSession(other);
    try {
      expect(context({ sessionKey: scopeKey }).activeProcessSessions).toEqual([
        {
          command: "sleep 600",
          cwd: "/tmp",
          name: "sleep 600",
          pid: 1234,
          runtimeMs: expect.any(Number),
          sessionId: active.id,
          startedAt,
          status: "running",
          tail: "",
          truncated: false,
        },
      ]);
      expect(context().activeProcessSessions).toBeUndefined();
    } finally {
      deleteSession(active.id);
      deleteSession(other.id);
    }
  });

  it("uses runtime model default for a provider-only override", () => {
    checkTarget(
      {
        config: config("anthropic/"),
        modelId: "gpt-5.4",
        defaultModel: "gpt-5.4",
        authProfileId: "openai:p1",
      },
      "anthropic",
      "gpt-5.4",
    );
  });

  it("keeps the selected harness and model authoritative for locked sessions", () => {
    const params = {
      ...openAI,
      config: config("anthropic/claude-opus-4-6"),
      authProfileId: "openai:default",
      modelSelectionLocked: true,
    };
    checkTarget(params, "openai", "gpt-5.5", "openai:default");
    expect(context({ ...params, harnessRuntime: "codex" })).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("forwards only target-matching prepared auth plans", () => {
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      modelId: "gpt-5.5",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: "openai:work",
      forwardedAuthProfileSource: "user",
      modelRoute: createPlatformAuthRoute(),
    } as const;
    const matching = context({
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      runtimeAuthPlan,
    });
    expect(matching.runtimeAuthPlan).toBe(runtimeAuthPlan);
    expect(matching.authProfileIdSource).toBe("user");
    expect(
      context({ provider: "openai", modelId: "gpt-5.4", runtimeAuthPlan }).runtimeAuthPlan,
    ).toBeUndefined();
  });

  it("resolves bound, then matching prepared, then configured harness ownership", () => {
    const preparedRuntimePlan = {
      resolvedRef: { provider: "openai", modelId: "gpt-5.5", harnessId: "codex" },
      auth: { providerForAuth: "openai", modelId: "gpt-5.5", authProfileProviderForAuth: "openai" },
    } as never;
    for (const [overrides, expected] of [
      [{ boundHarnessRuntime: "copilot" }, "copilot"],
      [{}, "codex"],
      [{ modelId: "gpt-5.4" }, "custom"],
    ] as const) {
      expect(
        resolveCompactionHarnessRuntime({
          preparedRuntimePlan,
          configuredHarnessRuntime: "custom",
          provider: "openai",
          modelId: "gpt-5.5",
          ...overrides,
        }),
      ).toBe(expected);
    }
  });

  it.each([
    [undefined, false, undefined, undefined, "gpt-5.5"],
    ["openclaw", false, undefined, undefined, "gpt-5.5"],
    ["codex", false, "openai/gpt-5.4-mini", true, "gpt-5.4-mini"],
    ["codex", true, "anthropic/claude-opus-4-6", true, "gpt-5.5"],
  ] as const)(
    "keeps harness %s authoritative (locked=%s)",
    (harnessRuntime, modelSelectionLocked, override, expected, model) => {
      const result = checkTarget(
        {
          config: {
            ...configFor("openai", "https://example.test/v1", {
              api: "openai-responses",
              models: ["gpt-5.5", "gpt-5.4-mini"].map((id) => modelDefinition(id)),
            }),
            ...(override ? config(override) : {}),
          },
          harnessRuntime,
          modelSelectionLocked,
          authProfileId: "openai:default",
        },
        "openai",
        model,
        "openai:default",
      );
      expect(result.nativeHarnessCompaction).toBe(expected);
    },
  );

  it.each([
    ["GPT54MINI@work", aliases, "openai", "gpt-5.4-mini", "openai:default"],
    [
      "thinky",
      { "anthropic/claude-opus-4-6": { alias: "thinky" } },
      "anthropic",
      "claude-opus-4-6",
      undefined,
    ],
    ["nonexistent-alias@work", aliases, "openai", "nonexistent-alias@work", "openai:default"],
    ["gpt54mini", { ...aliases, "openai/gpt54mini": {} }, "openai", "gpt54mini", "openai:default"],
  ] satisfies [string, ModelAliases, string, string, string | undefined][])(
    "resolves alias or literal %s (#90340)",
    (override, models, provider, model, authProfileId) => {
      checkTarget(
        { config: config(override, models), authProfileId: "openai:default" },
        provider,
        model,
        authProfileId,
      );
    },
  );

  it("prefers a current-provider configured literal to a cross-provider alias (#90340)", () => {
    checkTarget(
      {
        config: {
          ...configFor("openai", "", { models: [modelDefinition("gpt-5.4-mini")] }),
          ...config("gpt-5.4-mini", { "anthropic/claude-opus-4-6": { alias: "gpt-5.4-mini" } }),
        },
        authProfileId: "openai:default",
      },
      "openai",
      "gpt-5.4-mini",
      "openai:default",
    );
  });

  it.each([
    ["compact-model", ["anthropic"], "openai", "anthropic", "compact-model"],
    ["shared-model", ["openai", "anthropic"], "google", "google", "shared-model"],
    [
      "openrouter/meta-llama/llama-3.3-70b:free@work",
      [],
      "openrouter",
      "openrouter",
      "meta-llama/llama-3.3-70b:free@work",
    ],
  ] as const)(
    "resolves bare or multi-segment literal %s",
    (override, providers, provider, expectedProvider, expectedModel) => {
      const models = Object.fromEntries(
        providers.map((name) => [name, providerEntry("", { models: [modelDefinition(override)] })]),
      );
      checkTarget(
        {
          config: { ...config(override), models: { providers: models } },
          provider,
          defaultProvider: provider,
          modelId: "current-model",
          defaultModel: "current-model",
          authProfileId: provider + ":default",
        },
        expectedProvider,
        expectedModel,
        provider === expectedProvider ? provider + ":default" : undefined,
      );
    },
  );

  it("leaves an unmapped legacy marker's key absent", async () => {
    const storePath = path.join(tempDirs.make("compaction-marker-"), "sessions.json");
    const sessionId = "legacy-unmapped-session";
    expect(
      await buildContextEngineCompactionSessionTarget({
        sessionFile: formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
        sessionId,
      }),
    ).toEqual({ agentId: "main", sessionId, storePath });
  });
});
