import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { clearCliSessionEntry, updateSessionEntryAfterAgentRun } from "./session-entry-updates.js";
import { resolveSession } from "./session.js";

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, cfg?: OpenClawConfig) =>
    Object.hasOwn(cfg?.agents?.defaults?.cliBackends ?? {}, provider),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

type MockCost = {
  input?: number;
  output?: number;
};

type MockProviderModel = {
  id: string;
  cost?: MockCost;
};

type MockUsageFormatConfig = {
  models?: {
    providers?: Record<string, { models?: MockProviderModel[] }>;
  };
};

const mockSessionRowsByAgentId = vi.hoisted(() => new Map<string, Record<string, SessionEntry>>());
const activeSessionRowsAgent = vi.hoisted(() => ({ current: "" }));
const cloneStore = (store: Record<string, SessionEntry>): Record<string, SessionEntry> =>
  structuredClone(store);

function readMockSessionEntries(agentId: string): Record<string, SessionEntry> {
  return cloneStore(mockSessionRowsByAgentId.get(agentId) ?? {});
}

async function replaceMockSessionEntries(
  agentId: string,
  store: Record<string, SessionEntry>,
): Promise<void> {
  mockSessionRowsByAgentId.set(agentId, cloneStore(store));
}

vi.mock("../../utils/usage-format.js", () => ({
  estimateUsageCost: (params: { usage?: { input?: number; output?: number }; cost?: MockCost }) => {
    if (!params.usage || !params.cost) {
      return undefined;
    }
    const input = params.usage.input ?? 0;
    const output = params.usage.output ?? 0;
    const costInput = params.cost.input ?? 0;
    const costOutput = params.cost.output ?? 0;
    const total = input * costInput + output * costOutput;
    if (!Number.isFinite(total)) {
      return undefined;
    }
    return total / 1e6;
  },
  resolveModelCostConfig: (params: { provider?: string; model?: string; config?: unknown }) => {
    const providers = (params.config as MockUsageFormatConfig | undefined)?.models?.providers;
    if (!providers) {
      return undefined;
    }
    const model = providers[params.provider ?? ""]?.models?.find(
      (entry) => entry.id === params.model,
    );
    if (!model) {
      return undefined;
    }
    return model.cost;
  },
}));

vi.mock("../../config/sessions.js", async () => {
  return {
    mergeSessionEntry: (existing: SessionEntry | undefined, patch: Partial<SessionEntry>) => ({
      ...existing,
      ...patch,
      sessionId: patch.sessionId ?? existing?.sessionId ?? "mock-session",
      updatedAt: Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now()),
    }),
    setSessionRuntimeModel: (entry: SessionEntry, runtime: { provider: string; model: string }) => {
      entry.modelProvider = runtime.provider;
      entry.model = runtime.model;
      return true;
    },
    getSessionEntry: (params: { sessionKey: string }) => {
      return cloneStore(mockSessionRowsByAgentId.get(activeSessionRowsAgent.current) ?? {})[
        params.sessionKey
      ];
    },
    upsertSessionEntry: (params: { sessionKey: string; entry: SessionEntry }) => {
      const store = cloneStore(mockSessionRowsByAgentId.get(activeSessionRowsAgent.current) ?? {});
      store[params.sessionKey] = params.entry;
      if (activeSessionRowsAgent.current) {
        mockSessionRowsByAgentId.set(activeSessionRowsAgent.current, store);
      }
    },
  };
});

vi.mock("../../config/sessions/store.js", () => ({
  listSessionEntries: () =>
    Object.entries(
      cloneStore(mockSessionRowsByAgentId.get(activeSessionRowsAgent.current) ?? {}),
    ).map(([sessionKey, entry]) => ({ sessionKey, entry })),
}));

function acpMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

async function withMockSessionRows<T>(
  run: (params: { agentId: string }) => Promise<T>,
): Promise<T> {
  const agentId = "main";
  const previousAgentId = activeSessionRowsAgent.current;
  try {
    activeSessionRowsAgent.current = agentId;
    mockSessionRowsByAgentId.set(agentId, {});
    return await run({ agentId });
  } finally {
    mockSessionRowsByAgentId.delete(agentId);
    activeSessionRowsAgent.current = previousAgentId;
  }
}

describe("updateSessionEntryAfterAgentRun", () => {
  it("persists the selected embedded harness id on the session", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-harness-pin";
      const sessionId = "test-harness-pin-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.4",
            agentHarnessId: "codex",
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result,
      });

      expect(sessionStore[sessionKey]?.agentHarnessId).toBe("codex");
      expect(readMockSessionEntries(agentId)[sessionKey]?.agentHarnessId).toBe("codex");
    });
  });

  it("uses the runtime context budget from agent metadata instead of cold fallback", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-runtime-context";
      const sessionId = "test-runtime-context-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId,
            provider: "openai-codex",
            model: "gpt-5.5",
            contextTokens: 400_000,
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.5",
        result,
      });

      expect(sessionStore[sessionKey]?.contextTokens).toBe(400_000);
      expect(readMockSessionEntries(agentId)[sessionKey]?.contextTokens).toBe(400_000);
    });
  });

  it("clears the embedded harness pin after a CLI run", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
              },
            },
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-harness-pin-cli";
      const sessionId = "test-harness-pin-cli-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          agentHarnessId: "codex",
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 1,
          executionTrace: { runner: "cli" },
          agentMeta: {
            sessionId: "cli-session-123",
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result,
      });

      expect(sessionStore[sessionKey]?.agentHarnessId).toBeUndefined();
      expect(readMockSessionEntries(agentId)[sessionKey]?.agentHarnessId).toBeUndefined();
    });
  });

  it("persists claude-cli session bindings when the backend is configured", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
              },
            },
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-claude-cli";
      const sessionId = "test-openclaw-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "cli-session-123",
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            cliSessionBinding: {
              sessionId: "cli-session-123",
            },
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        contextTokensOverride: 200_000,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result,
      });

      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "cli-session-123",
      });
      expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");

      const persisted = readMockSessionEntries(agentId);
      expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "cli-session-123",
      });
      expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(persisted[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");
    });
  });

  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const sessionKey = "agent:codex:acp:test-acp-preserve";
      const sessionId = "test-acp-session";

      const existing: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        acp: acpMeta(),
      };
      await replaceMockSessionEntries(agentId, { [sessionKey]: existing });

      const staleInMemory: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        sessionStore: staleInMemory,
        contextTokensOverride: 200_000,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            aborted: false,
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        } as never,
      });

      const persisted = readMockSessionEntries(agentId)[sessionKey];
      expect(persisted?.acp).toBeDefined();
      expect(staleInMemory[sessionKey]?.acp).toBeDefined();
    });
  });

  it("preserves terminal lifecycle state when caller has a stale running snapshot", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-lifecycle-preserve";
      const sessionId = "test-lifecycle-preserve-session";
      const terminalEntry: SessionEntry = {
        sessionId,
        updatedAt: 2_000,
        status: "done",
        startedAt: 1_000,
        endedAt: 1_900,
        runtimeMs: 900,
      };
      await replaceMockSessionEntries(agentId, { [sessionKey]: terminalEntry });

      const staleInMemory: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1_100,
          status: "running",
          startedAt: 1_000,
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore: staleInMemory,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            aborted: false,
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        } as never,
      });

      const persisted = readMockSessionEntries(agentId)[sessionKey];
      expect(persisted).toMatchObject({
        status: "done",
        startedAt: 1_000,
        endedAt: 1_900,
        runtimeMs: 900,
        modelProvider: "openai",
        model: "gpt-5.4",
      });
      expect(staleInMemory[sessionKey]?.status).toBe("done");
    });
  });

  it("persists latest systemPromptReport for downstream warning dedupe", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const sessionKey = "agent:codex:report:test-system-prompt-report";
      const sessionId = "test-system-prompt-report-session";

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const report = {
        source: "run" as const,
        generatedAt: Date.now(),
        bootstrapTruncation: {
          warningMode: "once" as const,
          warningSignaturesSeen: ["sig-a", "sig-b"],
        },
        systemPrompt: {
          chars: 1,
          projectContextChars: 1,
          nonProjectContextChars: 0,
        },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      };

      await updateSessionEntryAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        sessionStore,
        contextTokensOverride: 200_000,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
            },
            systemPromptReport: report,
          },
        } as never,
      });

      const persisted = readMockSessionEntries(agentId)[sessionKey];
      expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
        "sig-a",
        "sig-b",
      ]);
      expect(sessionStore[sessionKey]?.systemPromptReport?.bootstrapTruncation?.warningMode).toBe(
        "once",
      );
    });
  });

  it("stores and reloads the runtime model for explicit session-id-only runs", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {
        session: {
          mainKey: "main",
        },
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      } as never;

      const first = resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(first.sessionKey).toBe("agent:main:explicit:explicit-session-123");

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId: first.sessionId,
        sessionKey: first.sessionKey!,
        sessionStore: first.sessionStore!,
        contextTokensOverride: 200_000,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "claude-cli",
              model: "claude-sonnet-4-6",
              sessionId: "claude-cli-session-1",
              cliSessionBinding: {
                sessionId: "claude-cli-session-1",
                authEpoch: "auth-epoch-1",
              },
            },
          },
        } as never,
      });

      const second = resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(second.sessionKey).toBe(first.sessionKey);
      expect(second.sessionEntry?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-cli-session-1",
        authEpoch: "auth-epoch-1",
      });

      const persisted = readMockSessionEntries(agentId)[first.sessionKey!];
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-cli-session-1",
        authEpoch: "auth-epoch-1",
      });
    });
  });

  it("preserves previous totalTokens when provider returns no usage data (#67667)", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-no-usage";
      const sessionId = "test-session";

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 21225,
          totalTokensFresh: true,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "minimax",
            model: "MiniMax-M2.7",
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(21225);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);

      const persisted = readMockSessionEntries(agentId);
      expect(persisted[sessionKey]?.totalTokens).toBe(21225);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(false);
    });
  });

  it("does not treat CLI cumulative usage as a fresh context snapshot", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-cli-cumulative-usage";
      const sessionId = "test-cli-cumulative-usage-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 95_000,
          totalTokensFresh: true,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      await updateSessionEntryAfterAgentRun({
        cfg,
        contextTokensOverride: 1_000_000,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "claude-cli",
        defaultModel: "claude-opus-4-7",
        result: {
          meta: {
            durationMs: 1,
            executionTrace: { runner: "cli" },
            agentMeta: {
              sessionId,
              provider: "claude-cli",
              model: "claude-opus-4-7",
              usage: {
                input: 3_800_000,
                output: 20_000,
                total: 3_820_000,
              },
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.inputTokens).toBe(3_800_000);
      expect(sessionStore[sessionKey]?.outputTokens).toBe(20_000);
      expect(sessionStore[sessionKey]?.totalTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);
    });
  });

  it("persists compaction tokensAfter when provider usage is unavailable", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-compaction-tokens-after";
      const sessionId = "test-compaction-tokens-after-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "minimax",
            model: "MiniMax-M2.7",
            compactionCount: 1,
            compactionTokensAfter: 21_225,
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(21_225);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(sessionStore[sessionKey]?.compactionCount).toBe(1);

      const persisted = readMockSessionEntries(agentId);
      expect(persisted[sessionKey]?.totalTokens).toBe(21_225);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(true);
    });
  });

  it("ignores non-finite compaction tokensAfter values", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-compaction-tokens-after-invalid";
      const sessionId = "test-compaction-tokens-after-invalid-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 12_000,
          totalTokensFresh: true,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result: {
          meta: {
            durationMs: 500,
            agentMeta: {
              sessionId,
              provider: "minimax",
              model: "MiniMax-M2.7",
              compactionCount: 1,
              compactionTokensAfter: Number.POSITIVE_INFINITY,
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(12_000);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);
    });
  });

  it("snapshots cost instead of accumulating (fixes #69347)", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-4",
                  cost: {
                    input: 10,
                    output: 30,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-cost-snapshot";
      const sessionId = "test-cost-snapshot-session";

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      // Simulate a run with 10k input + 5k output tokens
      // Cost = (10000 * 10 + 5000 * 30) / 1e6 = $0.25
      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-4",
            usage: {
              input: 10000,
              output: 5000,
            },
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
        result,
      });

      // First run: cost should be $0.25
      expect(sessionStore[sessionKey]?.estimatedCostUsd).toBeCloseTo(0.25, 4);

      // Simulate a second persist with the SAME cumulative usage (e.g., from a heartbeat or
      // redundant persist). Before the fix, this would double the cost.
      // After the fix, cost should remain the same because it's snapshotted.
      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
        result, // Same usage again
      });

      // After second persist with same usage, cost should STILL be $0.25 (not $0.50)
      expect(sessionStore[sessionKey]?.estimatedCostUsd).toBeCloseTo(0.25, 4);

      const persisted = readMockSessionEntries(agentId);
      expect(persisted[sessionKey]?.estimatedCostUsd).toBeCloseTo(0.25, 4);
    });
  });

  it("preserves lastInteractionAt for non-interactive system runs", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-system-run";
      const sessionId = "test-system-run-session";
      const lastInteractionAt = Date.now() - 60 * 60_000;
      const sessionStartedAt = Date.now() - 2 * 60 * 60_000;
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now() - 10_000,
          sessionStartedAt,
          lastInteractionAt,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        },
        touchInteraction: false,
      });

      expect(sessionStore[sessionKey]?.lastInteractionAt).toBe(lastInteractionAt);
      expect(sessionStore[sessionKey]?.sessionStartedAt).toBe(sessionStartedAt);
      expect(sessionStore[sessionKey]?.updatedAt).toBeGreaterThan(lastInteractionAt);
    });
  });

  it("advances lastInteractionAt for interactive runs", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-user-run";
      const sessionId = "test-user-run-session";
      const lastInteractionAt = Date.now() - 60 * 60_000;
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now() - 10_000,
          lastInteractionAt,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.lastInteractionAt).toBeGreaterThan(lastInteractionAt);
    });
  });

  it("preserves runtime model and contextTokens when preserveRuntimeModel is true (heartbeat bleed fix)", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-bleed";
      const sessionId = "test-heartbeat-bleed-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          contextTokens: 1_000_000,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      // Heartbeat turn uses a different model
      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        result,
        preserveRuntimeModel: true,
      });

      // Runtime model and contextTokens should be preserved from the original entry
      expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("anthropic");
      expect(sessionStore[sessionKey]?.contextTokens).toBe(1_000_000);

      const persisted = readMockSessionEntries(agentId);
      expect(persisted[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(persisted[sessionKey]?.modelProvider).toBe("anthropic");
      expect(persisted[sessionKey]?.contextTokens).toBe(1_000_000);
    });
  });

  it("leaves contextTokens unset when entry has prior model but no contextTokens (heartbeat bleed guard)", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-no-context-tokens";
      const sessionId = "test-heartbeat-no-context-tokens-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          // contextTokens intentionally missing — older session without cached context
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      // Heartbeat turn uses a different, smaller model
      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        result,
        preserveRuntimeModel: true,
      });

      // Runtime model should be preserved
      expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("anthropic");
      // contextTokens should NOT bleed from the heartbeat run's smaller window
      expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();
    });
  });

  it("does not set runtime model when preserveRuntimeModel is true and entry has no prior runtime model", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-new-session";
      const sessionId = "test-heartbeat-new-session-id";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "ollama",
        defaultModel: "llama3.2:1b",
        result,
        preserveRuntimeModel: true,
      });

      // Heartbeat should NOT establish initial model state on an empty session
      expect(sessionStore[sessionKey]?.model).toBeUndefined();
      expect(sessionStore[sessionKey]?.modelProvider).toBeUndefined();
      expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();
    });
  });

  it("preserves model without borrowing heartbeat provider when entry has model but no modelProvider", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-model-no-provider";
      const sessionId = "test-heartbeat-model-no-provider-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          model: "claude-opus-4-6",
          // modelProvider intentionally missing
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      // Heartbeat turn uses a different provider
      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        result,
        preserveRuntimeModel: true,
      });

      // Model preserved, provider NOT borrowed from heartbeat
      expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(sessionStore[sessionKey]?.modelProvider).toBeUndefined();

      const persisted = readMockSessionEntries(agentId);
      expect(persisted[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(persisted[sessionKey]?.modelProvider).toBeUndefined();
    });
  });

  it("overwrites runtime model when preserveRuntimeModel is false (default behavior)", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-normal-overwrite";
      const sessionId = "test-normal-overwrite-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          contextTokens: 1_000_000,
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.4",
            contextTokens: 400_000,
          },
        },
      };

      await updateSessionEntryAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result,
      });

      // Normal turn: runtime model is updated
      expect(sessionStore[sessionKey]?.model).toBe("gpt-5.4");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("openai");
      expect(sessionStore[sessionKey]?.contextTokens).toBe(400_000);
    });
  });
});

describe("clearCliSessionEntry", () => {
  it("persists cleared Claude CLI bindings through session-store merge", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const sessionKey = "agent:main:explicit:test-clear-claude-cli";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-session-1",
            authEpoch: "epoch-1",
          },
          "codex-cli": {
            sessionId: "codex-session-1",
          },
        },
        cliSessionIds: {
          "claude-cli": "claude-session-1",
          "codex-cli": "codex-session-1",
        },
        claudeCliSessionId: "claude-session-1",
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      await replaceMockSessionEntries(agentId, sessionStore);

      const cleared = await clearCliSessionEntry({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
      });

      expect(cleared?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(cleared?.cliSessionBindings?.["codex-cli"]).toEqual({
        sessionId: "codex-session-1",
      });
      expect(cleared?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(cleared?.cliSessionIds?.["codex-cli"]).toBe("codex-session-1");
      expect(cleared?.claudeCliSessionId).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(cleared);

      const persisted = readMockSessionEntries(agentId)[sessionKey];
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionBindings?.["codex-cli"]).toEqual({
        sessionId: "codex-session-1",
      });
      expect(persisted?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionIds?.["codex-cli"]).toBe("codex-session-1");
      expect(persisted?.claudeCliSessionId).toBeUndefined();
    });
  });

  it("leaves the caller snapshot intact when the session entry is missing", async () => {
    await withMockSessionRows(async ({ agentId }) => {
      const existingKey = "agent:main:explicit:existing";
      const sessionStore: Record<string, SessionEntry> = {
        [existingKey]: {
          sessionId: "openclaw-session-1",
          updatedAt: 1,
          claudeCliSessionId: "claude-session-1",
        },
      };
      await replaceMockSessionEntries(agentId, sessionStore);

      const cleared = await clearCliSessionEntry({
        provider: "claude-cli",
        sessionKey: "agent:main:explicit:missing",
        sessionStore,
      });

      expect(cleared).toBeUndefined();
      expect(sessionStore[existingKey]?.claudeCliSessionId).toBe("claude-session-1");
      expect(readMockSessionEntries(agentId)[existingKey]?.claudeCliSessionId).toBe(
        "claude-session-1",
      );
    });
  });
});
