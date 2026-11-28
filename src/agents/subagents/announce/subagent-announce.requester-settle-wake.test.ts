import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { sessionControllerMailboxes } from "../../../sessions/session-controller.mailbox.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import { recordRequesterDelivery as recordRequesterDeliveryFact } from "../registry/subagent-delivery-state.js";
import {
  sessionStore,
  setSessionStore,
  registryRuntimeMock,
  readDescendantFacts,
  findTranscriptEventMock,
  listedRequesterRuns,
  wakeParams,
} from "./subagent-announce.requester-settle-fixture.test-support.js";
import {
  requesterSettleKey,
  deliverSpy,
  makeSettledChild,
  completeBatchSpy,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

function assistant(runId: string | undefined, text: string | undefined, metadata = {}) {
  return {
    type: "message",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      __openclaw: { runId },
      ...metadata,
    },
  };
}
type Child = ReturnType<typeof makeSettledChild>;
const wake = (overrides: Parameters<typeof wakeParams>[0] = {}) =>
  maybeWakeRequesterAfterAllChildrenSettled(wakeParams(overrides));
const wakeState = (batchRunIds?: string[]): Child["requesterSettleWake"] => ({
  status: "pending",
  attemptCount: 0,
  requesterYieldBatch: true,
  rearmGeneration: 1,
  ...(batchRunIds && { batchRunIds }),
});
const completion = (text: string, modelRouteChange?: string): Child["completion"] => ({
  required: true,
  ...(!modelRouteChange && { resultText: text }),
  terminalReply: { disposition: "visible", text, ...(modelRouteChange && { modelRouteChange }) },
});
function setChildren(children = ["run-a", "run-b"].map((runId) => makeSettledChild({ runId }))) {
  registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
  return children;
}
function transcriptsFor(children: Child[], events: (child: Child) => unknown[]) {
  const transcripts = new Map(
    children.map((child) => {
      const sessionId = `session-${child.runId}`;
      sessionStore[child.childSessionKey] = { sessionId };
      return [sessionId, events(child)] as const;
    }),
  );
  findTranscriptEventMock.mockImplementation(async ({ sessionId }, match) => {
    expect(transcripts.has(sessionId)).toBe(true);
    const event = transcripts
      .get(sessionId)
      ?.findLast((candidate) => matchesTranscriptEvent(candidate, match));
    return event === undefined ? undefined : { event };
  });
}
function expectMessage(included: string[], excluded: string[] = []) {
  const message = String(deliveredCallArg().triggerMessage);
  for (const text of included) {
    expect(message).toContain(text);
  }
  for (const text of excluded) {
    expect(message).not.toContain(text);
  }
  return message;
}
async function expectNoWake(overrides: Parameters<typeof wakeParams>[0] = {}) {
  expect(await wake(overrides)).toBe(false);
  expect(deliverSpy).not.toHaveBeenCalled();
}
async function expectWake(overrides: Parameters<typeof wakeParams>[0] = {}) {
  expect(await wake(overrides)).toBe(true);
  expect(deliverSpy).toHaveBeenCalledOnce();
  return deliveredCallArg();
}
function prepareDispatch(params: Parameters<typeof deliverSpy>[0]) {
  if (typeof params.onBeforeDispatch !== "function") {
    throw new Error("expected completion dispatch preparation");
  }
  return params.onBeforeDispatch();
}
describe("maybeWakeRequesterAfterAllChildrenSettled", () => {
  it.each([false, true])(
    "retains all completion results when requester execution aborts (consumed=%s)",
    async (consumed) => {
      const children = setChildren(
        ["run-a", "run-b", "run-c"].map((runId) =>
          makeSettledChild({
            runId,
            completion: completion(`Saved result from ${runId}`),
            requesterSettleWake: wakeState(["run-a", "run-b", "run-c"]),
          }),
        ),
      );
      deliverSpy.mockImplementationOnce(async (params) => {
        await prepareDispatch(params);
        if (consumed) {
          const input = [...sessionControllerMailboxes()][0]!.entries[0]!;
          await input.onTranscriptCommitted!("aborted-settle-turn");
        }
        return {
          delivered: false,
          path: "direct",
          error: "requester execution aborted",
        };
      });
      expect(
        await wake({
          recordRequesterDelivery: async (batch, fact, onPublished) => {
            for (const entry of batch) {
              recordRequesterDeliveryFact(entry, fact);
            }
            onPublished(batch);
          },
        }),
      ).toBe(consumed);
      if (consumed) {
        expect(
          children.every((child) => child.delivery?.requesterDelivery?.state === "consumed"),
        ).toBe(true);
      }
      expectMessage(children.map((entry) => `Saved result from ${entry.runId}`));
      expect(children.map((entry) => entry.completion?.resultText)).toEqual([
        "Saved result from run-a",
        "Saved result from run-b",
        "Saved result from run-c",
      ]);
      expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-a", "run-b", "run-c"], 1, {
        delivered: false,
        path: "direct",
        error: "requester execution aborted",
      });
    },
  );

  it("preserves delivered replies when consumption bookkeeping fails", async () => {
    setChildren();
    const failure = new Error("consumption registry write failed");
    deliverSpy.mockImplementationOnce(async (params) => {
      await prepareDispatch(params);
      const input = [...sessionControllerMailboxes()][0]!.entries[0]!;
      await expect(input.onTranscriptCommitted!("requester-continuation")).rejects.toBe(failure);
      expect(input.custody.failure).toBe(failure);
      return { delivered: true, path: "direct" };
    });
    await expectWake({
      recordRequesterDelivery: async () => {
        throw failure;
      },
    });
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-a", "run-b"], undefined, {
      delivered: true,
      path: "direct",
    });
  });

  it("retires its unadopted input when dispatch and waiting publication are rejected", async () => {
    setChildren();
    const failure = new Error("Requester wake batch changed before its outcome was recorded");
    deliverSpy.mockImplementationOnce(async (params) => {
      await prepareDispatch(params);
      throw new Error("unreachable");
    });
    await expect(
      wake({
        transitionBatch: async () => {
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect([...sessionControllerMailboxes()].flatMap((mailbox) => mailbox.entries)).toEqual([]);
  });

  it("preserves route notices from compacted completed siblings in the requester message", async () => {
    const { compactSubagentRunForMemory } = await import("../registry/subagent-registry-memory.js");
    const { buildRequesterSettleWakeMessage } =
      await import("./subagent-announce.requester-settle-message.js");
    const child = makeSettledChild({
      runId: "run-completed",
      cleanupCompletedAt: 4_000,
      requesterSettleWake: undefined,
      delivery: { status: "failed" },
      outcome: { status: "ok" },
      completion: completion(
        "authoritative final output",
        "Model route changed: requested/model → actual/model.",
      ),
    });
    const compact = compactSubagentRunForMemory(child);
    const message = (children: Child[]) =>
      buildRequesterSettleWakeMessage({
        children,
        findings: "worker-hydrated child findings",
        requireVisibleReply: true,
        requesterOrigin: { channel: "discord", to: "channel:shared" },
        completionChannel: "discord",
      });
    const result = message([compact]);
    expect(result).toBe(message([child]));
    expect(result).toContain("Model route changed: requested/model → actual/model.");
    expect(result).toContain(
      "Keep this runtime-authored model-route change notice internal on this shared surface.",
    );
    expect(result).toContain("worker-hydrated child findings");
  });

  it.each(["public", "private", "yielded-private"] as const)(
    "replays the same raw %s input when a pending sibling settles during restart",
    async (kind) => {
      const child = makeSettledChild({
        runId: "run-b",
        completionTarget: kind === "public" ? undefined : "parent",
        completion: completion("original child result"),
        requesterSettleWake: {
          ...wakeState(["run-a", "run-b"])!,
          ...(kind === "yielded-private" ? { yieldedFinalDeliverable: true } : {}),
        },
      });
      const sibling = makeSettledChild({
        runId: "run-a",
        execution: { status: "running", startedAt: 2_000 },
        requesterSettleWake: { ...child.requesterSettleWake! },
      });
      setChildren([sibling, child]);
      const stop = new AbortController();
      deliverSpy.mockImplementationOnce(async (params) => {
        await prepareDispatch(params);
        stop.abort();
        return { delivered: false, path: "direct" };
      });
      expect(await wake({ signal: stop.signal })).toBe(false);
      const first = deliveredCallArg();
      expect(first.triggerMessage).toContain("1 other subagent(s)");
      expect(child.requesterSettleWake?.status).toBe("dispatching");

      sibling.execution = { status: "terminal", endedAt: 4_000, outcome: { status: "ok" } };
      // Later result reads must not reconstruct the already admitted request.
      child.completion = completion("updated child result");
      expect(await wake()).toBe(true);
      const replay = deliverSpy.mock.calls[1]?.[0];
      expect(replay?.directIdempotencyKey).toBe(first.directIdempotencyKey);
      expect(replay?.triggerMessage).toBe(first.triggerMessage);
      expect(replay?.triggerMessage).toContain("original child result");
    },
  );

  it("waits for descendant events without writes and retains one terminal-delivery deadline", async () => {
    const child = makeSettledChild({
      runId: "run-a",
      delivery: { status: "pending" },
      requesterSettleWake: wakeState(["run-a"]),
    });
    setChildren([child]);
    readDescendantFacts.mockResolvedValue({ unsettled: true, active: 1 });
    const onDescendantsPending = vi.fn();
    const transitionBatch = vi.fn(wakeParams().transitionBatch);
    const settle = () => wake({ settledEntry: child, onDescendantsPending, transitionBatch });
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await expect(settle()).resolves.toBe(false);
      expect(onDescendantsPending).toHaveBeenLastCalledWith(undefined);
      expect(transitionBatch).not.toHaveBeenCalled();
      readDescendantFacts.mockResolvedValue({
        unsettled: true,
        active: 0,
        deliveryWaitUntil: 300_000,
      });
      await expect(settle()).resolves.toBe(false);
      expect(onDescendantsPending).toHaveBeenLastCalledWith(300_000);
      expect(transitionBatch).not.toHaveBeenCalled();
      expect(deliverSpy).not.toHaveBeenCalled();
      // Reopening the durable rows cannot recharge the deadline.
      const restored = structuredClone(child);
      setChildren([restored]);
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(wake({ settledEntry: restored, onDescendantsPending })).resolves.toBe(true);
      expect(deliverSpy).toHaveBeenCalledOnce();
      expect(String(deliveredCallArg().triggerMessage)).toContain(
        "a descendant result below it was still undelivered when waiting stopped",
      );
      expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-a"], 1, {
        delivered: true,
        path: "direct",
      });
    } finally {
      vi.useRealTimers();
    }
  });
  it("lets a healthy sibling decide while an earlier descendant read loses its source", async () => {
    const children = setChildren();
    const readStarted = createDeferred();
    const staleRead = createDeferred<undefined>();
    readDescendantFacts.mockImplementationOnce(() => {
      readStarted.resolve();
      return staleRead.promise;
    });
    const first = wake({ settledEntry: children[0] });
    try {
      await readStarted.promise;
      await expect(wake({ settledEntry: children[1] })).resolves.toBe(true);
      expect(deliverSpy).toHaveBeenCalledOnce();
    } finally {
      staleRead.resolve(undefined);
      await expect(first).resolves.toBe(false);
    }
  });
  it("includes the whole connected drained wave for a staggered fan-out", async () => {
    // A overlaps B and B overlaps C, but A never overlaps C.
    const resultPrefix = "<result>".repeat(700);
    const timings = [
      ["run-a", 1_000, 1_000, 2_000],
      ["run-b", 1_500, 2_100, 3_000],
      ["run-c", 2_500, 2_500, 4_000],
    ] as const;
    const children = timings.map(([runId, createdAt, startedAt, endedAt]) =>
      makeSettledChild({ runId, createdAt, startedAt, endedAt, outcome: { status: "ok" } }),
    );
    const findings = ["alpha findings", "bravo findings", "charlie findings"];
    transcriptsFor(children, (child) => {
      const index = children.indexOf(child);
      const text = `${resultPrefix}${findings[index]}`;
      child.completion = {
        required: true,
        terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
        resultText: text,
      };
      return [
        assistant("previous-run", "stale previous result"),
        assistant(child.runId, "earlier commentary"),
        assistant(child.runId, text),
        assistant("replacement-run", "unrelated later result"),
        assistant(child.runId, "unfinished follow-up", { stopReason: "toolUse" }),
      ];
    });
    setChildren(children);
    const call = await expectWake({ settledEntry: children[2] });
    expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b,run-c"));
    const message = expectMessage(
      findings.map((result) => `${resultPrefix}${result}`),
      [
        "stale previous result",
        "earlier commentary",
        "unrelated later result",
        "unfinished follow-up",
      ],
    );
    expect(message.indexOf("alpha findings")).toBeLessThan(message.indexOf("bravo findings"));
    expect(message.indexOf("bravo findings")).toBeLessThan(message.indexOf("charlie findings"));
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(
      ["run-a", "run-b", "run-c"],
      undefined,
      { delivered: true, path: "direct" },
    );
  });
  it("ignores long-settled children from earlier non-overlapping spawns", async () => {
    setChildren([
      makeSettledChild({ runId: "run-old-1", createdAt: 100, startedAt: 100, endedAt: 200 }),
      makeSettledChild({ runId: "run-old-2", createdAt: 100, startedAt: 110, endedAt: 250 }),
      makeSettledChild({ runId: "run-b", delivery: { status: "delivered" } }),
    ]);
    await expectNoWake();
  });
  it("does not wake while other children still await settle", async () => {
    const children = setChildren();
    readDescendantFacts.mockResolvedValue({ unsettled: true, active: 0 });
    await expectNoWake({ settledEntry: children[1] });
    expect(readDescendantFacts).toHaveBeenCalledOnce();
  });
  it("skips cron requester sessions", async () => {
    await expectNoWake({ requesterSessionKey: "agent:main:cron:daily-report" });
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-b"]);
  });
  it("skips requesters whose session entry is gone", async () => {
    setSessionStore({});
    setChildren();
    await expectNoWake();
  });
  it("does not wake a yielded requester while its frozen child has no end timestamp", async () => {
    const activeChild = makeSettledChild({
      runId: "run-b",
      execution: { status: "terminal", startedAt: 2_000 },
      delivery: { status: "pending" },
      requesterSettleWake: wakeState(["run-b"]),
    });
    setChildren([activeChild]);
    await expectNoWake({ settledEntry: activeChild });
    expect(completeBatchSpy).not.toHaveBeenCalled();
  });
  it("does not revive captured fallback output after a resumed completion returns NO_REPLY", async () => {
    setChildren([
      makeSettledChild({
        runId: "run-b",
        delivery: { status: "failed" },
        completion: {
          required: true,
          terminalReply: { disposition: "silent" },
          resultText: "NO_REPLY",
          fallbackResultText: "findings captured before the wake",
        },
        outcome: { status: "ok" },
      }),
    ]);
    expect(await wake()).toBe(true);
    expectMessage(
      ["(no output)"],
      ["findings captured before the wake", "<prompt-data>\nNO_REPLY\n</prompt-data>"],
    );
  });
  it("keeps producer-owned route evidence internal on a shared surface", async () => {
    const terminalReply = {
      disposition: "visible",
      text: "authoritative final output",
      modelRouteChange: "Model route changed: requested/model → actual/model.",
    } as const;
    setChildren([
      makeSettledChild({ runId: "run-b" }),
      ...["run-a", "run-c"].map((runId) =>
        makeSettledChild({
          runId,
          delivery: { status: "failed" },
          completion: {
            required: true,
            resultText: "stale child output",
            fallbackResultText: "stale retained findings",
            terminalReply,
          },
          outcome: { status: "ok" },
        }),
      ),
    ]);
    transcriptsFor(listedRequesterRuns(), (child) => [assistant(child.runId, terminalReply.text)]);
    await expectWake({ requesterOrigin: { channel: "discord", to: "channel:shared" } });
    const message = expectMessage(
      [
        terminalReply.text,
        "Keep this runtime-authored model-route change notice internal on this shared surface.",
      ],
      ["stale retained findings", "stale child output"],
    );
    expect(message.split(terminalReply.modelRouteChange)).toHaveLength(2);
  });
  it("bounds sorted route notices and excludes superseded child owners", async () => {
    const children = Array.from({ length: 8 }, (_, index) =>
      makeSettledChild({
        runId: `run-${index}`,
        completion: completion(
          "done",
          `Model route changed: requested/${index} → actual/${"x".repeat(260)}.`,
        ),
      }),
    ).toReversed();
    const staleChild = makeSettledChild({
      runId: "run-stale",
      completion: completion("stale output", "Model route changed: old/owner → stale/route."),
    });
    setChildren([staleChild, ...children]);
    registryRuntimeMock.getLatestLiveSubagentRunByChildSessionKey.mockImplementation(
      (sessionKey) =>
        sessionKey === staleChild.childSessionKey
          ? { ...staleChild, runId: "run-replacement", requesterSessionKey: "agent:other:main" }
          : undefined,
    );
    await expectWake({ settledEntry: staleChild });
    const message = expectMessage([], ["stale output", "old/owner"]);
    const routeBlock = message.slice(
      message.indexOf("Model route changed:"),
      message.indexOf("\n[Subagent Context] Preserve this runtime-authored"),
    );
    expect(routeBlock).toMatch(/^Model route changed: requested\/0/u);
    expect(routeBlock).toContain("requested/1");
    expect(routeBlock).toContain("[model-route changes truncated]");
    expect(routeBlock.length).toBeLessThanOrEqual(1_024);
  });
  it("stays out of pure fire-and-forget batches", async () => {
    const requesterTurnRunId = "requester-cancellation-owner";
    const children = ["run-a", "run-b"].map((runId) =>
      makeSettledChild({
        runId,
        requesterTurnRunId,
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
    );
    setChildren(children);
    await expectNoWake();
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"]);
    expect(children.map((child) => child.requesterTurnRunId)).toEqual([
      requesterTurnRunId,
      requesterTurnRunId,
    ]);
  });
  it("delivers the complete final source reply after a same-run silent terminal", async () => {
    const text = `${"<source-reply>".repeat(400)}required source reply tail`;
    const child = makeSettledChild({
      runId: "run-b",
      outcome: { status: "ok" },
      completion: {
        required: true,
        terminalReply: prepareAgentRunTerminalReply({ rawText: text }).terminalReply,
        resultText: text,
      },
      requesterSettleWake: wakeState(),
    });
    transcriptsFor([child], () => [
      assistant("previous-run", "stale source reply"),
      assistant(child.runId, text, {
        openclawDeliveryMirror: { kind: "message-tool-source-reply", final: true },
      }),
      assistant(child.runId, "NO_REPLY"),
      assistant("replacement-run", "unrelated source reply"),
    ]);
    setChildren([child]);
    expect(await wake()).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    expectMessage([text], ["NO_REPLY", "stale source reply", "unrelated source reply"]);
    expect(call.requireVisibleReply).toBe(true);
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-b"], 1, {
      delivered: true,
      path: "direct",
    });
  });
});
