import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import * as manifestModelIdNormalization from "../../plugins/manifest-model-id-normalization.js";
import { addSession, deleteSession } from "../bash-process-registry.js";
import { createProcessSessionFixture } from "../bash-process-registry.test-helpers.js";
import * as providerModelNormalizationRuntime from "../provider-model-normalization.runtime.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import {
  buildEmbeddedCompactionRuntimeContext,
  resolveCompactionContextTokenBudget,
  resolveCompactionHarnessRuntime,
  resolveEmbeddedCompactionThinkingLevel,
  resolveEmbeddedCompactionTarget,
} from "./compaction-runtime-context.js";
import { buildContextEngineCompactionSessionTarget } from "./run/session-bootstrap.js";

const compactionTempDirs = useAutoCleanupTempDirTracker(afterEach);

const workspace = { workspaceDir: "/tmp/workspace", agentDir: "/tmp/agent" };
const openAiTarget = {
  provider: "openai",
  modelId: "gpt-5.5",
  defaultProvider: "openai",
  defaultModel: "gpt-5.5",
};
type ModelAliases = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
function compactionConfig(model: string, models?: ModelAliases): OpenClawConfig {
  return { agents: { defaults: { compaction: { model }, ...(models ? { models } : {}) } } };
}
type RuntimeParams = Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0];
const runtimeContext = (params: Omit<RuntimeParams, "workspaceDir"> = {}) =>
  buildEmbeddedCompactionRuntimeContext({ ...workspace, ...params });
const thinkingLevel = (
  params: Partial<Parameters<typeof resolveEmbeddedCompactionThinkingLevel>[0]> = {},
) => resolveEmbeddedCompactionThinkingLevel({ provider: "demo", modelId: "demo-model", ...params });
function expectTarget(
  result: ReturnType<typeof resolveEmbeddedCompactionTarget>,
  provider: string,
  model: string,
  authProfileId?: string,
) {
  expect(result).toMatchObject({ provider, model, authProfileId });
}
function configuredOpenAI(
  models: string[],
  options: { api?: "openai-responses"; baseUrl?: string } = {},
) {
  return {
    models: { providers: { openai: { ...options, models: models.map((id) => ({ id })) } } },
  };
}
function literalConfig(model: string, providers: string[]) {
  return {
    ...compactionConfig(model),
    models: {
      providers: Object.fromEntries(
        providers.map((provider) => [provider, { models: [{ id: model }] }] as const),
      ),
    },
  };
}

describe("resolveCompactionContextTokenBudget", () => {
  const model = makeProviderModelFixture({
    id: "tiny-model",
    provider: "custom",
    api: "openai-completions",
    baseUrl: "https://models.example.test/v1",
  });
  const nativeWindowConfig: OpenClawConfig = {
    models: {
      providers: {
        custom: {
          baseUrl: model.baseUrl,
          models: [{ ...model, contextWindow: 3_000, contextTokens: 16_000 }],
        },
      },
    },
  };
  it.each([
    { requested: 100_000, modelWindow: 500_000, expected: 100_000 },
    { requested: 500_000, modelWindow: 64_000, expected: 64_000 },
    {
      requested: 16_000,
      modelWindow: 3_000,
      expected: 3_000,
      config: nativeWindowConfig,
    },
    {
      requested: 2_000,
      modelWindow: 3_000,
      expected: 2_000,
      config: nativeWindowConfig,
    },
  ])(
    "caps requested=$requested by modelWindow=$modelWindow, including configured contextTokens",
    ({ requested, modelWindow, expected, config }) => {
      const budget = resolveCompactionContextTokenBudget({
        config,
        provider: config ? "custom" : "openai",
        modelId: model.id,
        model: { ...model, contextWindow: modelWindow },
        requestedTokenBudget: requested,
      });
      expect(budget).toBe(expected);
    },
  );
});

describe("resolveEmbeddedCompactionThinkingLevel", () => {
  it.each([
    { configured: undefined, inherited: "high", expected: "off" },
    { configured: "low", inherited: "high", expected: "low" },
    { configured: "inherit", inherited: "high", expected: "high" },
    { configured: "inherit", inherited: undefined, expected: "off" },
  ] as const)(
    "uses the prepared default only when compaction thinking is unset ($configured)",
    ({ configured, inherited, expected }) => {
      expect(
        thinkingLevel({
          config: configured
            ? { agents: { defaults: { compaction: { thinkingLevel: configured } } } }
            : {},
          inheritedLevel: inherited,
          compactionThinkingDefault: "off",
        }),
      ).toBe(expected);
    },
  );

  it.each([
    {
      name: "revalidates the default against provider-denied thinking levels",
      provider: "custom",
      modelId: "reasoning-model",
      thinkingLevelMap: { minimal: null, low: null, medium: null },
      config: undefined,
    },
    {
      name: "preserves inherited thinking when the resolved Ollama model supports it",
      provider: "ollama",
      modelId: "qwen3.5:4b",
      thinkingLevelMap: undefined,
      config: { agents: { defaults: { compaction: { thinkingLevel: "inherit" } } } } as const,
    },
  ])("$name", ({ provider, modelId, thinkingLevelMap, config }) => {
    expect(
      thinkingLevel({
        provider,
        modelId,
        config,
        inheritedLevel: config ? "high" : undefined,
        catalog: [{ provider, id: modelId, reasoning: true, thinkingLevelMap }],
      }),
    ).toBe("high");
  });

  it("defaults compaction to low without inheriting the session level", () => {
    expect(thinkingLevel({ inheritedLevel: "medium" })).toBe("low");
  });
});

describe("buildEmbeddedCompactionRuntimeContext", () => {
  it("preserves sender and current message routing for compaction", () => {
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
      config: {} as unknown as OpenClawConfig,
      senderIsOwner: true,
      senderId: "user-123",
      toolsAllow: ["read"],
    } satisfies Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0];
    const result = buildEmbeddedCompactionRuntimeContext({
      ...routing,
      provider: "openai",
      modelId: "gpt-5.4",
      thinkLevel: "off",
      reasoningLevel: "on",
      extraSystemPrompt: "extra",
      ownerNumbers: ["+15555550123"],
    });
    expect(result).toMatchObject({ ...routing, provider: "openai", model: "gpt-5.4" });
    expect(result.toolsAllow).toEqual(["read"]);
  });

  it("normalizes nullable compaction routing fields to undefined", () => {
    const nullable = {
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
    };
    const result = runtimeContext({ ...nullable, modelId: null });
    expect(result).toMatchObject({
      ...Object.fromEntries(Object.keys(nullable).map((key) => [key, undefined])),
      model: undefined,
      activeProcessSessions: undefined,
    });
  });

  it("applies compaction.model override with provider/model format", () => {
    const result = runtimeContext({
      config: compactionConfig("anthropic/claude-opus-4-6"),
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    // Auth profile must be dropped when provider changes; otherwise compaction
    // could send a stale credential to the override provider.
    expectTarget(result, "anthropic", "claude-opus-4-6");
  });
  it.each([
    { name: "without configured aliases", models: undefined },
    {
      name: "with an unrelated configured alias",
      models: { "openai/gpt-5.4-mini": { alias: "fast" } },
    },
  ])(
    "resolves literal compaction overrides without discovering provider plugins $name",
    ({ models }) => {
      const manifestNormalization = vi
        .spyOn(manifestModelIdNormalization, "resolveManifestModelIdNormalizationPolicies")
        .mockImplementation(() => {
          throw new Error("literal compaction overrides must not discover plugin manifests");
        });
      const runtimeNormalization = vi
        .spyOn(providerModelNormalizationRuntime, "normalizeProviderModelIdWithRuntime")
        .mockImplementation(() => {
          throw new Error("literal compaction overrides must not activate provider plugins");
        });

      try {
        const result = runtimeContext({
          config: compactionConfig("gpt-4o", models),
          provider: "openai",
          modelId: "gpt-3.5-turbo",
          authProfileId: "openai:p1",
        });

        expectTarget(result, "openai", "gpt-4o", "openai:p1");
        expect(manifestNormalization).not.toHaveBeenCalled();
        expect(runtimeNormalization).not.toHaveBeenCalled();
      } finally {
        runtimeNormalization.mockRestore();
        manifestNormalization.mockRestore();
      }
    },
  );

  it("uses session model when no compaction.model override configured", () => {
    const result = runtimeContext({
      config: {} as unknown as OpenClawConfig,
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    expectTarget(result, "ollama", "minimax-m2.7:cloud", "ollama:default");
  });

  it("preserves scoped active process session references for compaction", () => {
    // Only sessions tied to the same scope are summarized; cross-session process
    // state would leak unrelated task context into the compaction prompt.
    const scopeKey = "agent:main:compaction-runtime-context";
    const startedAt = Date.now() - 1_000;
    const active = createProcessSessionFixture({
      id: "compaction-runtime-active",
      command: "sleep 600",
      backgrounded: true,
      pid: 1234,
      startedAt,
    });
    active.scopeKey = scopeKey;
    const other = createProcessSessionFixture({
      id: "compaction-runtime-other",
      command: "sleep 600",
      backgrounded: true,
    });
    other.scopeKey = "agent:other";
    addSession(active);
    addSession(other);

    try {
      const result = runtimeContext({
        sessionKey: scopeKey,
        config: {} as unknown as OpenClawConfig,
      });

      expect(result.activeProcessSessions).toEqual([
        {
          command: "sleep 600",
          cwd: "/tmp",
          name: "sleep 600",
          pid: 1234,
          runtimeMs: expect.any(Number),
          sessionId: "compaction-runtime-active",
          startedAt,
          status: "running",
          tail: "",
          truncated: false,
        },
      ]);
    } finally {
      deleteSession(active.id);
      deleteSession(other.id);
    }
  });

  it.each([
    {
      name: "applies runtime defaults when resolving the effective compaction target",
      params: { config: compactionConfig("anthropic/"), defaultModel: "gpt-5.4" },
      expected: { provider: "anthropic", model: "gpt-5.4", authProfileId: undefined },
    },
    {
      name: "ignores compaction model overrides for model-locked sessions",
      params: {
        config: compactionConfig("anthropic/claude-opus-4-6"),
        modelSelectionLocked: true,
      },
      expected: { provider: "openai", model: "gpt-5.5", authProfileId: "openai:default" },
    },
    {
      name: "keeps a locked Codex harness authoritative over a custom OpenAI base URL",
      params: {
        config: configuredOpenAI(["gpt-5.5"], { baseUrl: "https://example.test/v1" }),
        harnessRuntime: "codex",
        modelSelectionLocked: true,
      },
      expected: { provider: "openai", model: "gpt-5.5", nativeHarnessCompaction: true },
    },
    {
      name: "keeps OpenAI compaction model overrides on canonical OpenAI with Codex runtime",
      params: {
        config: {
          ...configuredOpenAI(["gpt-5.5", "gpt-5.4-mini"]),
          ...compactionConfig("openai/gpt-5.4-mini"),
        },
        harnessRuntime: "codex",
      },
      expected: { provider: "openai", model: "gpt-5.4-mini", nativeHarnessCompaction: true },
    },
  ])("$name", ({ params, expected }) => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      authProfileId: "openai:default",
      ...params,
      config: params.config as OpenClawConfig,
    });
    expect(result).toEqual({ authProfileId: "openai:default", ...expected });
  });

  it("carries the selected harness id for delegated runtime compaction", () => {
    const result = runtimeContext({
      config: compactionConfig("anthropic/claude-opus-4-6"),
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: "codex",
      modelSelectionLocked: true,
    });
    expect(result).toMatchObject({
      agentHarnessId: "codex",
      modelSelectionLocked: true,
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("carries only a target-matching prepared auth plan into compaction context", () => {
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      modelId: "gpt-5.5",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: "openai:work",
      forwardedAuthProfileSource: "user",
    } as const;

    const matching = runtimeContext({
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      runtimeAuthPlan,
    });
    const mismatched = runtimeContext({
      provider: "openai",
      modelId: "gpt-5.4",
      runtimeAuthPlan,
    });

    expect(matching.runtimeAuthPlan).toBe(runtimeAuthPlan);
    expect(matching.authProfileIdSource).toBe("user");
    expect(mismatched.runtimeAuthPlan).toBeUndefined();
  });

  it("resolves compaction harness ownership from bound, prepared, then configured facts", () => {
    const preparedRuntimePlan = {
      resolvedRef: {
        provider: "openai",
        modelId: "gpt-5.5",
        harnessId: "codex",
      },
      auth: {
        providerForAuth: "openai",
        modelId: "gpt-5.5",
        authProfileProviderForAuth: "openai",
      },
    } as never;

    const params = {
      preparedRuntimePlan,
      configuredHarnessRuntime: "custom",
      provider: "openai",
      modelId: "gpt-5.5",
    };
    expect(resolveCompactionHarnessRuntime({ ...params, boundHarnessRuntime: "copilot" })).toBe(
      "copilot",
    );
    expect(resolveCompactionHarnessRuntime(params)).toBe("codex");
    expect(resolveCompactionHarnessRuntime({ ...params, modelId: "gpt-5.4" })).toBe("custom");
  });

  it.each([
    { selection: "implicit OpenClaw", harnessRuntime: undefined, nativeCompaction: undefined },
    { selection: "bound OpenClaw", harnessRuntime: "openclaw", nativeCompaction: undefined },
    { selection: "bound Codex", harnessRuntime: "codex", nativeCompaction: true },
  ])("keeps $selection ownership for custom OpenAI Responses compaction", (fixture) => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      config: configuredOpenAI(["gpt-5.5"], {
        api: "openai-responses",
        baseUrl: "https://example.test/v1",
      }) as unknown as OpenClawConfig,
      harnessRuntime: fixture.harnessRuntime,
    });
    expect(result.nativeHarnessCompaction).toBe(fixture.nativeCompaction);
    expectTarget(result, "openai", "gpt-5.5");
  });

  it.each<{
    name: string;
    config: ReturnType<typeof compactionConfig> | ReturnType<typeof literalConfig>;
    provider?: string;
    expected: [provider: string, model: string, authProfileId?: string];
  }>([
    {
      name: "resolves a mixed-case alias and trailing profile",
      config: compactionConfig("GPT54MINI@work", {
        "openai/gpt-5.4-mini": { alias: "gpt54mini", params: { thinking: "high" } },
      }),
      expected: ["openai", "gpt-5.4-mini", "openai:default"],
    },
    {
      name: "resolves a cross-provider alias without reusing credentials",
      config: compactionConfig("thinky", { "anthropic/claude-opus-4-6": { alias: "thinky" } }),
      expected: ["anthropic", "claude-opus-4-6"],
    },
    {
      name: "preserves the full literal model and profile when no alias matches",
      config: compactionConfig("nonexistent-alias@work", {
        "openai/gpt-5.4-mini": { alias: "gpt54mini" },
      }),
      expected: ["openai", "nonexistent-alias@work", "openai:default"],
    },
    {
      name: "prefers configured literal model ids over alias collisions (#90340)",
      config: compactionConfig("gpt54mini", {
        "openai/gpt-5.4-mini": { alias: "gpt54mini" },
        "openai/gpt54mini": {},
      }),
      expected: ["openai", "gpt54mini", "openai:default"],
    },
    {
      name: "keeps current-provider configured model ids over cross-provider alias collisions (#90340)",
      config: {
        ...compactionConfig("gpt-5.4-mini", {
          "anthropic/claude-opus-4-6": { alias: "gpt-5.4-mini" },
        }),
        ...configuredOpenAI(["gpt-5.4-mini"]),
      },
      expected: ["openai", "gpt-5.4-mini", "openai:default"],
    },
    {
      name: "infers a different provider for a uniquely configured bare literal",
      config: literalConfig("compact-model", ["anthropic"]),
      provider: "openai",
      expected: ["anthropic", "compact-model"],
    },
    {
      name: "keeps an ambiguous configured bare literal on the current provider",
      config: literalConfig("shared-model", ["openai", "anthropic"]),
      provider: "google",
      expected: ["google", "shared-model", "google:default"],
    },
    {
      name: "preserves a multi-segment model id and trailing profile suffix",
      config: compactionConfig("openrouter/meta-llama/llama-3.3-70b:free@work"),
      provider: "openrouter",
      expected: ["openrouter", "meta-llama/llama-3.3-70b:free@work", "openrouter:default"],
    },
  ])("$name", ({ config, provider = "openai", expected }) => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      config: config as OpenClawConfig,
      provider,
      authProfileId: `${provider}:default`,
    });
    expectTarget(result, ...expected);
  });
});

describe("buildContextEngineCompactionSessionTarget", async () => {
  it("leaves the key absent when a marker store has no mapped row", async () => {
    const storePath = path.join(compactionTempDirs.make("compaction-marker-"), "sessions.json");
    const sessionId = "legacy-unmapped-session";

    expect(
      await buildContextEngineCompactionSessionTarget({
        sessionFile: formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
        sessionId,
      }),
    ).toEqual({ agentId: "main", sessionId, storePath });
  });
});
