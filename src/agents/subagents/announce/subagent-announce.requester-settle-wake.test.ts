// Requester settle wake tests cover the registry-less top-level requester.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { buildAgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.js";
import {
  promoteRequesterFinalAttachment,
  registerRequesterFinalAttachment,
} from "../requester-final-attachment.js";
import type { SubagentAnnounceDeliveryResult as Result } from "./subagent-announce-dispatch.js";
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
  REQUESTER,
  requesterSettleKey,
  deliverSpy,
  makeSettledChild,
  transitionBatchSpy,
  completeBatchSpy,
  deliveredCallArg,
} from "./subagent-announce.requester-settle-wake.test-support.js";

const { maybeWakeRequesterAfterAllChildrenSettled } =
  await import("./subagent-announce.requester-settle-wake.js");

describe("maybeWakeRequesterAfterAllChildrenSettled", () => {
  it("coalesces concurrent row restores without recharging the persisted attempt", async () => {
    const children = ["run-a", "run-b"].map((runId) =>
      makeSettledChild({
        runId,
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          batchRunIds: ["run-a", "run-b"],
        },
      }),
    );
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    const deliveryGate = createDeferred<Result>();
    const deliveryStarted = createDeferred();
    deliverSpy.mockImplementationOnce(() => {
      deliveryStarted.resolve();
      return deliveryGate.promise;
    });

    const wakeA = maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: children[0] }),
    );
    try {
      await deliveryStarted.promise;
      expect(deliverSpy).toHaveBeenCalledOnce();
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[1] })),
      ).resolves.toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();
    } finally {
      deliveryGate.resolve({ delivered: true, path: "direct" });
      await expect(wakeA).resolves.toBe(true);
    }
    expect(deliveredCallArg().directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b"));
    expect(transitionBatchSpy).not.toHaveBeenCalled();
  });

  it.each(["defer", "cancel"] as const)(
    "coalesces sibling wake decisions before the %s write",
    async (decision) => {
      const children = ["run-a", "run-b"].map((runId) =>
        makeSettledChild({
          runId,
          suppressCompletionDelivery: decision === "cancel",
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            requesterYieldBatch: true,
            rearmGeneration: 1,
            batchRunIds: ["run-a", "run-b"],
          },
        }),
      );
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
      if (decision === "defer") {
        readDescendantFacts.mockResolvedValue({ unsettled: true, active: 1 });
      }
      const original = wakeParams();
      const transitionBatch = vi.fn(
        async (...args: Parameters<typeof original.transitionBatch>) => {
          await Promise.resolve();
          return original.transitionBatch(...args);
        },
      );
      const completeBatch = vi.fn(async (...args: Parameters<typeof original.completeBatch>) => {
        await Promise.resolve();
        return original.completeBatch(...args);
      });

      await Promise.all(
        children.map((settledEntry) =>
          maybeWakeRequesterAfterAllChildrenSettled(
            wakeParams({
              settledEntry,
              transitionBatch,
              completeBatch,
            }),
          ),
        ),
      );

      expect(decision === "defer" ? transitionBatch : completeBatch).toHaveBeenCalledOnce();
      expect(deliverSpy).not.toHaveBeenCalled();
    },
  );

  it("lets a healthy sibling decide while an earlier descendant read loses its source", async () => {
    const children = ["run-a", "run-b"].map((runId) => makeSettledChild({ runId }));
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    const readStarted = createDeferred();
    const staleRead = createDeferred<undefined>();
    readDescendantFacts.mockImplementationOnce(() => {
      readStarted.resolve();
      return staleRead.promise;
    });
    const first = maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: children[0] }),
    );
    try {
      await readStarted.promise;
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[1] })),
      ).resolves.toBe(true);
      expect(deliverSpy).toHaveBeenCalledOnce();
    } finally {
      staleRead.resolve(undefined);
      await expect(first).resolves.toBe(false);
    }
  });

  it.each([
    { elapsed: false, transport: true },
    { elapsed: true, transport: true },
    { elapsed: true, transport: false },
  ])(
    "preserves newer retry state after a delayed valid read (elapsed: $elapsed, transport: $transport)",
    async ({ elapsed, transport }) => {
      let now = 10_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const children = ["run-a", "run-b"].map((runId) =>
        makeSettledChild({
          runId,
          requesterSettleWake: {
            status: "pending",
            attemptCount: 0,
            requesterYieldBatch: true,
            rearmGeneration: 1,
            batchRunIds: ["run-a", "run-b"],
          },
        }),
      );
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
      const readStarted = createDeferred();
      const delayedRead = createDeferred<{ unsettled: boolean; active: number }>();
      if (!transport) {
        readDescendantFacts.mockResolvedValue({ unsettled: true, active: 0 });
      }
      readDescendantFacts.mockImplementationOnce(() => {
        readStarted.resolve();
        return delayedRead.promise;
      });
      if (transport) {
        deliverSpy.mockRejectedValueOnce(new Error("retry this transport"));
      }
      const first = maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: children[0] }),
      );
      try {
        await readStarted.promise;
        await expect(
          maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[1] })),
        ).resolves.toBe(false);
        const retry = structuredClone(children[1]?.requesterSettleWake);
        expect(retry).toMatchObject(
          transport
            ? { status: "dispatching", attemptCount: 1, replayCount: 1, nextAttemptAt: 40_000 }
            : { status: "pending", attemptCount: 0, deferralCount: 1, nextAttemptAt: 40_000 },
        );
        if (elapsed) {
          now = 40_001;
        }
        delayedRead.resolve({ unsettled: true, active: 0 });
        await expect(first).resolves.toBe(false);
        for (const child of children) {
          expect(child.requesterSettleWake).toEqual(
            elapsed ? { ...retry, nextAttemptAt: 70_001, deferralCount: transport ? 1 : 2 } : retry,
          );
        }
        expect(deliverSpy).toHaveBeenCalledTimes(transport ? 1 : 0);
        expect(completeBatchSpy).not.toHaveBeenCalled();
      } finally {
        delayedRead.resolve({ unsettled: true, active: 0 });
        await first;
        clock.mockRestore();
      }
    },
  );

  it("includes the whole connected drained wave for a staggered fan-out", async () => {
    // A overlaps B and B overlaps C, but A never overlaps C. When C settles
    // last, A's results must still ride the wake and the idempotency key must
    // cover the full component (any last-settler computes the same batch).
    const resultPrefix = "<result>".repeat(700);
    const childA = makeSettledChild({
      runId: "run-a",
      createdAt: 1_000,
      startedAt: 1_000,
      endedAt: 2_000,
      outcome: { status: "ok" },
    });
    const childB = makeSettledChild({
      runId: "run-b",
      createdAt: 1_500,
      startedAt: 2_100,
      endedAt: 3_000,
      outcome: { status: "ok" },
    });
    const childC = makeSettledChild({
      runId: "run-c",
      createdAt: 2_500,
      startedAt: 2_500,
      endedAt: 4_000,
      outcome: { status: "ok" },
    });
    const children = [childA, childB, childC];
    const transcripts = new Map<string, unknown[]>();
    const findings = ["alpha findings", "bravo findings", "charlie findings"];
    for (const [index, child] of children.entries()) {
      const text = `${resultPrefix}${findings[index]}`;
      const terminalReply = buildAgentRunTerminalReplySnapshot({ visibleText: text });
      expect(terminalReply.disposition).toBe("visible");
      if (terminalReply.disposition !== "visible") {
        throw new Error("expected visible terminal evidence");
      }
      child.completion = { required: true, terminalReply, resultText: terminalReply.text };
      expect(terminalReply.text).toHaveLength(4_096);
      const sessionId = `session-${child.runId}`;
      sessionStore[child.childSessionKey] = { sessionId };
      const assistant = (runId: string, messageText: string, stopReason = "stop") => ({
        type: "message",
        message: {
          role: "assistant",
          stopReason,
          content: [{ type: "text", text: messageText }],
          __openclaw: { runId },
        },
      });
      transcripts.set(sessionId, [
        assistant("previous-run", "stale previous result"),
        assistant(child.runId, "earlier commentary"),
        assistant(child.runId, text),
        assistant("replacement-run", "unrelated later result"),
        assistant(child.runId, "unfinished follow-up", "toolUse"),
      ]);
    }
    findTranscriptEventMock.mockImplementation(async ({ sessionId }, match) => {
      const event = transcripts
        .get(sessionId)
        ?.findLast((candidate) => matchesTranscriptEvent(candidate, match));
      return event === undefined ? undefined : { event };
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: childC }),
    );

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b,run-c"));
    expect(transitionBatchSpy).toHaveBeenNthCalledWith(1, ["run-a", "run-b", "run-c"], {
      status: "dispatching",
      attemptCount: 1,
      batchRunIds: ["run-a", "run-b", "run-c"],
    });
    expect(transitionBatchSpy.mock.invocationCallOrder[0]).toBeLessThan(
      deliverSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    const message = String(call.triggerMessage);
    for (const result of findings) {
      expect(message).toContain(`${"&lt;result&gt;".repeat(700)}${result}`);
    }
    expect(message).not.toContain("stale previous result");
    expect(message).not.toContain("earlier commentary");
    expect(message).not.toContain("unrelated later result");
    expect(message).not.toContain("unfinished follow-up");
    expect(message.indexOf("alpha findings")).toBeLessThan(message.indexOf("bravo findings"));
    expect(message.indexOf("bravo findings")).toBeLessThan(message.indexOf("charlie findings"));
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(
      ["run-a", "run-b", "run-c"],
      undefined,
      { delivered: true, path: "direct" },
    );
  });

  it("ignores long-settled children from earlier non-overlapping spawns", async () => {
    // A one-off completion after an old fan-out must not re-wake the requester
    // about the historical batch: the old children ended before this one began.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-old-1", createdAt: 100, startedAt: 100, endedAt: 200 }),
      makeSettledChild({ runId: "run-old-2", createdAt: 100, startedAt: 110, endedAt: 250 }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("does not wake while other children still await settle", async () => {
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    readDescendantFacts.mockResolvedValue({ unsettled: true, active: 0 });

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: children[1] }),
    );

    expect(woke).toBe(false);
    expect(readDescendantFacts).toHaveBeenCalledOnce();
    expect(transitionBatchSpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("leaves nested orchestrators to the descendant-settle wake", async () => {
    const nestedRequester = "agent:main:subagent:middle";
    sessionStore[nestedRequester] = { sessionId: "sess-middle" };
    // A qualifying drained wave, so the depth guard is what rejects.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a", requesterSessionKey: nestedRequester }),
      makeSettledChild({ runId: "run-b", requesterSessionKey: nestedRequester }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterSessionKey: nestedRequester }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"]);
  });

  it("skips cron requester sessions", async () => {
    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterSessionKey: "agent:main:cron:daily-report" }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-b"]);
  });

  it("skips requesters whose session entry is gone", async () => {
    setSessionStore({});
    // A qualifying drained wave, so the missing session entry is what rejects.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "is still marked running with an end timestamp",
      { status: "running", startedAt: 2_000, endedAt: 3_000 },
    ],
    ["has no end timestamp", { status: "terminal", startedAt: 2_000 }],
  ] as const)(
    "does not wake a yielded requester while its only frozen child %s",
    async (_description, execution) => {
      const activeChild = makeSettledChild({
        runId: "run-b",
        execution,
        delivery: { status: "pending" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-b"],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([activeChild]);

      const woke = await maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: activeChild }),
      );

      expect(woke).toBe(false);
      expect(deliverSpy).not.toHaveBeenCalled();
      expect(completeBatchSpy).not.toHaveBeenCalled();
    },
  );

  it("wakes after a retired frozen member disappears from the registry", async () => {
    const remainingChild = makeSettledChild({
      runId: "run-a",
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-a", "run-b"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([remainingChild]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: remainingChild }),
    );

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-a"], 1, {
      delivered: true,
      path: "direct",
    });
  });

  it("wakes with captured fallback output after a resumed completion returns NO_REPLY", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        delivery: { status: "failed" },
        completion: {
          required: true,
          resultText: "NO_REPLY",
          fallbackResultText: "findings captured before the wake",
        },
        outcome: { status: "ok" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).toContain("findings captured before the wake");
    expect(message).not.toContain("<prompt-data>\nNO_REPLY\n</prompt-data>");
  });

  it.each([
    {
      name: "visible local route change",
      requesterOrigin: undefined,
      terminalReply: {
        disposition: "visible",
        text: "authoritative final output",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const,
      resultText: "stale child output",
      expected: "authoritative final output",
      expectedRouteInstruction:
        "Preserve this runtime-authored model-route change notice in your final answer.",
      expectedRouteChange: "Model route changed: requested/model → actual/model.",
    },
    {
      name: "visible shared route change",
      requesterOrigin: { channel: "discord", to: "channel:shared" },
      terminalReply: {
        disposition: "visible",
        text: "authoritative final output",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const,
      resultText: "stale child output",
      expected: "authoritative final output",
      expectedRouteInstruction:
        "Keep this runtime-authored model-route change notice internal on this shared surface.",
      expectedRouteChange: "Model route changed: requested/model → actual/model.",
    },
  ])(
    "keeps producer-owned $name terminal evidence in the requester settle wake",
    async ({
      terminalReply,
      resultText,
      expected,
      expectedRouteChange,
      expectedRouteInstruction,
      requesterOrigin,
    }) => {
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
        makeSettledChild({ runId: "run-b" }),
        ...["run-a", "run-c"].map((runId) =>
          makeSettledChild({
            runId,
            delivery: { status: "failed" },
            completion: {
              required: true,
              resultText,
              fallbackResultText: "stale retained findings",
              terminalReply,
            },
            outcome: { status: "ok" },
          }),
        ),
      ]);

      if (terminalReply.disposition === "visible") {
        for (const child of listedRequesterRuns()) {
          sessionStore[child.childSessionKey] = { sessionId: `session-${child.runId}` };
        }
        findTranscriptEventMock.mockImplementation(async (scope, match) => {
          const child = listedRequesterRuns().find(
            (entry) => `session-${entry.runId}` === scope.sessionId,
          );
          const event = {
            type: "message",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: terminalReply.text }],
              __openclaw: { runId: child?.runId },
            },
          };
          return matchesTranscriptEvent(event, match) ? { event } : undefined;
        });
      }

      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ requesterOrigin }))).toBe(
        true,
      );
      const message = String(deliveredCallArg().triggerMessage);
      expect(message).not.toContain("stale retained findings");
      expect(message).not.toContain("stale child output");
      if (expected) {
        expect(message).toContain(expected);
      }
      if (expectedRouteChange) {
        expect(message.split(expectedRouteChange)).toHaveLength(2);
        expect(message).toContain(expectedRouteInstruction);
      }
    },
  );

  it("bounds sorted route notices and excludes superseded child owners", async () => {
    const children = Array.from({ length: 8 }, (_, index) =>
      makeSettledChild({
        runId: `run-${index}`,
        completion: {
          required: true,
          terminalReply: {
            disposition: "visible",
            text: "done",
            modelRouteChange: `Model route changed: requested/${index} → actual/${"x".repeat(260)}.`,
          },
        },
      }),
    ).toReversed();
    const staleChild = makeSettledChild({
      runId: "run-stale",
      completion: {
        required: true,
        terminalReply: {
          disposition: "visible",
          text: "stale output",
          modelRouteChange: "Model route changed: old/owner → stale/route.",
        },
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([staleChild, ...children]);
    registryRuntimeMock.getLatestLiveSubagentRunByChildSessionKey.mockImplementation(
      (sessionKey) =>
        sessionKey === staleChild.childSessionKey
          ? { ...staleChild, runId: "run-replacement", requesterSessionKey: "agent:other:main" }
          : undefined,
    );

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: staleChild })),
    ).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();

    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      { ...staleChild, requesterSettleWake: undefined },
      ...children,
    ]);
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[0] })),
    ).toBe(true);
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).not.toContain("stale output");
    expect(message).not.toContain("old/owner");
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
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-a",
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
      makeSettledChild({
        runId: "run-b",
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"]);
  });

  it("retains a yielded wake after a silent final and retries its visible reply", async () => {
    const child = makeSettledChild({ runId: "run-b" });
    const yieldState = {
      batchRunIds: ["run-b"],
      requesterYieldBatch: true,
      rearmGeneration: 1,
    };
    Object.assign(child.requesterSettleWake!, yieldState);
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
    const append = vi.fn(() => true);
    const owner = { requesterAgentId: "main", requesterSessionKey: REQUESTER } as const;
    const requesterTurnRunId = "run-requester";
    registerRequesterFinalAttachment({
      ...owner,
      requesterSessionId: "sess-main",
      requesterTurnRunId,
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      timeoutMs: 60_000,
      append,
    });
    promoteRequesterFinalAttachment({
      ...owner,
      requesterTurnRunId,
      batchRunIds: ["run-b"],
      rearmGeneration: 1,
    });
    const path = "direct" as const;
    const missing: Result = { delivered: false, path, reason: "visible_reply_missing" };
    const visible = { delivered: true, path, finalAssistantVisibleText: "consolidated final" };
    deliverSpy.mockResolvedValueOnce(missing).mockResolvedValueOnce(visible);

    const settle = () =>
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
    vi.useFakeTimers({ now: 0 });
    try {
      await expect(settle()).resolves.toBe(false);
      expect(completeBatchSpy).not.toHaveBeenCalled();
      expect(child.requesterSettleWake).toMatchObject({
        attemptCount: 1,
        nextAttemptAt: 30_000,
        lastError: "visible_reply_missing",
      });
      await expect(settle()).resolves.toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(settle()).resolves.toBe(true);
      expect(deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey)).toEqual(
        ["run-b:yield-1", "run-b:yield-1:retry-1"].map(requesterSettleKey),
      );
      expect(completeBatchSpy).toHaveBeenCalledWith(["run-b"], 1, visible);
      expect(append).toHaveBeenCalledExactlyOnceWith(visible.finalAssistantVisibleText);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays an ambiguous transport failure with the same idempotency key", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    deliverSpy.mockRejectedValueOnce(new Error("connection lost after admission"));

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        replayCount: 1,
        nextAttemptAt: 30_000,
        lastError: "connection lost after admission",
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(true);
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      expect(deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey)).toEqual([
        requesterSettleKey("run-a,run-b"),
        requesterSettleKey("run-a,run-b"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers a retry when the requester spawned another active descendant", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    readDescendantFacts
      .mockResolvedValueOnce({ unsettled: false, active: 0 })
      .mockResolvedValueOnce({ unsettled: false, active: 0 })
      .mockResolvedValue({ unsettled: true, active: 0 });
    deliverSpy.mockResolvedValueOnce({ delivered: false, path: "direct" });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(1);
      expect(firstChild.requesterSettleWake?.status).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after bounded retries when the wake keeps failing", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValue({ delivered: false, path: "direct" });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

      expect(woke).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(3);
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"], undefined, {
        delivered: false,
        path: "direct",
        error: "undelivered",
      });
    } finally {
      vi.useRealTimers();
      deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
    }
  });

  it("records a transcript turn assertion as one permanent completion failure", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    const error = "Session transcript keyed user is outside the current turn: old-input";
    deliverSpy.mockRejectedValueOnce(new Error(error));

    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-a", "run-b"], undefined, {
      delivered: false,
      path: "none",
      disposition: "permanent_failure",
      error,
    });
    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(completeBatchSpy).toHaveBeenCalledOnce();
  });

  it("does not retry an ambiguous delivery failure", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      disposition: "ambiguous",
    });

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"], undefined, {
      delivered: false,
      path: "direct",
      disposition: "ambiguous",
    });
  });

  it("does not consume retry budget when aborted before dispatch", async () => {
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    const abortController = new AbortController();
    registryRuntimeMock.listSubagentRunsForRequester.mockImplementation(() => {
      abortController.abort();
      return children;
    });

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: children[1], signal: abortController.signal }),
      ),
    ).toBe(false);
    expect(transitionBatchSpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  describe("restart-persistent outbox", () => {
    it("keeps active overlap pending and only caps a stale settle blocker", async () => {
      const child = makeSettledChild({
        runId: "run-a",
        delivery: { status: "pending" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-a"],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      readDescendantFacts.mockResolvedValue({ unsettled: true, active: 1 });

      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        for (let recheck = 0; recheck < 12; recheck += 1) {
          await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
          await vi.advanceTimersByTimeAsync(30_000);
        }

        expect(child.requesterSettleWake?.deferralCount).toBe(0);

        readDescendantFacts.mockResolvedValue({ unsettled: false, active: 1 });
        await expect(
          maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
        ).resolves.toBe(true);

        vi.clearAllMocks();
        child.requesterSettleWake = {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-a"],
          rearmGeneration: 1,
          deferralCount: 8,
        };
        readDescendantFacts.mockResolvedValue({ unsettled: true, active: 0 });

        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
        expect(transitionBatchSpy).toHaveBeenCalledOnce();
        expect(completeBatchSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(30_000);
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
        expect(completeBatchSpy).toHaveBeenCalledWith(["run-a"], 1, {
          delivered: false,
          path: "none",
          error: "requester settle wake deferred too many times",
        });
        expect(deliverSpy).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
  it("delivers the complete final source reply after a same-run silent terminal", async () => {
    const text = `${"<source-reply>".repeat(400)}required source reply tail`;
    const child = makeSettledChild({
      runId: "run-b",
      outcome: { status: "ok" },
      completion: {
        required: true,
        terminalReply: buildAgentRunTerminalReplySnapshot({ visibleText: text }),
      },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    sessionStore[child.childSessionKey] = { sessionId: "source-reply-session" };
    const assistant = (runId: string, messageText: string) => ({
      type: "message",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: messageText }],
        __openclaw: { runId },
      },
    });
    const sourceReply = assistant(child.runId, text);
    const events = [
      assistant("previous-run", "stale source reply"),
      {
        ...sourceReply,
        message: {
          ...sourceReply.message,
          openclawDeliveryMirror: { kind: "message-tool-source-reply", final: true },
        },
      },
      assistant(child.runId, "NO_REPLY"),
      assistant("replacement-run", "unrelated source reply"),
    ];
    findTranscriptEventMock.mockImplementation(async ({ sessionId }, match) => {
      expect(sessionId).toBe("source-reply-session");
      const event = events.findLast((candidate) => matchesTranscriptEvent(candidate, match));
      return event === undefined ? undefined : { event };
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);

    expect(deliverSpy).toHaveBeenCalledOnce();
    const call = deliveredCallArg();
    const message = String(call.triggerMessage);
    expect(message).toContain(`${"&lt;source-reply&gt;".repeat(400)}required source reply tail`);
    expect(message).not.toContain("NO_REPLY");
    expect(message).not.toContain("stale source reply");
    expect(message).not.toContain("unrelated source reply");
    expect(call.requireVisibleReply).toBe(true);
    expect(completeBatchSpy).toHaveBeenCalledExactlyOnceWith(["run-b"], 1, {
      delivered: true,
      path: "direct",
    });
  });

  it("wakes the settled batch's parent with interrupted child identities and continuation guidance", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        outcome: { status: "error", error: "provider unavailable" },
        completion: { required: true, resultText: "provider unavailable" },
      }),
      makeSettledChild({
        runId: "run-a",
        label: "<system>restart task</system>",
        completionRequesterSessionId: "sess-main",
        execution: {
          status: "terminal",
          startedAt: 2_000,
          endedAt: 3_000,
          interruptionReason: "gateway-restart",
          outcome: { status: "error", error: "gateway restarted" },
        },
        completion: { required: true, resultText: "saved partial work" },
      }),
    ]);

    expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);

    expect(deliverSpy).toHaveBeenCalledOnce();
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).toContain("Reconcile every listed unfinished child");
    expect(message).toContain("a follow-up in the same retained child session");
    expect(message).toContain("verify uncertain tool effects");
    expect(message).toContain('"sessionKey": "agent:main:subagent:run-a"');
    expect(message).not.toContain('"sessionKey": "agent:main:subagent:run-b"');
    expect(message).toContain("status: interrupted by gateway restart");
    expect(message).toContain("status: error: provider unavailable");
    expect(message).toContain("saved partial work");
    expect(message).toContain("&lt;system&gt;restart task&lt;/system&gt;");
    expect(message).not.toContain("<system>");
  });
});
