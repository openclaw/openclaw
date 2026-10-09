import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner } from "../registry/subagent-run-generation.js";
import { transferFollowupCohort } from "./session-followup-cohort.js";
import {
  SessionFollowupCompletion,
  getFollowupForCohort,
  promoteFollowupYield,
} from "./session-followup-completion.js";

const opened: SessionFollowupCompletion[] = [];
afterEach(() => {
  for (const owner of opened.splice(0)) {
    owner.close();
  }
  vi.useRealTimers();
});

function fixture() {
  const controller = new AbortController();
  const release = vi.fn();
  const owner = SessionFollowupCompletion.bind({
    runId: "first",
    requesterSessionKey: "A",
    requesterSessionId: "A-session",
    requesterAgentId: "main",
    targetAgentId: "main",
    targetSessionKey: "B",
    custody: {
      signal: controller.signal,
      release,
      assertCurrent: () => controller.signal.throwIfAborted(),
      run: (run) => {
        controller.signal.throwIfAborted();
        return run();
      },
    },
  });
  owner.markAccepted("first");
  opened.push(owner);
  return { owner, controller, release };
}

function child(generation = 1): SubagentRunRecord {
  return {
    runId: "C",
    childSessionKey: "C-session",
    requesterSessionKey: "B",
    requesterDisplayKey: "B",
    task: "nested",
    cleanup: "keep",
    createdAt: 2,
    execution: { status: "terminal", endedAt: 3, outcome: { status: "ok" } },
    requesterSettleWake: {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: generation,
      batchRunIds: ["C"],
    },
  };
}

async function settleExecution(
  owner: SessionFollowupCompletion,
  runId: string,
  reply: Parameters<SessionFollowupCompletion["settle"]>[1],
  beforeFinish?: () => Promise<void>,
) {
  const decision = await owner.settle(runId, reply);
  await beforeFinish?.();
  owner.finishExecution(runId);
  return decision;
}

const final = {
  status: "ok" as const,
  endedAt: 4,
  terminalReply: { disposition: "visible" as const, text: "B_DONE" },
  replyText: "B_DONE",
};

describe("session followup completion", () => {
  it.each(["replacement", "cleared wake", "cleared adopted wake"] as const)(
    "retains only the canonical committed cohort after publication: %s",
    async (publication) => {
      const f = fixture();
      const c = child();
      f.owner.promoteYield("first", [c], 1);
      await settleExecution(f.owner, "first", { status: "ok", yielded: true });
      const successor = f.owner.successor([c], "second", () => {});
      await f.owner.prepareSuccessor(successor);
      if (publication === "cleared adopted wake") {
        f.owner.adopt(successor);
        f.owner.markAccepted("second");
      }
      const published =
        publication === "replacement"
          ? { ...c, runId: "C-next", taskRunId: c.runId }
          : copySubagentRunRuntimeOwner(c, {
              ...c,
              requesterSettleWake: undefined,
              suppressCompletionDelivery: true,
            });
      transferFollowupCohort(c, published);
      expect(getFollowupForCohort([published])).toBe(f.owner);
      if (publication === "replacement") {
        expect(() => f.owner.successor([published], "second", () => {})).not.toThrow();
        expect(() => f.owner.successor([c], "second", () => {})).toThrow("cohort");
      } else {
        expect(() => successor.assertCurrent()).toThrow("completion cohort");
        expect(() => f.owner.successor([published], "second", () => {})).toThrow(
          "completion cohort",
        );
      }
    },
  );

  it("publishes to exactly one consumer after the caller joins physical execution cleanup", async () => {
    const f = fixture();
    const cleanupEntered = createDeferred();
    const cleanupReleased = createDeferred();
    let published = false;
    const taken = f.owner.take().then((reply) => {
      published = true;
      return reply;
    });
    const settled = settleExecution(f.owner, "first", final, async () => {
      cleanupEntered.resolve();
      await cleanupReleased.promise;
    });
    try {
      await Promise.race([
        cleanupEntered.promise,
        settled.then(() => {
          throw new Error("Completion skipped the caller's cleanup boundary");
        }),
      ]);
      expect(published).toBe(false);
      cleanupReleased.resolve();
      expect(await settled).toEqual({ kind: "terminal", reply: final });
      await expect(taken).resolves.toEqual(final);
      expect(published).toBe(true);
      await expect(f.owner.take()).rejects.toThrow("consumer");
    } finally {
      cleanupReleased.resolve();
      await Promise.allSettled([settled]);
      f.owner.close();
      await Promise.allSettled([taken]);
    }
  });

  it.each(["terminal", "uncommitted yield", "inline timeout"] as const)(
    "settles only the admitted successor across committed yields: %s",
    async (mode) => {
      const f = fixture();
      if (mode === "inline timeout") {
        vi.useFakeTimers();
        const inline = f.owner.take(10);
        await vi.advanceTimersByTimeAsync(10);
        await expect(inline).resolves.toBeUndefined();
      }
      const asynchronous = mode === "inline timeout" ? f.owner.take() : undefined;
      const chain = ["first", "second", "third"];
      const yields = mode === "inline timeout" ? 2 : 1;
      for (let index = 0; index < yields; index++) {
        const runId = chain[index]!;
        const nextRunId = chain[index + 1]!;
        const c = child(index + 1);
        promoteFollowupYield({
          requesterTurnRunId: runId,
          entries: [c],
          rearmGeneration: index + 1,
        });
        expect(
          await settleExecution(f.owner, runId, {
            status: "ok",
            yielded: true,
            terminalReply: { disposition: "empty" },
          }),
        ).toEqual({ kind: "yielded" });
        const successor = f.owner.successor([c], nextRunId, () => {});
        await f.owner.prepareSuccessor(successor);
        f.owner.adopt(successor);
        f.owner.markAccepted(nextRunId);
      }
      await expect(f.owner.settle("unrelated", final)).rejects.toThrow("replaced");
      await settleExecution(
        f.owner,
        chain[yields]!,
        mode === "uncommitted yield" ? { status: "ok", yielded: true } : final,
      );
      const result = asynchronous ?? f.owner.take();
      if (mode === "uncommitted yield") {
        await expect(result).resolves.toMatchObject({
          status: "error",
          error: expect.stringContaining("without a committed"),
        });
      } else {
        await expect(result).resolves.toEqual(final);
      }
    },
  );

  it.each([
    "source revocation",
    "explicit close",
    "generation retirement",
    "Gateway rotation",
  ] as const)(
    "rejects a waiting successor and retains its cohort tombstone after %s",
    async (retirement) => {
      const f = fixture();
      const c = child();
      f.owner.promoteYield("first", [c], 1);
      await f.owner.settle("first", { status: "ok", yielded: true });
      const successor = f.owner.successor([c], "second", () => {});
      const prepared = expect(f.owner.prepareSuccessor(successor)).rejects.toThrow();
      const rejected =
        retirement === "Gateway rotation" ? expect(f.owner.take()).rejects.toThrow() : undefined;
      if (retirement === "source revocation") {
        f.controller.abort(new Error("Original source revoked"));
      } else if (retirement === "generation retirement") {
        rotateAgentRunRegistryLifecycleGeneration();
        f.owner.finishExecution("first");
      } else if (retirement === "Gateway rotation") {
        f.owner.finishExecution("first");
        rotateAgentEventLifecycleGeneration();
        expect(f.release).toHaveBeenCalledOnce();
      } else {
        f.owner.close();
      }
      await prepared;
      await rejected;
      expect(getFollowupForCohort([c])).toBe(f.owner);
      expect(() => f.owner.successor([c], "second", () => {})).toThrow();
      await expect(f.owner.take()).rejects.toThrow();
      if (retirement !== "generation retirement") {
        expect(f.owner.signal.aborted).toBe(true);
      }
      f.owner.close();
      expect(f.release).toHaveBeenCalledOnce();
    },
  );
});
