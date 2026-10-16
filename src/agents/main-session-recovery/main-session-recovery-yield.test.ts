import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { recordLifecycleFence } from "../../config/sessions/restart-recovery-state.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { createSubagentRunRecord } from "../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../subagents/registry/subagent-registry-memory.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { claimMainSessionRecoveryOwner } from "./main-session-recovery-store.js";
import { createMainSessionRecoveryStoreFixture } from "./main-session-recovery-store.test-support.js";

describe("yielded requester admission", () => {
  const sessionKey = "agent:main:main";
  let storePath: string;
  let lifecycleGeneration: string;
  const { fixtureStore, resetCase } = createMainSessionRecoveryStoreFixture();
  const write = (entry: SessionEntry) =>
    sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
  const read = () => sessionAccessor.loadSessionEntry({ sessionKey, storePath })!;
  const claimRecovery = (overrides: { runId?: string } = {}) =>
    claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
      ...overrides,
    });

  const child = createSubagentRunRecord({
    runId: "yielded-child",
    childSessionKey: "agent:main:subagent:yielded-child",
    requesterSessionKey: sessionKey,
    requesterAgentId: "main",
    expectsCompletionMessage: true,
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: ["yielded-child"],
    },
  });

  beforeEach(async () => {
    storePath = fixtureStore();
    lifecycleGeneration = getAgentEventLifecycleGeneration();
    child.requesterTurnRunId = undefined;
    subagentRuns.set(child.runId, child);
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      abortedLastRun: false,
      endedAt: 1000,
      activeWriterRunId: "yielded-run",
      lifecycleRunId: "yielded-run",
      restartRecoveryRuns: [{ runId: "yielded-run", lifecycleGeneration }],
      restartRecoveryTerminalRunIds: ["previous-terminal-run"],
    });
  });

  afterEach(async () => {
    subagentRuns.delete(child.runId);
    vi.restoreAllMocks();
    await resetCase();
  });

  it.each(["current", "previous"])(
    "transfers a %s-generation yielded fence before admitting successive turns",
    async (generation) => {
      if (generation === "previous") {
        await write({
          ...read(),
          restartRecoveryRuns: [
            { runId: "yielded-run", lifecycleGeneration: "previous-generation" },
          ],
        });
      }
      await expect(claimRecovery({ runId: "settle-run" })).resolves.toMatchObject({
        kind: "not_required",
      });
      expect(read().restartRecoveryRuns).toBeUndefined();
      expect(subagentRuns.get(child.runId)).toBe(child);
      expect(child.requesterTurnRunId).toBeUndefined();
      expect(child.requesterSettleWake?.batchRunIds).toEqual([child.runId]);

      child.requesterTurnRunId = "settle-run";
      const started = read();
      recordLifecycleFence(started, { runId: "settle-run", lifecycleGeneration });
      await write(started);
      const settled = projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: lifecycleGeneration,
        entry: read(),
        event: { runId: "settle-run", lifecycleGeneration, data: { phase: "end" } },
        snapshotPatch: { status: "done", endedAt: 2000 },
      });
      expect(settled.action).toBe("apply");
      if (settled.action === "apply") {
        await write({ ...read(), ...settled.patch });
      }
      subagentRuns.delete(child.runId);
      await expect(claimRecovery({ runId: "later-user-run" })).resolves.toMatchObject({
        kind: "not_required",
      });
      expect(read().restartRecoveryRuns).toBeUndefined();
    },
  );

  it.each(["absent", "adopted"])("keeps fencing %s child custody", async (custody) => {
    if (custody === "absent") {
      subagentRuns.delete(child.runId);
    } else {
      child.requesterTurnRunId = "adopting-turn";
    }
    await expect(claimRecovery()).resolves.toMatchObject({ kind: "invalidated" });
    expect(read().restartRecoveryRuns).toEqual([{ runId: "yielded-run", lifecycleGeneration }]);
  });

  it.each([
    { mainRestartRecovery: { cycleId: "debt", revision: 1, chargedAttempts: 0 } },
    { restartRecoveryDeliveryRunId: "delivery-run" },
    { restartRecoveryRuns: [{ runId: "other-run", lifecycleGeneration: "other-generation" }] },
    { lifecycleRunId: "other-run" },
  ] satisfies Partial<SessionEntry>[])("preserves separate custody: %j", async (debt) => {
    await write({ ...read(), ...debt });
    const before = read();
    await expect(claimRecovery()).resolves.toMatchObject({ kind: "invalidated" });
    expect(read()).toEqual(before);
  });

  it("rejects a handoff if the child batch is adopted before commit", async () => {
    const replace = sessionAccessor.applySessionEntryReplacements;
    vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation((params) =>
      replace({
        ...params,
        update: async (entries) => {
          const result = await params.update(entries);
          child.requesterTurnRunId = "competing-turn";
          return result;
        },
      }),
    );
    await expect(claimRecovery()).rejects.toThrow("continuation changed before recovery handoff");
    expect(read().restartRecoveryRuns).toEqual([{ runId: "yielded-run", lifecycleGeneration }]);
  });
});
