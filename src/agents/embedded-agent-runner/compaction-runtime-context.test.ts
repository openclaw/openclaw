// Coverage for building compaction runtime context from active runner state.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import * as manifestModelIdNormalization from "../../plugins/manifest-model-id-normalization.js";
import { addSession, deleteSession } from "../bash-process-registry.js";
import { createProcessSessionFixture } from "../bash-process-registry.test-helpers.js";
import * as providerModelNormalizationRuntime from "../provider-model-normalization.runtime.js";
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

describe("resolveCompactionContextTokenBudget", () => {
  const cfg = {} as OpenClawConfig;
  const modelWithWindow = (contextWindow: number) =>
    ({ contextWindow }) as Parameters<typeof resolveCompactionContextTokenBudget>[0]["model"];
  it.each([
    { requested: 100_000, modelWindow: 500_000, expected: 100_000 },
    { requested: 500_000, modelWindow: 64_000, expected: 64_000 },
  ])(
    "caps requested=$requested by the model ceiling to $expected",
    ({ requested, modelWindow, expected }) => {
      const budget = resolveCompactionContextTokenBudget({
        config: cfg,
        provider: "openai",
        modelId: "mock-model",
        model: modelWithWindow(modelWindow),
        requestedTokenBudget: requested,
      });
      expect(budget).toBe(expected);
    },
  );

  it.each([
    { requested: 16_000, expected: 3_000 },
    { requested: 2_000, expected: 2_000 },
  ])(
    "caps requested=$requested by the authored native window despite a larger contextTokens cap",
    ({ requested, expected }) => {
      const budget = resolveCompactionContextTokenBudget({
        config: {
          models: {
            providers: {
              custom: {
                baseUrl: "https://models.example.test/v1",
                models: [
                  {
                    id: "tiny-model",
                    name: "Tiny model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 3_000,
                    contextTokens: 16_000,
                    maxTokens: 256,
                  },
                ],
              },
            },
          },
        },
        provider: "custom",
        modelId: "tiny-model",
        model: modelWithWindow(3_000),
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
        resolveEmbeddedCompactionThinkingLevel({
          config: configured
            ? { agents: { defaults: { compaction: { thinkingLevel: configured } } } }
            : {},
          provider: "demo",
          modelId: "demo-model",
          inheritedLevel: inherited,
          compactionThinkingDefault: "off",
        }),
      ).toBe(expected);
    },
  );

  it("revalidates an unsupported configured level for the actual candidate", () => {
    expect(
      resolveEmbeddedCompactionThinkingLevel({
        config: {
          agents: { defaults: { compaction: { thinkingLevel: "xhigh" } } },
        },
        provider: "demo",
        modelId: "demo-model",
      }),
    ).toBe("high");
  });

  it("revalidates the compaction default against provider-denied thinking levels", () => {
    expect(
      resolveEmbeddedCompactionThinkingLevel({
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

  it("defaults compaction to low without inheriting the session level", () => {
    expect(
      resolveEmbeddedCompactionThinkingLevel({
        provider: "demo",
        modelId: "demo-model",
        inheritedLevel: "medium",
      }),
    ).toBe("low");
    expect(
      resolveEmbeddedCompactionThinkingLevel({
        provider: "demo",
        modelId: "demo-model",
      }),
    ).toBe("low");
  });

  it("preserves thinking when the resolved Ollama model reports reasoning support", () => {
    expect(
      resolveEmbeddedCompactionThinkingLevel({
        config: {
          agents: { defaults: { compaction: { thinkingLevel: "inherit" } } },
        },
        provider: "ollama",
        modelId: "qwen3.5:4b",
        inheritedLevel: "high",
        catalog: [{ provider: "ollama", id: "qwen3.5:4b", reasoning: true }],
      }),
    ).toBe("high");
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
      cwd: "/tmp/task-repo",
      requireWorkspaceOnly: true,
      requireWritableSandbox: true,
      agentDir: "/tmp/agent",
      config: {} as unknown as OpenClawConfig,
      senderIsOwner: true,
      senderId: "user-123",
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
    expect(result).toMatchObject(routing);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4");
  });

  it("preserves the finite tool allowlist for delegated compaction", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      ...workspace,
      provider: "openai",
      modelId: "gpt-5.4",
      toolsAllow: ["read"],
    });

    expect(result.toolsAllow).toEqual(["read"]);
  });

  it("normalizes nullable compaction routing fields to undefined", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      sessionKey: null,
      messageChannel: null,
      messageProvider: null,
      chatType: null,
      agentAccountId: null,
      currentChannelId: null,
      currentThreadTs: null,
      currentMessageId: null,
      authProfileId: null,
      ...workspace,
      senderId: null,
      provider: null,
      modelId: null,
    });
    expect(result.sessionKey).toBeUndefined();
    expect(result.messageChannel).toBeUndefined();
    expect(result.messageProvider).toBeUndefined();
    expect(result.chatType).toBeUndefined();
    expect(result.agentAccountId).toBeUndefined();
    expect(result.currentChannelId).toBeUndefined();
    expect(result.currentThreadTs).toBeUndefined();
    expect(result.currentMessageId).toBeUndefined();
    expect(result.authProfileId).toBeUndefined();
    expect(result.senderId).toBeUndefined();
    expect(result.provider).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it("applies compaction.model override with provider/model format", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      ...workspace,
      config: compactionConfig("anthropic/claude-opus-4-6"),
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-opus-4-6");
    // Auth profile must be dropped when provider changes; otherwise compaction
    // could send a stale credential to the override provider.
    expect(result.authProfileId).toBeUndefined();
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
        const result = buildEmbeddedCompactionRuntimeContext({
          ...workspace,
          config: {
            agents: {
              defaults: {
                ...(models ? { models } : {}),
                compaction: { model: "gpt-4o" },
              },
            },
          } as OpenClawConfig,
          provider: "openai",
          modelId: "gpt-3.5-turbo",
          authProfileId: "openai:p1",
        });

        expect(result.provider).toBe("openai");
        expect(result.model).toBe("gpt-4o");
        expect(result.authProfileId).toBe("openai:p1");
        expect(manifestNormalization).not.toHaveBeenCalled();
        expect(runtimeNormalization).not.toHaveBeenCalled();
      } finally {
        runtimeNormalization.mockRestore();
        manifestNormalization.mockRestore();
      }
    },
  );

  it("uses session model when no compaction.model override configured", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      ...workspace,
      config: {} as unknown as OpenClawConfig,
      provider: "ollama",
      modelId: "minimax-m2.7:cloud",
      authProfileId: "ollama:default",
    });
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("minimax-m2.7:cloud");
    expect(result.authProfileId).toBe("ollama:default");
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
      const result = buildEmbeddedCompactionRuntimeContext({
        sessionKey: scopeKey,
        ...workspace,
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

  it("omits active process session references when no safe scope is available", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      ...workspace,
      config: {} as unknown as OpenClawConfig,
    });

    expect(result.activeProcessSessions).toBeUndefined();
  });

  it("applies runtime defaults when resolving the effective compaction target", () => {
    expect(
      resolveEmbeddedCompactionTarget({
        config: compactionConfig("anthropic/"),
        provider: "openai",
        modelId: "gpt-5.4",
        authProfileId: "openai:p1",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "gpt-5.4",
      authProfileId: undefined,
    });
  });

  it("ignores compaction model overrides for model-locked sessions", () => {
    expect(
      resolveEmbeddedCompactionTarget({
        config: compactionConfig("anthropic/claude-opus-4-6"),
        provider: "openai",
        modelId: "gpt-5.5",
        authProfileId: "openai:default",
        modelSelectionLocked: true,
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:default",
    });
  });

  it("keeps configured OpenAI provider with legacy Codex auth profiles (#86373)", () => {
    const result = resolveEmbeddedCompactionTarget({
      provider: "openai",
      modelId: "gpt-5.4",
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.4",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.model).toBe("gpt-5.4");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("carries the selected harness id for delegated runtime compaction", () => {
    const result = buildEmbeddedCompactionRuntimeContext({
      ...workspace,
      config: compactionConfig("anthropic/claude-opus-4-6"),
      provider: "openai",
      modelId: "gpt-5.5",
      harnessRuntime: "codex",
      modelSelectionLocked: true,
    });
    expect(result.agentHarnessId).toBe("codex");
    expect(result.modelSelectionLocked).toBe(true);
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.5");
    expect(result.runtimeProvider).toBeUndefined();
  });

  it("carries only a target-matching prepared auth plan into compaction context", () => {
    const runtimeAuthPlan = {
      providerForAuth: "openai",
      modelId: "gpt-5.5",
      authProfileProviderForAuth: "openai",
      forwardedAuthProfileId: "openai:work",
      forwardedAuthProfileSource: "user",
      modelRoute: {
        provider: "openai",
        modelId: "gpt-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    } as const;

    const matching = buildEmbeddedCompactionRuntimeContext({
      ...workspace,
      provider: "openai",
      modelId: "gpt-5.5",
      authProfileId: "openai:work",
      authProfileIdSource: "user",
      runtimeAuthPlan,
    });
    const mismatched = buildEmbeddedCompactionRuntimeContext({
      ...workspace,
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

    expect(
      resolveCompactionHarnessRuntime({
        boundHarnessRuntime: "copilot",
        preparedRuntimePlan,
        configuredHarnessRuntime: "custom",
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toBe("copilot");
    expect(
      resolveCompactionHarnessRuntime({
        preparedRuntimePlan,
        configuredHarnessRuntime: "custom",
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    ).toBe("codex");
    expect(
      resolveCompactionHarnessRuntime({
        preparedRuntimePlan,
        configuredHarnessRuntime: "custom",
        provider: "openai",
        modelId: "gpt-5.4",
      }),
    ).toBe("custom");
  });

  it.each([
    { selection: "implicit OpenClaw", harnessRuntime: undefined, nativeCompaction: undefined },
    { selection: "bound OpenClaw", harnessRuntime: "openclaw", nativeCompaction: undefined },
    { selection: "bound Codex", harnessRuntime: "codex", nativeCompaction: true },
  ])("keeps $selection ownership for custom OpenAI Responses compaction", (fixture) => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      config: {
        models: {
          providers: {
            openai: {
              api: "openai-responses",
              baseUrl: "https://example.test/v1",
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      harnessRuntime: fixture.harnessRuntime,
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.nativeHarnessCompaction).toBe(fixture.nativeCompaction);
    expect(result.model).toBe("gpt-5.5");
    expect(result.authProfileId).toBeUndefined();
  });

  it("keeps a locked Codex harness authoritative over a custom OpenAI base URL", () => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      config: {
        models: {
          providers: {
            openai: {
              baseUrl: "https://example.test/v1",
              models: [{ id: "gpt-5.5" }],
            },
          },
        },
      } as unknown as OpenClawConfig,
      harnessRuntime: "codex",
      modelSelectionLocked: true,
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.nativeHarnessCompaction).toBe(true);
    expect(result.model).toBe("gpt-5.5");
  });

  it("keeps OpenAI compaction model overrides on canonical OpenAI with Codex runtime", () => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.5" }, { id: "gpt-5.4-mini" }] },
          },
        },
        agents: { defaults: { compaction: { model: "openai/gpt-5.4-mini" } } },
      } as unknown as OpenClawConfig,
      harnessRuntime: "codex",
    });
    expect(result.provider).toBe("openai");
    expect(result.runtimeProvider).toBeUndefined();
    expect(result.contextProvider).toBeUndefined();
    expect(result.nativeHarnessCompaction).toBe(true);
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBeUndefined();
  });

  it.each<{
    name: string;
    override: string;
    models: ModelAliases;
    provider: string;
    model: string;
    authProfileId: string | undefined;
  }>([
    {
      name: "resolves a mixed-case alias and trailing profile",
      override: "GPT54MINI@work",
      models: { "openai/gpt-5.4-mini": { alias: "gpt54mini", params: { thinking: "high" } } },
      provider: "openai",
      model: "gpt-5.4-mini",
      authProfileId: "openai:default",
    },
    {
      name: "resolves a cross-provider alias without reusing credentials",
      override: "thinky",
      models: { "anthropic/claude-opus-4-6": { alias: "thinky" } },
      provider: "anthropic",
      model: "claude-opus-4-6",
      authProfileId: undefined,
    },
    {
      name: "preserves the full literal model and profile when no alias matches",
      override: "nonexistent-alias@work",
      models: { "openai/gpt-5.4-mini": { alias: "gpt54mini" } },
      provider: "openai",
      model: "nonexistent-alias@work",
      authProfileId: "openai:default",
    },
    {
      name: "prefers configured literal model ids over alias collisions (#90340)",
      override: "gpt54mini",
      models: { "openai/gpt-5.4-mini": { alias: "gpt54mini" }, "openai/gpt54mini": {} },
      provider: "openai",
      model: "gpt54mini",
      authProfileId: "openai:default",
    },
  ])("$name", ({ override, models, provider, model, authProfileId }) => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      config: compactionConfig(override, models),
      authProfileId: "openai:default",
    });
    expect(result.provider).toBe(provider);
    expect(result.model).toBe(model);
    expect(result.authProfileId).toBe(authProfileId);
  });

  it("preserves auth when an omitted provider uses the effective default", () => {
    const result = resolveEmbeddedCompactionTarget({
      config: compactionConfig("summary", { "openai/gpt-5.4-mini": { alias: "summary" } }),
      authProfileId: "openai:default",
      defaultProvider: "openai",
      defaultModel: "gpt-5.5",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBe("openai:default");
  });

  it("keeps current-provider configured model ids over cross-provider alias collisions (#90340)", () => {
    const result = resolveEmbeddedCompactionTarget({
      ...openAiTarget,
      config: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                alias: "gpt-5.4-mini",
              },
            },
            compaction: { model: "gpt-5.4-mini" },
          },
        },
        models: {
          providers: {
            openai: { models: [{ id: "gpt-5.4-mini" }] },
          },
        },
      } as unknown as OpenClawConfig,
      authProfileId: "openai:default",
    });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-5.4-mini");
    expect(result.authProfileId).toBe("openai:default");
  });

  it.each([
    {
      name: "infers a different provider for a uniquely configured bare literal",
      config: {
        models: {
          providers: {
            anthropic: { models: [{ id: "compact-model" }] },
          },
        },
        agents: { defaults: { compaction: { model: "compact-model" } } },
      },
      provider: "openai",
      authProfileId: "openai:default",
      expectedProvider: "anthropic",
      expectedModel: "compact-model",
      expectedAuthProfileId: undefined,
    },
    {
      name: "keeps an ambiguous configured bare literal on the current provider",
      config: {
        models: {
          providers: {
            openai: { models: [{ id: "shared-model" }] },
            anthropic: { models: [{ id: "shared-model" }] },
          },
        },
        agents: { defaults: { compaction: { model: "shared-model" } } },
      },
      provider: "google",
      authProfileId: "google:default",
      expectedProvider: "google",
      expectedModel: "shared-model",
      expectedAuthProfileId: "google:default",
    },
    {
      name: "preserves a multi-segment model id and trailing profile suffix",
      config: {
        agents: {
          defaults: {
            compaction: { model: "openrouter/meta-llama/llama-3.3-70b:free@work" },
          },
        },
      },
      provider: "openrouter",
      authProfileId: "openrouter:default",
      expectedProvider: "openrouter",
      expectedModel: "meta-llama/llama-3.3-70b:free@work",
      expectedAuthProfileId: "openrouter:default",
    },
  ])("$name", (fixture) => {
    const result = resolveEmbeddedCompactionTarget({
      config: fixture.config as unknown as OpenClawConfig,
      provider: fixture.provider,
      modelId: "current-model",
      authProfileId: fixture.authProfileId,
      defaultProvider: fixture.provider,
      defaultModel: "current-model",
    });

    expect(result.provider).toBe(fixture.expectedProvider);
    expect(result.model).toBe(fixture.expectedModel);
    expect(result.authProfileId).toBe(fixture.expectedAuthProfileId);
  });
});

describe("buildContextEngineCompactionSessionTarget", () => {
  it("derives the agent from a scoped session key", () => {
    expect(
      buildContextEngineCompactionSessionTarget({
        config: { session: { store: "/tmp/agents/{agentId}/sessions.json" } },
        sessionFile: "agent:helper:main",
        sessionId: "helper-session",
        sessionKey: "agent:helper:main",
      }),
    ).toMatchObject({
      agentId: "helper",
      sessionKey: "agent:helper:main",
      storePath: "/tmp/agents/helper/sessions.json",
    });
  });

  it("leaves the key absent when a marker store has no mapped row", () => {
    const storePath = path.join(compactionTempDirs.make("compaction-marker-"), "sessions.json");
    const sessionId = "legacy-unmapped-session";

    expect(
      buildContextEngineCompactionSessionTarget({
        sessionFile: formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
        sessionId,
      }),
    ).toEqual({ agentId: "main", sessionId, storePath });
  });
});
