import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { copySubagentRunRuntimeOwner as copyOwner } from "../registry/subagent-run-generation.js";
import { transferFollowupCohort } from "./session-followup-cohort.js";
import {
  SessionFollowupCompletion,
  getFollowupForCohort,
  promoteFollowupYield,
} from "./session-followup-completion.js";

let owner: SessionFollowupCompletion;
let controller: AbortController;
const release = vi.fn();
const noop = () => {};
beforeEach(() => {
  controller = new AbortController();
  release.mockClear();
  owner = SessionFollowupCompletion.bind({
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
});
afterEach(() => {
  owner.close();
  vi.useRealTimers();
});

const yielded = { status: "ok", yielded: true, terminalReply: { disposition: "empty" } } as const;

async function yieldCohort(requesterTurnRunId = "first", rearmGeneration = 1, finish = true) {
  const entry: SubagentRunRecord = {
    runId: "C",
    childSessionKey: "C-session",
    requesterSessionKey: "B",
    requesterDisplayKey: "B",
    task: "nested",
    cleanup: "keep",
    createdAt: 2,
    execution: { status: "terminal" },
    requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration },
  };
  promoteFollowupYield({ requesterTurnRunId, entries: [entry], rearmGeneration });
  expect(await owner.settle(requesterTurnRunId, yielded)).toEqual({ kind: "yielded" });
  if (finish) {
    owner.finishExecution(requesterTurnRunId);
  }
  return entry;
}

function successor(entry: SubagentRunRecord, runId = "second") {
  return owner.successor([entry], runId, noop);
}

function adopt(next: ReturnType<typeof successor>) {
  owner.adopt(next);
  owner.markAccepted(next.runId);
}

const final = {
  status: "ok",
  endedAt: 4,
  terminalReply: { disposition: "visible", text: "B_DONE" },
  replyText: "B_DONE",
} as const;

it.each(["replacement", "cleared wake", "cleared adopted wake"] as const)(
  "retains only the canonical committed cohort after publication: %s",
  async (publication) => {
    const c = await yieldCohort();
    const next = successor(c);
    await owner.prepareSuccessor(next);
    if (publication === "cleared adopted wake") {
      adopt(next);
    }
    const published =
      publication === "replacement"
        ? { ...c, runId: "C-next", taskRunId: c.runId }
        : copyOwner(c, { ...c, requesterSettleWake: undefined, suppressCompletionDelivery: true });
    transferFollowupCohort(c, published);
    expect(getFollowupForCohort([published])).toBe(owner);
    if (publication === "replacement") {
      expect(() => successor(published)).not.toThrow();
      expect(() => successor(c)).toThrow("cohort");
    } else {
      expect(() => next.assertCurrent()).toThrow("completion cohort");
      expect(() => successor(published)).toThrow("completion cohort");
    }
  },
);

it("publishes to exactly one consumer after the caller joins physical execution cleanup", async () => {
  const cleanupEntered = createDeferred();
  const cleanupReleased = createDeferred();
  let published = false;
  const taken = owner.take().then((reply) => {
    published = true;
    return reply;
  });
  const settled = (async () => {
    const decision = await owner.settle("first", final);
    cleanupEntered.resolve();
    await cleanupReleased.promise;
    owner.finishExecution("first");
    return decision;
  })();
  try {
    await awaitGateBeforeSettlement(cleanupEntered.promise, settled, "Completion skipped cleanup");
    expect(published).toBe(false);
    cleanupReleased.resolve();
    expect(await settled).toEqual({ kind: "terminal", reply: final });
    await expect(taken).resolves.toEqual(final);
    expect(published).toBe(true);
    await expect(owner.take()).rejects.toThrow("consumer");
  } finally {
    cleanupReleased.resolve();
    await Promise.allSettled([settled]);
    owner.close();
    await Promise.allSettled([taken]);
  }
});

it.each(["terminal", "uncommitted yield", "inline timeout"] as const)(
  "settles only the admitted successor across committed yields: %s",
  async (mode) => {
    if (mode === "inline timeout") {
      vi.useFakeTimers();
      const inline = owner.take(10);
      await vi.advanceTimersByTimeAsync(10);
      await expect(inline).resolves.toBeUndefined();
    }
    const asynchronous = mode === "inline timeout" ? owner.take() : undefined;
    const chain = ["first", "second", "third"];
    const yields = mode === "inline timeout" ? 2 : 1;
    for (let index = 0; index < yields; index++) {
      const runId = chain[index]!;
      const nextRunId = chain[index + 1]!;
      const c = await yieldCohort(runId, index + 1);
      const next = successor(c, nextRunId);
      await owner.prepareSuccessor(next);
      adopt(next);
    }
    await expect(owner.settle("unrelated", final)).rejects.toThrow("replaced");
    await owner.settle(
      chain[yields]!,
      mode === "uncommitted yield" ? { status: "ok", yielded: true } : final,
    );
    owner.finishExecution(chain[yields]!);
    const result = asynchronous ?? owner.take();
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
    const c = await yieldCohort("first", 1, false);
    const prepared = expect(owner.prepareSuccessor(successor(c))).rejects.toThrow();
    const rejected =
      retirement === "Gateway rotation" ? expect(owner.take()).rejects.toThrow() : undefined;
    if (retirement === "source revocation") {
      controller.abort(new Error("Original source revoked"));
    } else if (retirement === "generation retirement") {
      rotateAgentRunRegistryLifecycleGeneration();
      owner.finishExecution("first");
    } else if (retirement === "Gateway rotation") {
      owner.finishExecution("first");
      rotateAgentEventLifecycleGeneration();
      expect(release).toHaveBeenCalledOnce();
    } else {
      owner.close();
    }
    await prepared;
    await rejected;
    expect(getFollowupForCohort([c])).toBe(owner);
    expect(() => successor(c)).toThrow();
    await expect(owner.take()).rejects.toThrow();
    if (retirement !== "generation retirement") {
      expect(owner.signal.aborted).toBe(true);
    }
    owner.close();
    expect(release).toHaveBeenCalledOnce();
  },
);
