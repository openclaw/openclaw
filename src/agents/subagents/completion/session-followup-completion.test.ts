import { ok } from "@openclaw/normalization-core/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { rotateAgentRunRegistryLifecycleGeneration } from "../../../infra/agent-run-registry.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import { transferFollowupCohort } from "./session-followup-cohort.js";
import {
  SessionFollowupCompletion,
  getFollowupForCohort,
  promoteFollowupYield,
} from "./session-followup-completion.js";

const cancelCohort = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("./session-followup-cancellation.js", () => ({ cancelFollowupCohort: cancelCohort }));

const opened: SessionFollowupCompletion[] = [];
beforeEach(() => {
  cancelCohort.mockReset().mockResolvedValue();
});
afterEach(() => {
  for (const owner of opened.splice(0)) {
    owner.close();
  }
  vi.useRealTimers();
});

async function fixture() {
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

function requireTerminalCancellation(
  result: Awaited<ReturnType<SessionFollowupCompletion["cancel"]>>,
) {
  if (!result.ok || result.value.kind !== "terminal") {
    throw new Error("Expected the paused cohort's terminal cancellation decision");
  }
  return result.value;
}

const final = {
  status: "ok" as const,
  endedAt: 4,
  terminalReply: { disposition: "visible" as const, text: "B_DONE" },
  replyText: "B_DONE",
};

describe("session followup completion", () => {
  it("requires a fresh committed cohort when an admitted successor yields again", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    expect(await settleExecution(f.owner, "first", { status: "ok", yielded: true })).toEqual({
      kind: "yielded",
    });
    const next = f.owner.successor([c], "second", () => {});
    await f.owner.prepareSuccessor(next);
    f.owner.adopt(next);
    f.owner.markAccepted("second");
    await settleExecution(f.owner, "second", { status: "ok", yielded: true });
    await expect(f.owner.take()).resolves.toMatchObject({
      status: "error",
      error: expect.stringContaining("without a committed"),
    });
  });

  it("cancels the yielded followup without admitting its successor or publishing before caller settlement", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    await settleExecution(f.owner, "first", { status: "ok", yielded: true });
    let published = false;
    const taken = f.owner.take().then((reply) => {
      published = true;
      return reply;
    });
    const terminal = requireTerminalCancellation(
      await f.owner.cancel("Stopped by requester", () => {}),
    );
    expect(terminal).toMatchObject({
      runId: "first",
      reply: { status: "error", stopReason: "rpc", error: "Stopped by requester" },
    });
    expect(cancelCohort).toHaveBeenCalledWith(expect.objectContaining({ entries: [c] }));
    expect(() => f.owner.successor([c], "second", () => {})).toThrow("cancellation");
    expect(published).toBe(false);
    f.owner.finishExecution(terminal.runId);
    await expect(taken).resolves.toMatchObject({ status: "error", stopReason: "rpc" });
  });

  it("retains an incomplete cancellation intent and permits explicit cancellation reconciliation", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    await settleExecution(f.owner, "first", { status: "ok", yielded: true });
    cancelCohort.mockRejectedValueOnce(new Error("Child stop outcome unknown"));
    await expect(f.owner.cancel("stop", () => {})).resolves.toMatchObject({ ok: false });
    expect(() => f.owner.successor([c], "second", () => {})).toThrow("cancellation");
    const terminal = requireTerminalCancellation(await f.owner.cancel("stop", () => {}));
    expect(cancelCohort).toHaveBeenCalledTimes(2);
    f.owner.finishExecution(terminal.runId);
    await expect(f.owner.take()).resolves.toMatchObject({ status: "error", stopReason: "rpc" });
  });

  it("follows only the canonical child's same-task replacement and rolls it back atomically", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    const next = { ...c, runId: "C-next", taskRunId: c.runId };
    const rollback = transferFollowupCohort(c, next);
    expect(getFollowupForCohort([next])).toBe(f.owner);
    expect(() => f.owner.successor([next], "second", () => {})).not.toThrow();
    rollback();
    expect(() => f.owner.successor([next], "second", () => {})).toThrow("cohort");
    expect(() => f.owner.successor([c], "second", () => {})).not.toThrow();
  });

  it("publishes only after the caller joins required projection and physical execution cleanup", async () => {
    const f = await fixture();
    const projectionEntered = createDeferred();
    const projectionReleased = createDeferred();
    let published = false;
    const taken = f.owner.take().then((reply) => {
      published = true;
      return reply;
    });
    const settled = settleExecution(f.owner, "first", final, async () => {
      projectionEntered.resolve();
      await projectionReleased.promise;
    });
    try {
      await Promise.race([
        projectionEntered.promise,
        settled.then(() => {
          throw new Error("Completion skipped the caller's projection boundary");
        }),
      ]);
      expect(published).toBe(false);
      projectionReleased.resolve();
      expect(await settled).toEqual({ kind: "terminal", reply: final });
      await expect(taken).resolves.toEqual(final);
      expect(published).toBe(true);
    } finally {
      projectionReleased.resolve();
      await Promise.allSettled([settled]);
      f.owner.close();
      await Promise.allSettled([taken]);
    }
  });

  it("returns a non-yielding final to exactly one consumer", async () => {
    const f = await fixture();
    await settleExecution(f.owner, "first", final);
    await expect(f.owner.take()).resolves.toEqual(final);
    await expect(f.owner.take()).rejects.toThrow("consumer");
  });

  it("keeps an empty yielded predecessor pending until its exact admitted successor finishes", async () => {
    const f = await fixture();
    const c = child();
    promoteFollowupYield({ requesterTurnRunId: "first", entries: [c], rearmGeneration: 1 });
    expect(
      await settleExecution(f.owner, "first", {
        status: "ok",
        yielded: true,
        terminalReply: { disposition: "empty" },
      }),
    ).toEqual({ kind: "yielded" });
    const successor = f.owner.successor([c], "second", () => {});
    await f.owner.prepareSuccessor(successor);
    f.owner.adopt(successor);
    f.owner.markAccepted("second");
    await expect(f.owner.settle("unrelated", final)).rejects.toThrow("replaced");
    await settleExecution(f.owner, "second", final);
    await expect(f.owner.take()).resolves.toEqual(final);
  });

  it("transfers an inline timeout to one asynchronous consumer across repeated yields", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const inline = f.owner.take(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(inline).resolves.toBeUndefined();
    const asynchronous = f.owner.take();
    for (const [runId, nextRunId, generation] of [
      ["first", "second", 1],
      ["second", "third", 2],
    ] as const) {
      const c = child(generation);
      promoteFollowupYield({
        requesterTurnRunId: runId,
        entries: [c],
        rearmGeneration: generation,
      });
      await settleExecution(f.owner, runId, { status: "ok", yielded: true });
      const successor = f.owner.successor([c], nextRunId, () => {});
      await f.owner.prepareSuccessor(successor);
      f.owner.adopt(successor);
      f.owner.markAccepted(nextRunId);
    }
    await settleExecution(f.owner, "third", final);
    await expect(asynchronous).resolves.toEqual(final);
  });

  it("does not retain cancellation control from a rejected native activation", async () => {
    const f = await fixture();
    const assertCurrent = vi.fn().mockImplementationOnce(() => {
      throw new Error("Gateway registration replaced");
    });
    const cancel = vi.fn(async () => ok<void, string>(undefined));
    await expect(f.owner.activate("first", { assertCurrent, cancel })).rejects.toThrow(
      "Gateway registration replaced",
    );
    await expect(f.owner.cancel("stop", () => {})).resolves.toMatchObject({ ok: false });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("closes a pending yielded result when the Gateway lifecycle rotates", async () => {
    const f = await fixture();
    const c = child();
    f.owner.promoteYield("first", [c], 1);
    await settleExecution(f.owner, "first", { status: "ok", yielded: true });
    const rejected = expect(f.owner.take()).rejects.toThrow();
    rotateAgentEventLifecycleGeneration();
    try {
      expect(f.release).toHaveBeenCalledOnce();
      expect(f.owner.signal.aborted).toBe(true);
      await rejected;
      expect(getFollowupForCohort([c])).toBe(f.owner);
      expect(() => f.owner.successor([c], "second", () => {})).toThrow();
    } finally {
      f.owner.close();
      await rejected;
    }
  });

  it.each(["source revocation", "explicit close", "generation retirement"] as const)(
    "rejects a waiting successor and retains its cohort tombstone after %s",
    async (retirement) => {
      const f = await fixture();
      const c = child();
      f.owner.promoteYield("first", [c], 1);
      await f.owner.settle("first", { status: "ok", yielded: true });
      const successor = f.owner.successor([c], "second", () => {});
      const prepared = expect(f.owner.prepareSuccessor(successor)).rejects.toThrow();
      if (retirement === "source revocation") {
        f.controller.abort(new Error("Original source revoked"));
      } else if (retirement === "generation retirement") {
        rotateAgentRunRegistryLifecycleGeneration();
        f.owner.finishExecution("first");
      } else {
        f.owner.close();
      }
      await prepared;
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
