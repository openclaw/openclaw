import path from "node:path";
import { expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../../test/helpers/sqlite-worker-fault.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { useCompletionDatabase } from "../completion/completion-database.test-support.js";
import { records } from "../completion/subagent-completion-admission.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { discardExpiredSubagentDelivery } from "./subagent-registry-suspended-delivery.js";

const fault = useSqliteWorkerFault([
  {
    name: "reject_expiry_notice",
    match: /^insert into transcript_events\b/iu,
    sql: `CREATE TEMP TRIGGER reject_expiry_notice BEFORE INSERT ON main.transcript_events
    BEGIN SELECT RAISE(ABORT, 'transient expiry notice failure'); END`,
  },
]);
useCompletionDatabase("openclaw-expiry-notice-retry-");

it.each([true, false])(
  "retains expiry outcome and deduplicates after bookkeeping failure (explicit requester agent: %s)",
  async (explicitAgent) => {
    const { subagent: entry } = records();
    if (!explicitAgent) entry.requesterAgentId = undefined;
    const storePath = path.join(process.env.OPENCLAW_STATE_DIR!, "sessions.json");
    const scope = {
      agentId: "main",
      sessionKey: entry.requesterSessionKey,
      sessionId: "expiry-requester",
      storePath,
    };
    await replaceSessionEntry(scope, {
      sessionId: scope.sessionId,
      lifecycleRevision: "original",
      updatedAt: Date.now(),
    });
    Object.assign(entry, {
      requesterStorePath: storePath,
      retainAttachmentsOnKeep: true,
      delivery: { status: "suspended", suspendedAt: 1, suspendedReason: "expiry" },
    });
    subagentRuns.set(entry.runId, entry);
    let current = true;
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error("bookkeeping unavailable"))
      .mockResolvedValue(undefined);
    const hook = vi.fn();
    const params: Parameters<typeof discardExpiredSubagentDelivery>[0] = {
      runId: entry.runId,
      entry,
      now: Date.now(),
      resumedRuns: new Set(),
      clearPendingLifecycleError: vi.fn(),
      clearPendingLifecycleTimeout: vi.fn(),
      discardTerminalDelivery: vi.fn(),
      completeCleanupBookkeeping: complete,
      isCurrent: () => current,
      isNoticeCurrent: () => current && subagentRuns.has(entry.runId),
      sessionEffectsHostCurrent: () => true,
      shouldSuppressSessionEffects: async () => false,
      shouldEmitEndedHookForRun: () => false,
      emitSubagentEndedHookForRun: hook,
      warn: vi.fn(),
    };
    const notices = async () =>
      (await loadTranscriptEvents(scope)).filter(
        (event) =>
          event.type === "custom_message" && event.customType === "run-failed-before-reply",
      );
    try {
      fault.enable();
      await expect(discardExpiredSubagentDelivery(params)).rejects.toThrow(
        "transient expiry notice failure",
      );
      expect(complete).not.toHaveBeenCalled();
      expect(entry.execution.outcome).toEqual({ status: "ok" });
      expect(entry.delivery?.status).toBe("suspended");
      expect(await notices()).toHaveLength(0);
      fault.disable();
      current = false;
      await expect(discardExpiredSubagentDelivery(params)).rejects.toThrow("cleanup owner changed");
      expect(await notices()).toHaveLength(0);
      current = true;
      subagentRuns.clear();
      await expect(discardExpiredSubagentDelivery(params)).rejects.toThrow("notice owner changed");
      expect(await notices()).toHaveLength(0);
      subagentRuns.set(entry.runId, entry);
      await expect(discardExpiredSubagentDelivery(params)).rejects.toThrow(
        "bookkeeping unavailable",
      );
      expect(await notices()).toHaveLength(1);
      await discardExpiredSubagentDelivery(params);
      const visible = await notices();
      expect(visible).toHaveLength(1);
      expect(JSON.stringify(visible[0])).toContain("canonical result");
      expect(complete).toHaveBeenCalledTimes(2);
      expect(hook).not.toHaveBeenCalled();
    } finally {
      fault.disable();
    }
  },
);
