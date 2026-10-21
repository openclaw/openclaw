import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it as baseIt, vi } from "vitest";
import {
  isSessionEntryDataSql,
  observeHostDataSql,
} from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { contextBudgetStatusFixture } from "../../config/sessions/context-budget.test-support.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import {
  claimMainSessionRecoveryOwner,
  refreshMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "../main-session-recovery/main-session-recovery-store.js";
import { modelDefinition } from "../model-auth.fixtures.test-support.js";
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

function runResult(
  agentMeta: Partial<Parameters<typeof createRunResult>[0]> = {},
  meta: Parameters<typeof createRunResult>[1] = {},
) {
  return createRunResult({ sessionId, provider: "openai", model: "gpt-5.5", ...agentMeta }, meta);
}

function accountingFact(
  storePath: string,
  target: Partial<NonNullable<Update["compactionAccounting"]>["target"]> = {},
): NonNullable<Update["compactionAccounting"]> {
  return {
    kind: "durable",
    count: 0,
    currentContextSnapshot: { tokens: 42 },
    target: { agentId: "main", sessionId, sessionKey, storePath, ...target },
  };
}

function sessionFixture({ dir, storePath }: { dir: string; storePath: string }) {
  const sessionStore: Record<string, SessionEntry> = {};
  const cfg = { session: { store: storePath, mainKey: "main" }, agents: { defaults: {} } };
  const persist = (entry: SessionEntry) => seedSessionStore(storePath, { [sessionKey]: entry });
  const read = () => loadPersistedSessionEntry(storePath, sessionKey);
  return {
    dir,
    cfg,
    storePath,
    sessionStore,
    persist,
    seed: async (patch: Partial<SessionEntry> = {}) => {
      const entry: SessionEntry = { sessionId, updatedAt: 1, ...patch };
      await persist(entry);
      sessionStore[sessionKey] = entry;
      return entry;
    },
    update: (params: Partial<Update> = {}) =>
      updateSessionStoreAfterAgentRun({
        cfg: {},
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: runResult(),
        ...params,
      }),
    compact: (params: Pick<Compact, "compactionKind" | "expectedSession" | "tokensAfter">) =>
      recordCliCompactionInStore({
        agentId: "main",
        sessionKey,
        sessionStore,
        storePath,
        ...params,
      }),
    read,
    resolve: (target: Pick<Parameters<typeof resolveSession>[0], "sessionId" | "sessionKey">) =>
      resolveSession({ cfg, ...target }),
    check: (expected: Partial<SessionEntry>, cleared: (keyof SessionEntry)[] = []) => {
      for (const entry of [sessionStore[sessionKey], read()]) {
        expect(entry).toMatchObject(expected);
        for (const field of cleared) {
          expect(entry?.[field]).toBeUndefined();
        }
      }
    },
  };
}

const it = baseIt.extend<{ s: ReturnType<typeof sessionFixture> }>({
  s: async ({ task: _task }, use) => withTempSessionStore((paths) => use(sessionFixture(paths))),
});

function accountingState(revision: number): SessionEntry {
  return {
    sessionId: `visible-session-${revision}`,
    updatedAt: revision,
    sessionStartedAt: revision * 100,
    lastInteractionAt: revision * 10,
    lastActivityAt: revision * 10 + 1,
    modelProvider: revision === 1 ? "anthropic" : "openai",
    model: revision === 1 ? "claude-opus-4-6" : "gpt-5.5",
    contextTokens: revision * 100_000,
    inputTokens: revision * 11,
    outputTokens: revision * 22,
    totalTokens: revision * 333,
    totalTokensFresh: true,
    cacheRead: revision * 4,
    cacheWrite: revision * 5,
    estimatedCostUsd: revision * 0.25,
    abortedLastRun: false,
    cliSessionBindings: { "claude-cli": { sessionId: `cli-session-${revision}` } },
    compactionCount: revision * 7,
  };
}

describe("updateSessionStoreAfterAgentRun", () => {
  it.for(["finalizer", "cli-compaction"] as const)(
    "publishes %s cache at commit without overwriting a subsequent writer",
    async (operation, { s }) => {
      const owner = await s.seed({
        lifecycleRevision: "lifecycle",
        activeWriterRunId: "current-writer",
        compactionCount: 2,
        cliSessionBindings: { codex: { sessionId: "native-session" } },
        totalTokens: 900,
        totalTokensFresh: true,
      });
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
        .mockImplementation((scope, patchEntry, options) =>
          originalPatch(scope, patchEntry, {
            ...options,
            onCommitted: (committed) => {
              options?.onCommitted?.(committed);
              if (scope.sessionKey !== sessionKey || scope.storePath !== s.storePath) {
                return;
              }
              observed.push({
                cached: s.sessionStore[sessionKey]!,
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
              s.sessionStore[sessionKey] = canonicalReplacement;
            },
          }),
        );
      try {
        let recorded: SessionEntry | undefined;
        if (operation === "cli-compaction") {
          recorded = await s.compact({
            compactionKind: "native-harness",
            expectedSession: owner,
            tokensAfter: 42,
          });
        } else {
          await s.update({
            defaultModel: "gpt-5.6-luna",
            compactionAccounting: accountingFact(s.storePath, {
              lifecycleRevision: owner.lifecycleRevision,
              activeWriterRunId: owner.activeWriterRunId,
            }),
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
        expect(s.sessionStore[sessionKey]).toEqual(replacementSnapshot);
        expect(s.read()).toEqual(replacementSnapshot);
        if (operation === "cli-compaction") {
          expect(recorded).toEqual(observed[0]?.persisted);
        }
      } finally {
        patch.mockRestore();
      }
    },
  );

  it("prices usage from the prepared agent directory", async ({ s }) => {
    const costKey = "agent:marie:dashboard:cost-accounting";
    const agentDir = path.join(s.dir, "agents", "marie", "agent");
    const model = modelDefinition("gpt-5.5", {
      cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
    });
    const localModel = { id: model.id, cost: { ...model.cost, input: 3, output: 5 } };
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { openai: { models: [localModel] } } }),
    );

    await s.update({
      agentId: "marie",
      cfg: {
        agents: { ownership: "explicit", entries: { main: {}, marie: {} } },
        models: {
          providers: {
            openai: { baseUrl: "https://api.openai.com/v1", models: [model] },
          },
        },
      } satisfies OpenClawConfig,
      agentDir,
      sessionKey: costKey,
      result: runResult({ usage: { input: 1_000_000, output: 1_000_000 } }),
    });

    expect(s.sessionStore[costKey]?.estimatedCostUsd).toBe(8);
  });

  it("retains the replay-safe guard after abort", async ({ s }) => {
    await s.seed({ restartRecoveryForceSafeTools: true });
    await s.update({
      clearRestartRecoveryForceSafeTools: true,
      result: runResult({}, { aborted: true }),
    });
    s.check({ restartRecoveryForceSafeTools: true });
  });

  it("preserves concurrent management and permissions", async ({ s }) => {
    const stale = await s.seed({
      label: "Old label",
      pinnedAt: 100,
      chatType: "direct",
      elevatedLevel: "full",
      inheritedToolAllow: ["exec"],
      sendPolicy: "allow",
      agentHarnessId: "openclaw",
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
    await s.persist(concurrent);
    const sql = observeHostDataSql();
    await s
      .update({
        result: runResult({
          contextTokens: 32_000,
          contextTokensSource: "runtime",
        }),
      })
      .finally(sql.restore);
    expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    expect(s.sessionStore[sessionKey]).toMatchObject({
      chatType: "group",
      label: "Renamed while running",
      model: "gpt-5.5",
      sendPolicy: "deny",
      contextTokens: 32_000,
      contextTokensSource: "runtime",
    });
    expect(s.sessionStore[sessionKey]?.agentHarnessId).toBeUndefined();
    expect(s.sessionStore[sessionKey]?.elevatedLevel).toBeUndefined();
    expect(s.sessionStore[sessionKey]?.inheritedToolAllow).toBeUndefined();
    expect(s.sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    expect(s.read()).toEqual(s.sessionStore[sessionKey]);
  });

  it("rejects public compaction metadata as rebind authority", async ({ s }) => {
    await s.seed({ sessionFile: "old-session.jsonl" });
    await s.update({
      sessionId: "rotated-session",
      result: runResult({
        sessionId: "rotated-session",
        sessionFile: "rotated-session.jsonl",
        compactionCount: 1,
      }),
    });
    expect(s.sessionStore[sessionKey]?.sessionId).toBe(sessionId);
    expect(s.read()?.sessionId).toBe(sessionId);
    expect(s.read()?.compactionCount).toBeUndefined();
  });

  it("persists explicit-session runtime models", async ({ s }) => {
    const first = await s.resolve({ sessionId });
    expect(first.sessionKey).toBe(sessionKey);
    await s.update({
      cfg: s.cfg,
      sessionId: first.sessionId,
      sessionKey: first.sessionKey!,
      defaultProvider: "claude-cli",
      defaultModel: "claude-sonnet-4-6",
      result: runResult({
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        sessionId: "claude-cli-session-1",
      }),
    });

    const second = await s.resolve({ sessionId });
    expect(second.sessionKey).toBe(first.sessionKey);
    for (const entry of [second.sessionEntry, s.read()]) {
      expect(entry).toMatchObject({ modelProvider: "claude-cli", model: "claude-sonnet-4-6" });
    }
  });

  it("reuses fresh completed sessions", async ({ s }) => {
    const existingSessionId = "terminal-cli-session-old";
    const now = Date.now();
    await s.seed({
      sessionId: existingSessionId,
      updatedAt: now,
      status: "done",
      endedAt: now - 100,
    });

    const result = await s.resolve({ sessionKey });

    expect(result.isNewSession).toBe(false);
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.sessionEntry).toMatchObject({
      sessionId: existingSessionId,
      status: "done",
      endedAt: now - 100,
    });
  });

  it("invalidates empty usage after compaction (#67667)", async ({ s }) => {
    await s.seed({ totalTokens: 0, totalTokensFresh: true });
    await s.update({
      result: runResult({
        provider: "minimax",
        model: "MiniMax-M2.7",
        compactionCount: 1,
        compactionTokensAfter: 80_000,
      }),
    });
    s.check({ totalTokens: 0, totalTokensFresh: false });
  });

  it("uses last-call input, not cumulative billing", async ({ s }) => {
    await s.seed();
    await s.update({
      defaultProvider: "custom-openai",
      defaultModel: "responses-model",
      result: runResult({
        provider: "custom-openai",
        model: "responses-model",
        usage: { input: 500, output: 8, cacheRead: 1_300, cacheWrite: 0, total: 1_808 },
        lastCallUsage: { input: 38, output: 1, cacheRead: 120, total: 159 },
      }),
    });
    s.check({ totalTokens: 158, totalTokensFresh: true });
  });

  it.for(["missing", "replaced"] as const)(
    "does not write through a private fact whose owner is %s",
    async (ownerState, { s }) => {
      if (ownerState === "replaced") {
        await s.persist({
          sessionId,
          updatedAt: 1,
          lifecycleRevision: "lifecycle",
          activeWriterRunId: "replacement-writer",
          totalTokens: 73_000,
          totalTokensFresh: true,
        });
      }
      const before = s.read();
      await s.update({
        compactionAccounting: accountingFact(s.storePath, {
          lifecycleRevision: "lifecycle",
          activeWriterRunId: "previous-writer",
        }),
        result: runResult({
          model: "gpt-5.6-luna",
          usage: { cost: { total: 0 } },
        }),
      });
      expect(s.read()).toEqual(before);
      expect(s.sessionStore[sessionKey]).toBeUndefined();
    },
  );

  it("retains queued recovery claims after completion", async ({ s }) => {
    await s.seed({
      abortedLastRun: true,
      mainRestartRecovery: { cycleId: "cycle-1", revision: 1, chargedAttempts: 0 },
    });
    const claim = (runId: string) =>
      claimMainSessionRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        sessionId,
        runId,
        target: { agentId: "main", sessionKey, storePath: s.storePath },
      });
    const first = await claim("queued-1");
    const second = await claim("queued-2");
    if (first.kind !== "claimed" || second.kind !== "claimed") {
      throw new Error("expected two foreground recovery claims");
    }
    // The running command has adopted its claim. A queued peer still owns the
    // same recovery cycle after this command records successful completion.
    s.sessionStore[sessionKey] = s.read()!;
    await s.update();
    await releaseMainSessionRecoveryOwner(first.lease);
    expect(await refreshMainSessionRecoveryOwner(second.lease, "queued-2")).toBeDefined();
    expect(s.read()?.mainRestartRecovery?.foregroundClaims?.tokens).toEqual([second.lease.claimId]);
    await releaseMainSessionRecoveryOwner(second.lease);
    expect(s.read()?.mainRestartRecovery).toBeUndefined();
    expect(s.read()?.restartRecoveryRuns).toBeUndefined();
  });

  it("clears main recovery but retains subagent recovery", async ({ s }) => {
    const subagentRecovery = {
      automaticAttempts: 2,
      lastAttemptAt: 3,
      wedgedAt: 4,
      wedgedReason: "automatic_attempt_budget_exceeded" as const,
    };
    await s.seed({
      abortedLastRun: true,
      restartRecoveryForceSafeTools: true,
      restartRecoveryRuns: [
        { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
        { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
      ],
      mainRestartRecovery: { cycleId: "cycle-1", revision: 3, chargedAttempts: 2 },
      subagentRecovery,
    });
    await s.update({
      touchInteraction: false,
      touchActivity: false,
      preserveRuntimeModel: true,
      clearRestartRecoveryForceSafeTools: true,
      result: runResult({}, { aborted: false }),
    });
    s.check({ abortedLastRun: false }, [
      "restartRecoveryRuns",
      "restartRecoveryForceSafeTools",
      "mainRestartRecovery",
    ]);
    for (const entry of [s.sessionStore[sessionKey], s.read()]) {
      expect(entry?.subagentRecovery).toEqual(subagentRecovery);
    }
    expect(s.read()).not.toHaveProperty("mainRestartRecovery");
  });

  it("preserves the visible runtime model during a heartbeat using another model", async ({
    s,
  }) => {
    const visible = {
      modelProvider: "anthropic",
      model: "claude-opus-4-6",
      agentHarnessId: "openclaw",
      contextTokens: 1_000_000,
      cliSessionBindings: { "claude-cli": { sessionId: "existing-cli-session" } },
      cliSessionIds: { "claude-cli": "existing-cli-session" },
      claudeCliSessionId: "existing-cli-session",
      contextBudgetStatus: contextBudgetStatusFixture({
        provider: "anthropic",
        model: "claude-opus-4-6",
        estimatedPromptTokens: 640_000,
        contextTokenBudget: 1_000_000,
      }),
    };
    await s.seed(visible);
    await s.update({
      preserveRuntimeModel: true,
      result: createRunResult({
        sessionId,
        provider: "claude-cli",
        model: "claude-sonnet-4-6",
        agentHarnessId: "codex",
        contextTokens: 128_000,
        cliSessionBinding: { sessionId: "heartbeat-cli-session" },
        contextBudgetStatus: contextBudgetStatusFixture({
          provider: "ollama",
          model: "llama3.2:1b",
        }),
      }),
    });
    for (const entry of [s.sessionStore[sessionKey], s.read()]) {
      expect(entry).toMatchObject(visible);
    }
  });

  it("preserves current accounting during session touch", async ({ s }) => {
    await s.seed(accountingState(1));
    const visible = accountingState(2);
    await s.persist(visible);
    await s.update({
      preserveUserFacingSessionModelState: true,
      result: runResult(
        {
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
    for (const entry of [s.sessionStore[sessionKey], s.read()]) {
      expect(entry).toMatchObject(untouched);
      expect(entry?.lastInteractionAt).toBeGreaterThan(lastInteractionAt!);
      expect(entry?.updatedAt).toBeGreaterThan(updatedAt);
    }
  });

  it("does not recreate deleted rows after a run", async ({ s }) => {
    const original = { sessionId, updatedAt: 1, modelProvider: "openai", model: "gpt-5.5" };
    s.sessionStore[sessionKey] = original;
    await s.update({
      result: runResult({ usage: { input: 100, output: 20 } }),
    });
    expect(s.sessionStore[sessionKey]).toEqual(original);
    expect(s.read()).toBeUndefined();
  });

  it("does not overwrite replacement rows after a run", async ({ s }) => {
    await s.seed({ modelProvider: "anthropic", model: "claude-sonnet-4-6" });
    const replacement: SessionEntry = {
      sessionId: "replacement-session-id",
      updatedAt: 2,
      delivery: { kind: "none" },
      modelProvider: "openai",
      model: "gpt-5.5",
    };
    await s.persist(replacement);
    await s.update({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-6",
      result: runResult({ provider: "anthropic", model: "claude-sonnet-4-6" }),
    });
    expect(s.read()).toEqual(replacement);
  });
});

describe("recordCliCompactionInStore", () => {
  it("invalidates usage after untallied native compaction", async ({ s }) => {
    const owner = await s.seed({
      totalTokens: 37_000,
      totalTokensFresh: true,
      inputTokens: 30_000,
      outputTokens: 100,
      cacheRead: 6_900,
      cacheWrite: 0,
      contextBudgetStatus: contextBudgetStatusFixture(),
    });
    const sql = observeHostDataSql();
    await s
      .compact({ expectedSession: owner, compactionKind: "native-harness" })
      .finally(sql.restore);
    expect(sql.queries.filter(isSessionEntryDataSql)).toEqual([]);
    s.check({ compactionCount: 1, totalTokens: 37_000, totalTokensFresh: false }, [
      "inputTokens",
      "outputTokens",
      "cacheRead",
      "cacheWrite",
      "contextBudgetStatus",
    ]);
  });
  it("does not recreate deleted rows after compaction", async ({ s }) => {
    const owner = {
      sessionId,
      updatedAt: 1,
      cliSessionIds: { codex: "stale-cli-session" },
    };
    s.sessionStore[sessionKey] = owner;
    const result = await s.compact({
      expectedSession: owner,
      compactionKind: "context-engine",
      tokensAfter: 42,
    });
    expect(result).toBeUndefined();
    expect(s.read()).toBeUndefined();
  });

  it.for([{ lifecycleRevision: "replacement" }, { activeWriterRunId: "replacement" }])(
    "does not account against a changed CLI owner: %j",
    async (replacement, { s }) => {
      const owner = await s.seed({
        lifecycleRevision: "lifecycle",
        activeWriterRunId: "writer",
        compactionCount: 3,
      });
      const changed = { ...owner, ...replacement };
      await s.persist(changed);
      const result = await s.compact({
        expectedSession: owner,
        compactionKind: "context-engine",
        tokensAfter: 42,
      });
      expect(result).toBeUndefined();
      expect(s.read()).toMatchObject(changed);
    },
  );
});
