import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  acquireAgentRunPreparedModelRuntimeMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
} from "./compact.hooks.harness.js";

const { compactEmbeddedAgentSession } = await loadCompactHooksHarness({
  realContextEngineRegistry: true,
});
const { registerContextEngineInRegistry, resolveContextEngine, listContextEngineQuarantines } =
  await import("../../context-engine/registry.js");
const { resetContextEngineRuntimeQuarantineForTests } =
  await import("../../context-engine/registry.test-support.js");
const { createContextEngineLogicalTurnLease } =
  await import("../harness/context-engine-logical-turn.js");
const { withPluginRuntimeGenerationScope } =
  await import("../../plugins/runtime/generation-scope.js");
const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
const { AsyncWorkScope } = await import("../../shared/async-work-scope.js");
const { upsertSessionEntryCore } = await import("../../config/sessions/session-accessor.js");
const { closeOpenClawAgentDatabasesForTest } = await import("../../state/openclaw-agent-db.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    resetContextEngineRuntimeQuarantineForTests();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  }),
);

it("compacts the recovered engine frontier before the next turn without clearing process quarantine", async () => {
  const workspaceDir = await realpath(tempDirs.make("openclaw-compaction-quarantine-"));
  resetCompactHooksHarnessMocks(workspaceDir);
  const target = {
    agentId: "main",
    sessionId: "quarantine",
    sessionKey: "agent:main:quarantine",
    storePath: join(workspaceDir, "sessions.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  const config = { plugins: { slots: { contextEngine: "frontier" } } };
  const acquire = expectDefined(
    acquireAgentRunPreparedModelRuntimeMock.getMockImplementation(),
    "prepared runtime",
  );
  const acquired = await acquire({ config, agentId: "main", agentDir: workspaceDir, workspaceDir });
  const runtime = {
    ...acquired,
    snapshot: { ...acquired.snapshot, pluginRegistry: createEmptyPluginRegistry() },
  };
  acquireAgentRunPreparedModelRuntimeMock.mockResolvedValue(runtime);
  const message = (content: string) => ({ role: "user" as const, content, timestamp: 1 });
  let host = Array.from({ length: 20 }, (_, i) => message(String(i)));
  let frontier = [...host];
  const summary = message("compacted frontier");
  const legacyCompact = vi.fn<ContextEngine["compact"]>(async () => {
    host = [summary];
    return { ok: true, compacted: true, result: { tokensBefore: 200, tokensAfter: 10 } };
  });
  const compact = vi
    .fn<ContextEngine["compact"]>()
    .mockRejectedValueOnce(new Error("one-shot engine failure"))
    .mockImplementation(async () => {
      frontier = [summary];
      return { ok: true, compacted: true, result: { tokensBefore: 200, tokensAfter: 10 } };
    });
  const registry = runtime.snapshot.pluginRegistry;
  registerContextEngineInRegistry(
    registry,
    "legacy",
    () => ({
      info: { id: "legacy", name: "Legacy fixture" },
      ingest: async () => ({ ingested: false }),
      assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
      compact: legacyCompact,
    }),
    "core",
    { allowSameOwnerRefresh: true },
  );
  registerContextEngineInRegistry(
    registry,
    "frontier",
    () => ({
      info: { id: "frontier", name: "Independent frontier", ownsCompaction: true },
      ingest: async () => ({ ingested: false }),
      assemble: async () => ({ messages: frontier, estimatedTokens: frontier.length * 10 }),
      compact,
    }),
    "plugin:frontier",
  );
  const work = new AsyncWorkScope();
  try {
    await work.run(() =>
      withPluginRuntimeGenerationScope(runtime.snapshot, async () => {
        const guarded = await resolveContextEngine(config);
        await expect(
          guarded.compact({ sessionId: target.sessionId, sessionKey: target.sessionKey }),
        ).rejects.toThrow("one-shot engine failure");
        await guarded.dispose?.();
        expect(listContextEngineQuarantines()).toEqual([
          expect.objectContaining({ engineId: "frontier", operation: "compact" }),
        ]);
        const compactParams = {
          ...target,
          sessionTarget: target,
          sessionFile: target.sessionKey,
          workspaceDir,
          config,
          provider: "openai",
          model: "fixture",
          trigger: "manual",
        } satisfies Parameters<typeof compactEmbeddedAgentSession>[0];
        const result = await compactEmbeddedAgentSession(compactParams);
        expect(result).toMatchObject({ ok: true, compacted: true });
        const nextTurn = await createContextEngineLogicalTurnLease({
          identity: { runId: "next", sessionId: target.sessionId },
          config,
        });
        try {
          const assembled = await nextTurn
            .begin()
            .engine.assemble({ sessionId: target.sessionId, messages: host });
          expect.soft(assembled.messages).toEqual([summary]);
          expect.soft(compact).toHaveBeenCalledTimes(2);
          expect.soft(legacyCompact).not.toHaveBeenCalled();
          expect(listContextEngineQuarantines()).toHaveLength(1);
        } finally {
          await nextTurn.dispose();
        }
        compact.mockRejectedValueOnce(new Error("compact interrupted after start"));
        await expect(compactEmbeddedAgentSession(compactParams)).resolves.toMatchObject({
          ok: false,
          compacted: false,
          reason: "compact interrupted after start",
        });
        expect(compact).toHaveBeenCalledTimes(3);
        expect(legacyCompact).not.toHaveBeenCalled();
        await expect(compactEmbeddedAgentSession(compactParams)).resolves.toMatchObject({
          ok: true,
          compacted: true,
        });
        expect(compact).toHaveBeenCalledTimes(4);
        expect(listContextEngineQuarantines()).toHaveLength(1);
      }),
    );
  } finally {
    await AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => work.drain(),
    );
  }
});
