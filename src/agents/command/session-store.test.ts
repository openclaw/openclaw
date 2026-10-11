import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveFreshSessionTotalTokens,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { recordCliCompactionInStore } from "./session-store.js";
import {
  createRunResult,
  loadPersistedSessionEntry,
  seedSessionStore,
  updateSessionStoreAfterAgentRun,
  withTempSessionStore,
} from "./session-store.test-support.js";
import { resolveSession } from "./session.js";

const { loadSessionEntry } = sessionAccessor;

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

const sessionId = "test-session";
const sessionKey = "agent:main:explicit:test-session";
type Update = Parameters<typeof updateSessionStoreAfterAgentRun>[0];
type Compact = Parameters<typeof recordCliCompactionInStore>[0];

async function withSession(
  run: (fixture: {
    storePath: string;
    sessionStore: Record<string, SessionEntry>;
    seed: (patch?: Partial<SessionEntry>) => Promise<SessionEntry>;
    update: (params?: Partial<Update>) => Promise<void>;
    compact: (
      params: Pick<Compact, "compactionKind" | "expectedSession" | "tokensAfter">,
    ) => Promise<SessionEntry | undefined>;
    read: () => SessionEntry | undefined;
  }) => Promise<void>,
) {
  await withTempSessionStore(async ({ storePath }) => {
    const sessionStore: Record<string, SessionEntry> = {};
    await run({
      storePath,
      sessionStore,
      seed: async (patch = {}) => {
        const entry: SessionEntry = { sessionId, updatedAt: 1, ...patch };
        await seedSessionStore(storePath, { [sessionKey]: entry });
        sessionStore[sessionKey] = entry;
        return entry;
      },
      update: (params = {}) =>
        updateSessionStoreAfterAgentRun({
          cfg: {},
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
          result: createRunResult({ sessionId, provider: "openai", model: "gpt-5.5" }),
          ...params,
        }),
      compact: (params) =>
        recordCliCompactionInStore({
          agentId: "main",
          sessionKey,
          sessionStore,
          storePath,
          ...params,
        }),
      read: () => loadPersistedSessionEntry(storePath, sessionKey),
    });
  });
}

function contextBudgetStatus(
  overrides: Partial<NonNullable<SessionEntry["contextBudgetStatus"]>> = {},
): NonNullable<SessionEntry["contextBudgetStatus"]> {
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: 123,
    provider: "minimax",
    model: "MiniMax-M2.7",
    route: "fits",
    shouldCompact: false,
    estimatedPromptTokens: 18_000,
    contextTokenBudget: 32_000,
    promptBudgetBeforeReserve: 28_000,
    reserveTokens: 4_000,
    effectiveReserveTokens: 4_000,
    remainingPromptBudgetTokens: 10_000,
    overflowTokens: 0,
    toolResultReducibleChars: 0,
    messageCount: 4,
    unwindowedMessageCount: 4,
    ...overrides,
  };
}

describe("updateSessionStoreAfterAgentRun", () => {
  it.each(["finalizer", "cli-compaction"] as const)(
    "publishes %s cache at commit without overwriting a subsequent writer",
    async (operation) => {
      await withTempSessionStore(async ({ storePath }) => {
        const publicationKey = `agent:main:commit-publication:${operation}`;
        const owner: SessionEntry = {
          sessionId: "committed-session",
          lifecycleRevision: "lifecycle",
          activeWriterRunId: "current-writer",
          updatedAt: 1,
          compactionCount: 2,
          cliSessionBindings: { codex: { sessionId: "native-session" } },
          totalTokens: 900,
          totalTokensFresh: true,
        };
        await seedSessionStore(storePath, { [publicationKey]: owner });
        const sessionStore = { [publicationKey]: owner };
        const replacement: SessionEntry = {
          ...owner,
          activeWriterRunId: "replacement-writer",
          updatedAt: 2,
          compactionCount: 9,
          totalTokens: 777,
        };
        const observed: Array<{ cached: SessionEntry; persisted?: SessionEntry }> = [];
        let replacementSnapshot: SessionEntry | undefined;
        const originalPatch = sessionAccessor.patchSessionEntryCore;
        const patch = vi
          .spyOn(sessionAccessor, "patchSessionEntryCore")
          .mockImplementation((scope, update, options) =>
            originalPatch(scope, update, {
              ...options,
              onCommitted: (committed) => {
                options?.onCommitted?.(committed);
                if (scope.sessionKey !== publicationKey || scope.storePath !== storePath) {
                  return;
                }
                observed.push({
                  cached: sessionStore[publicationKey]!,
                  persisted: loadSessionEntry({ ...scope, readConsistency: "latest" }),
                });
                sessionAccessor.replaceSessionEntrySync(scope, replacement);
                const canonicalReplacement = loadSessionEntry({
                  ...scope,
                  readConsistency: "latest",
                });
                if (!canonicalReplacement) {
                  throw new Error("expected the committed replacement writer");
                }
                replacementSnapshot = structuredClone(canonicalReplacement);
                sessionStore[publicationKey] = canonicalReplacement;
              },
            }),
          );
        try {
          let recorded: SessionEntry | undefined;
          if (operation === "cli-compaction") {
            recorded = await recordCliCompactionInStore({
              agentId: "main",
              compactionKind: "native-harness",
              sessionKey: publicationKey,
              sessionStore,
              storePath,
              expectedSession: owner,
              tokensAfter: 42,
            });
          } else {
            await updateSessionStoreAfterAgentRun({
              cfg: {},
              sessionId: owner.sessionId,
              sessionKey: publicationKey,
              sessionStore,
              storePath,
              defaultProvider: "openai",
              defaultModel: "gpt-5.6-luna",
              compactionAccounting: {
                kind: "durable",
                count: 0,
                currentContextSnapshot: { tokens: 42 },
                target: {
                  agentId: "main",
                  sessionId: owner.sessionId,
                  sessionKey: publicationKey,
                  storePath,
                  lifecycleRevision: owner.lifecycleRevision,
                  activeWriterRunId: owner.activeWriterRunId,
                },
              },
              result: { meta: { durationMs: 1 } },
            });
          }

          expect(observed).toHaveLength(1);
          expect(observed[0]?.persisted).toMatchObject({
            activeWriterRunId: "current-writer",
            totalTokens: 42,
            cliSessionBindings: { codex: { sessionId: "native-session" } },
            compactionCount: operation === "cli-compaction" ? 3 : 2,
          });
          expect(observed[0]?.cached).toEqual(observed[0]?.persisted);
          expect(replacementSnapshot).toBeDefined();
          expect(sessionStore[publicationKey]).toEqual(replacementSnapshot);
          expect(loadPersistedSessionEntry(storePath, publicationKey)).toEqual(replacementSnapshot);
          if (operation === "cli-compaction") {
            expect(recorded).toEqual(observed[0]?.persisted);
          }
        } finally {
          patch.mockRestore();
        }
      });
    },
  );

  it("uses the prepared agent directory for multi-agent cost accounting", async () => {
    await withTempSessionStore(async ({ dir, storePath }) => {
      const costKey = "agent:marie:dashboard:cost-accounting";
      const costSessionId = "cost-accounting-session";
      const sessionStore: Record<string, SessionEntry> = {};
      const agentDir = path.join(dir, "agents", "marie", "agent");
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify({
          providers: {
            openai: {
              models: [
                { id: "gpt-5.5", cost: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0 } },
              ],
            },
          },
        }),
      );

      await updateSessionStoreAfterAgentRun({
        agentId: "marie",
        cfg: {
          agents: { ownership: "explicit", entries: { main: {}, marie: {} } },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
        } satisfies OpenClawConfig,
        agentDir,
        sessionId: costSessionId,
        sessionKey: costKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: createRunResult({
          sessionId: costSessionId,
          provider: "openai",
          model: "gpt-5.5",
          usage: { input: 1_000_000, output: 1_000_000 },
        }),
      });

      expect(sessionStore[costKey]?.estimatedCostUsd).toBe(8);
    });
  });

  it("keeps the durable replay-safe guard when recovery is aborted", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      await seed({ restartRecoveryForceSafeTools: true });
      await update({
        clearRestartRecoveryForceSafeTools: true,
        result: createRunResult(
          { sessionId, provider: "openai", model: "gpt-5.5" },
          { aborted: true },
        ),
      });
      expect(sessionStore[sessionKey]?.restartRecoveryForceSafeTools).toBe(true);
      expect(read()?.restartRecoveryForceSafeTools).toBe(true);
    });
  });

  it("preserves concurrent management and permission changes during accounting", async () => {
    await withSession(async ({ storePath, sessionStore, seed, update, read }) => {
      const stale = await seed({
        label: "Old label",
        pinnedAt: 100,
        chatType: "direct",
        elevatedLevel: "full",
        inheritedToolAllow: ["exec"],
        sendPolicy: "allow",
      });
      const concurrent: SessionEntry = {
        ...stale,
        chatType: "group",
        label: "Renamed while running",
        sendPolicy: "deny",
        updatedAt: 2,
      };
      delete concurrent.elevatedLevel;
      delete concurrent.inheritedToolAllow;
      delete concurrent.pinnedAt;
      await seedSessionStore(storePath, { [sessionKey]: concurrent });
      const sql = observeHostDataSql();
      await update({
        result: createRunResult({
          sessionId,
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
        }),
      }).finally(sql.restore);
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      expect(sessionStore[sessionKey]).toMatchObject({
        chatType: "group",
        label: "Renamed while running",
        model: "gpt-5.5",
        sendPolicy: "deny",
      });
      expect(sessionStore[sessionKey]?.elevatedLevel).toBeUndefined();
      expect(sessionStore[sessionKey]?.inheritedToolAllow).toBeUndefined();
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
      expect(read()).toEqual(sessionStore[sessionKey]);
    });
  });

  it("rejects a finalizer attempting to rebind from public compaction metadata", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      await seed({ sessionFile: "old-session.jsonl" });
      await update({
        sessionId: "rotated-session",
        result: createRunResult({
          sessionId: "rotated-session",
          sessionFile: "rotated-session.jsonl",
          provider: "openai",
          model: "gpt-5.5",
          compactionCount: 1,
        }),
      });
      expect(sessionStore[sessionKey]?.sessionId).toBe(sessionId);
      expect(read()?.sessionId).toBe(sessionId);
      expect(read()?.compactionCount).toBeUndefined();
    });
  });

  it("uses the runtime context budget instead of cold fallback", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      await seed({
        agentHarnessId: "openclaw",
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
        contextTokens: 1_000_000,
      });
      await update({
        result: createRunResult({
          sessionId,
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 400_000,
          contextTokensSource: "runtime",
        }),
      });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject({
          modelProvider: "openai",
          model: "gpt-5.5",
          contextTokens: 400_000,
          contextTokensSource: "runtime",
        });
        expect(entry?.agentHarnessId).toBeUndefined();
      }
    });
  });
  it("stores and reloads the runtime model for explicit session-id-only runs", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        session: {
          store: storePath,
          mainKey: "main",
        },
        agents: {
          defaults: {},
        },
      } as never;

      const first = await resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(first.sessionKey).toBe("agent:main:explicit:explicit-session-123");

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId: first.sessionId,
        sessionKey: first.sessionKey!,
        storePath: first.storePath,
        sessionStore: {},
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "claude-cli",
              model: "claude-sonnet-4-6",
              sessionId: "claude-cli-session-1",
            },
          },
        } as never,
      });

      const second = await resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(second.sessionKey).toBe(first.sessionKey);
      expect(second.sessionEntry).toMatchObject({
        modelProvider: "claude-cli",
        model: "claude-sonnet-4-6",
      });

      const persisted = loadPersistedSessionEntry(storePath, first.sessionKey!);
      expect(persisted).toMatchObject({
        modelProvider: "claude-cli",
        model: "claude-sonnet-4-6",
      });
    });
  });

  it("reuses a completed run entry while the session is still fresh", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const completedKey = "agent:main:explicit:terminal-cli-session";
      const existingSessionId = "terminal-cli-session-old";
      const now = Date.now();
      await seedSessionStore(storePath, {
        [completedKey]: {
          sessionId: existingSessionId,
          updatedAt: now,
          status: "done",
          startedAt: now - 1_000,
          endedAt: now - 100,
          runtimeMs: 900,
        },
      });

      const result = await resolveSession({
        cfg: {
          session: {
            store: storePath,
            mainKey: "main",
          },
        } as OpenClawConfig,
        sessionKey: completedKey,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(result.sessionEntry?.sessionId).toBe(existingSessionId);
      expect(result.sessionEntry?.status).toBe("done");
      expect(result.sessionEntry?.endedAt).toBe(now - 100);
    });
  });

  it("marks empty-session usage stale without reviving historical compaction (#67667)", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      await seed({ totalTokens: 0, totalTokensFresh: true });
      await update({
        result: createRunResult({
          sessionId,
          provider: "minimax",
          model: "MiniMax-M2.7",
          compactionCount: 1,
          compactionTokensAfter: 80_000,
        }),
      });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry?.totalTokens).toBe(0);
        expect(entry?.totalTokensFresh).toBe(false);
      }
    });
  });

  it("uses last-call usage instead of cumulative billing when promptTokens is absent", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      await seed();
      await update({
        defaultProvider: "custom-openai",
        defaultModel: "responses-model",
        result: createRunResult({
          sessionId,
          provider: "custom-openai",
          model: "responses-model",
          usage: {
            input: 497_720,
            output: 7_485,
            cacheRead: 1_323_520,
            cacheWrite: 0,
            total: 1_828_725,
          },
          lastCallUsage: {
            input: 38_333,
            output: 66,
            cacheRead: 120_320,
            total: 158_719,
          },
        }),
      });
      expect(sessionStore[sessionKey]?.totalTokens).toBe(158_653);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(read()?.totalTokens).toBe(158_653);
    });
  });

  it("persists a private unknown context independently of billing usage", async () => {
    await withSession(async ({ seed, update, read, sessionStore, storePath }) => {
      const owner = await seed({
        totalTokens: 180_000,
        totalTokensFresh: true,
        compactionCount: 3,
        estimatedCostUsd: 1.25,
        lifecycleRevision: "lifecycle",
        activeWriterRunId: "previous-writer",
      });
      await seedSessionStore(storePath, {
        [sessionKey]: { ...owner, activeWriterRunId: "current-writer" },
      });
      const usage = {
        input: 100_000,
        output: 3_000,
        cacheRead: 20_000,
        cacheWrite: 1_000,
        cost: { total: 0.75 },
      };
      const lastCallUsage = { input: 91_000, output: 1_000, cacheRead: 4_000 };
      const result = createRunResult({
        sessionId,
        provider: "openai",
        model: "gpt-5.6-luna",
        usage,
        lastCallUsage,
        promptTokens: 95_000,
        compactionCount: 99,
        compactionTokensAfter: 80_000,
      });
      await update({
        compactionAccounting: {
          kind: "durable",
          count: 1,
          currentContextSnapshot: { tokens: undefined },
          target: {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath,
            lifecycleRevision: "lifecycle",
            activeWriterRunId: "current-writer",
          },
        },
        result,
      });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject({
          inputTokens: 100_000,
          outputTokens: 3_000,
          cacheRead: 20_000,
          cacheWrite: 1_000,
          estimatedCostUsd: 0.75,
          compactionCount: 3,
          activeWriterRunId: "current-writer",
          totalTokensFresh: false,
        });
        expect(entry?.totalTokens).toBeUndefined();
        expect(resolveFreshSessionTotalTokens(entry)).toBeUndefined();
      }
      expect(result.meta.agentMeta?.usage).toEqual(usage);
      expect(result.meta.agentMeta?.lastCallUsage).toEqual(lastCallUsage);
    });
  });

  it.each(["missing", "replaced"] as const)(
    "does not write through a private fact whose owner is %s",
    async (ownerState) => {
      await withSession(async ({ storePath, sessionStore, update, read }) => {
        if (ownerState === "replaced") {
          await seedSessionStore(storePath, {
            [sessionKey]: {
              sessionId,
              updatedAt: 1,
              lifecycleRevision: "lifecycle",
              activeWriterRunId: "replacement-writer",
              totalTokens: 73_000,
              totalTokensFresh: true,
            },
          });
        }
        const before = read();
        await update({
          compactionAccounting: {
            kind: "durable",
            count: 0,
            currentContextSnapshot: { tokens: 42 },
            target: {
              agentId: "main",
              sessionId,
              sessionKey,
              storePath,
              lifecycleRevision: "lifecycle",
              activeWriterRunId: "previous-writer",
            },
          },
          result: createRunResult({
            sessionId,
            provider: "openai",
            model: "gpt-5.6-luna",
            usage: { cost: { total: 0 } },
          }),
        });
        expect(read()).toEqual(before);
        expect(sessionStore[sessionKey]).toBeUndefined();
      });
    },
  );

  it("persists a private zero-token context without erasing prior billing", async () => {
    await withSession(async ({ seed, update, read, sessionStore, storePath }) => {
      const billing = { inputTokens: 20, outputTokens: 10, cacheRead: 30, cacheWrite: 40 };
      await seed(billing);
      await update({
        compactionAccounting: {
          kind: "durable",
          count: 1,
          currentContextSnapshot: { tokens: 0 },
          target: {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath,
            lifecycleRevision: undefined,
            activeWriterRunId: undefined,
          },
        },
        result: createRunResult({
          sessionId,
          provider: "openai",
          model: "gpt-5.6-luna",
          compactionCount: 99,
          compactionTokensAfter: 80_000,
        }),
      });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject({ ...billing, totalTokens: 0, totalTokensFresh: true });
        expect(resolveFreshSessionTotalTokens(entry)).toBe(0);
        expect(entry?.compactionCount).toBeUndefined();
      }
    });
  });

  it("clears settled main recovery state while retaining subagent recovery", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      const subagentRecovery = {
        automaticAttempts: 2,
        lastAttemptAt: 3,
        wedgedAt: 4,
        wedgedReason: "automatic_attempt_budget_exceeded" as const,
      };
      await seed({
        abortedLastRun: true,
        restartRecoveryForceSafeTools: true,
        restartRecoveryRuns: [
          { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
          { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
        ],
        mainRestartRecovery: { cycleId: "cycle-1", revision: 3, chargedAttempts: 2 },
        subagentRecovery,
      });
      await update({
        touchInteraction: false,
        touchActivity: false,
        preserveRuntimeModel: true,
        clearRestartRecoveryForceSafeTools: true,
        result: createRunResult(
          { sessionId, provider: "openai", model: "gpt-5.5" },
          { aborted: false },
        ),
      });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry?.abortedLastRun).toBe(false);
        expect(entry?.restartRecoveryRuns).toBeUndefined();
        expect(entry?.restartRecoveryForceSafeTools).toBeUndefined();
        expect(entry?.mainRestartRecovery).toBeUndefined();
        expect(entry?.subagentRecovery).toEqual(subagentRecovery);
      }
      expect(read()).not.toHaveProperty("mainRestartRecovery");
    });
  });

  it("preserves the visible runtime model during an automation using another model", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      const visible = {
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
        agentHarnessId: "openclaw",
        contextTokens: 1_000_000,
        cliSessionBindings: { "claude-cli": { sessionId: "existing-cli-session" } },
        cliSessionIds: { "claude-cli": "existing-cli-session" },
        claudeCliSessionId: "existing-cli-session",
        contextBudgetStatus: contextBudgetStatus({
          provider: "anthropic",
          model: "claude-opus-4-6",
          estimatedPromptTokens: 640_000,
          contextTokenBudget: 1_000_000,
        }),
      };
      await seed(visible);
      await update({
        preserveRuntimeModel: true,
        result: createRunResult({
          sessionId,
          provider: "claude-cli",
          model: "claude-sonnet-4-6",
          agentHarnessId: "codex",
          contextTokens: 128_000,
          cliSessionBinding: { sessionId: "automation-cli-session" },
          contextBudgetStatus: contextBudgetStatus({ provider: "ollama", model: "llama3.2:1b" }),
        }),
      });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject(visible);
      }
    });
  });

  it("preserves user-facing accounting while allowing session touch metadata", async () => {
    await withSession(async ({ seed, update, read, sessionStore, storePath }) => {
      await seed({
        lastInteractionAt: 10,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
        contextTokens: 1_000_000,
        inputTokens: 11,
        outputTokens: 22,
        totalTokens: 333,
        totalTokensFresh: true,
        cacheRead: 4,
        cacheWrite: 5,
        estimatedCostUsd: 0.25,
        abortedLastRun: false,
        cliSessionBindings: { "claude-cli": { sessionId: "visible-cli-session" } },
        compactionCount: 7,
      });
      const visible: SessionEntry = {
        sessionId: "fresh-visible-session-id",
        updatedAt: 2,
        sessionStartedAt: 777,
        lastInteractionAt: 20,
        lastActivityAt: 21,
        modelProvider: "openai",
        model: "gpt-5.5",
        contextTokens: 400_000,
        inputTokens: 44,
        outputTokens: 55,
        totalTokens: 666,
        totalTokensFresh: true,
        cacheRead: 7,
        cacheWrite: 8,
        estimatedCostUsd: 0.5,
        abortedLastRun: false,
        cliSessionBindings: { "claude-cli": { sessionId: "new-visible-cli-session" } },
        compactionCount: 9,
      };
      await seedSessionStore(storePath, { [sessionKey]: visible });
      await update({
        preserveUserFacingSessionModelState: true,
        result: createRunResult(
          {
            sessionId,
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            contextTokens: 200_000,
            usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 20 },
            compactionCount: 3,
            cliSessionBinding: { sessionId: "handoff-cli-session" },
          },
          { aborted: true },
        ),
      });
      const { updatedAt, lastInteractionAt, ...untouched } = visible;
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject(untouched);
        expect(entry?.lastInteractionAt).toBeGreaterThan(lastInteractionAt!);
        expect(entry?.updatedAt).toBeGreaterThan(updatedAt);
      }
    });
  });

  it("does not recreate a deleted row after a normal run with a preloaded entry", async () => {
    await withSession(async ({ sessionStore, update, read }) => {
      const original = { sessionId, updatedAt: 1, modelProvider: "openai", model: "gpt-5.5" };
      sessionStore[sessionKey] = original;
      await update({
        result: createRunResult({
          sessionId,
          provider: "openai",
          model: "gpt-5.5",
          usage: { input: 100, output: 20 },
        }),
      });
      expect(sessionStore[sessionKey]).toEqual(original);
      expect(read()).toBeUndefined();
    });
  });

  it("does not overwrite a replacement persisted row after a normal run", async () => {
    await withSession(async ({ seed, update, read, storePath }) => {
      await seed({ modelProvider: "anthropic", model: "claude-sonnet-4-6" });
      const replacement: SessionEntry = {
        sessionId: "replacement-session-id",
        updatedAt: 2,
        delivery: { kind: "none" },
        modelProvider: "openai",
        model: "gpt-5.5",
      };
      await seedSessionStore(storePath, { [sessionKey]: replacement });
      await update({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        result: createRunResult({
          sessionId,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        }),
      });
      expect(read()).toEqual(replacement);
    });
  });

  it("does not borrow the automation provider for a model-only session", async () => {
    await withSession(async ({ seed, update, read, sessionStore }) => {
      await seed({ model: "claude-opus-4-6" });
      await update({
        preserveRuntimeModel: true,
        result: createRunResult({
          sessionId,
          provider: "ollama",
          model: "llama3.2:1b",
          contextTokens: 128_000,
        }),
      });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry?.model).toBe("claude-opus-4-6");
        expect(entry?.modelProvider).toBeUndefined();
        expect(entry?.contextTokens).toBeUndefined();
      }
    });
  });
});

describe("recordCliCompactionInStore", () => {
  it("marks native compaction usage stale without a token count", async () => {
    await withSession(async ({ seed, compact, read, sessionStore }) => {
      const owner = await seed({
        totalTokens: 37_000,
        totalTokensFresh: true,
        inputTokens: 30_000,
        outputTokens: 100,
        cacheRead: 6_900,
        cacheWrite: 0,
        contextBudgetStatus: contextBudgetStatus({
          provider: "codex",
          model: "gpt-5.5",
          route: "compact_only",
          shouldCompact: true,
        }),
      });
      const sql = observeHostDataSql();
      await compact({ expectedSession: owner, compactionKind: "native-harness" }).finally(
        sql.restore,
      );
      expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject({
          compactionCount: 1,
          totalTokens: 37_000,
          totalTokensFresh: false,
        });
        for (const field of [
          "inputTokens",
          "outputTokens",
          "cacheRead",
          "cacheWrite",
          "contextBudgetStatus",
        ] as const) {
          expect(entry?.[field]).toBeUndefined();
        }
      }
    });
  });

  it("records shared-history compaction and clears every CLI binding", async () => {
    await withSession(async ({ seed, compact, read, sessionStore }) => {
      const owner = await seed({
        modelProvider: "openai",
        model: "gpt-5.5",
        totalTokens: 12_000,
        totalTokensFresh: true,
        inputTokens: 9_000,
        outputTokens: 100,
        cacheRead: 2_900,
        cacheWrite: 0,
        estimatedCostUsd: 0.04,
        cliSessionBindings: {
          codex: { sessionId: "stale-cli-session" },
          "claude-cli": { sessionId: "stale-claude-session" },
        },
        cliSessionIds: { codex: "stale-cli-session", "claude-cli": "stale-claude-session" },
        claudeCliSessionId: "stale-claude-session",
      });
      await compact({ expectedSession: owner, compactionKind: "context-engine", tokensAfter: 42 });
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject({
          sessionId,
          modelProvider: "openai",
          model: "gpt-5.5",
          compactionCount: 1,
          totalTokens: 42,
          totalTokensFresh: true,
        });
        expect(resolveFreshSessionTotalTokens(entry)).toBe(42);
        for (const field of [
          "inputTokens",
          "outputTokens",
          "cacheRead",
          "cacheWrite",
          "estimatedCostUsd",
          "cliSessionBindings",
          "cliSessionIds",
          "claudeCliSessionId",
        ] as const) {
          expect(entry?.[field]).toBeUndefined();
        }
      }
    });
  });

  it("does not recreate a deleted row after compaction", async () => {
    await withSession(async ({ compact, read, sessionStore }) => {
      const owner = {
        sessionId,
        updatedAt: 1,
        cliSessionIds: { codex: "stale-cli-session" },
      };
      sessionStore[sessionKey] = owner;
      const result = await compact({
        expectedSession: owner,
        compactionKind: "context-engine",
        tokensAfter: 42,
      });
      expect(result).toBeUndefined();
      expect(read()).toBeUndefined();
    });
  });

  it.each([{ lifecycleRevision: "replacement" }, { activeWriterRunId: "replacement" }])(
    "does not account against a changed CLI owner: %j",
    async (replacement) => {
      await withSession(async ({ seed, compact, read, storePath }) => {
        const owner = await seed({
          lifecycleRevision: "lifecycle",
          activeWriterRunId: "writer",
          compactionCount: 3,
        });
        const changed = { ...owner, ...replacement };
        await seedSessionStore(storePath, { [sessionKey]: changed });
        const result = await compact({
          expectedSession: owner,
          compactionKind: "context-engine",
          tokensAfter: 42,
        });
        expect(result).toBeUndefined();
        expect(read()).toMatchObject(changed);
      });
    },
  );
});
