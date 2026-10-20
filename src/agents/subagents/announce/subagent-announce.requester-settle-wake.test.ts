// Requester settle wake tests cover the registry-less top-level requester.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { matchesTranscriptEvent } from "../../../sessions/transcript-visible-record.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
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

describe("maybeWakeRequesterAfterAllChildrenSettled", () => {
  it.each([false, true])(
    "preserves native retry request identity (private=%s)",
    async (privateCompletion) => {
      const child = makeSettledChild({
        runId: "run-b",
        completionTarget: privateCompletion ? "parent" : undefined,
        completionRequesterSessionId: "sess-main",
        delivery: { status: "pending" },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
      deliverSpy.mockImplementationOnce(async (params) => {
        if (typeof params.onBeforeDispatch !== "function") {
          throw new Error("expected completion dispatch preparation");
        }
        await params.onBeforeDispatch();
        if (typeof params.onAccepted !== "function") {
          throw new Error("expected completion acceptance observer");
        }
        params.onAccepted({ status: "accepted" });
        return {
          delivered: false,
          path: "direct",
          reason: privateCompletion ? "completion_handoff_pending" : "visible_reply_missing",
          disposition: "retryable",
        };
      });
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      const first = deliveredCallArg();
      const due = child.requesterSettleWake?.nextAttemptAt;
      expect(due).toBeTypeOf("number");
      const clock = vi.spyOn(Date, "now").mockReturnValue(due!);
      try {
        expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(true);
        const retry = deliverSpy.mock.calls[1]?.[0];
        expect(first.directIdempotencyKey).toBe(
          "announce:requester-settle:main:agent:main:main:run-b",
        );
        expect(retry?.directIdempotencyKey).toBe(
          privateCompletion
            ? "announce:requester-settle:main:agent:main:main:run-b"
            : "announce:requester-settle:main:agent:main:main:run-b:retry-1",
        );
        if (privateCompletion) {
          expect(retry?.triggerMessage).toBe(first.triggerMessage);
        } else {
          expect(retry?.triggerMessage).toContain("Continue from the current transcript");
        }
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("waits for descendant events without writes and retains one terminal-delivery deadline", async () => {
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
    const onDescendantsPending = vi.fn();
    const transitionBatch = vi.fn(wakeParams().transitionBatch);
    const settle = () =>
      maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: child, onDescendantsPending, transitionBatch }),
      );
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await expect(settle()).resolves.toBe(false);
      expect(onDescendantsPending).toHaveBeenLastCalledWith(undefined);
      expect(readDescendantFacts).toHaveBeenCalledOnce();
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
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([restored]);
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled(
          wakeParams({ settledEntry: restored, onDescendantsPending }),
        ),
      ).resolves.toBe(true);
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
      const terminalReply = prepareAgentRunTerminalReply({ rawText: text }).terminalReply;
      expect(terminalReply.disposition).toBe("visible");
      if (terminalReply.disposition !== "visible") {
        throw new Error("expected visible terminal evidence");
      }
      child.completion = { required: true, terminalReply, resultText: text };
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
      makeSettledChild({ runId: "run-b", delivery: { status: "delivered" } }),
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
    expect(deliverSpy).not.toHaveBeenCalled();
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

  it.each([["has no end timestamp", { status: "terminal", startedAt: 2_000 }]] as const)(
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

  it("does not revive captured fallback output after a resumed completion returns NO_REPLY", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
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

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).not.toContain("findings captured before the wake");
    expect(message).toContain("(no output)");
    expect(message).not.toContain("<prompt-data>\nNO_REPLY\n</prompt-data>");
  });

  it.each([
    {
      name: "visible shared route change",
      requesterOrigin: { channel: "discord", to: "channel:shared" },
      expectedRouteInstruction:
        "Keep this runtime-authored model-route change notice internal on this shared surface.",
    },
  ])(
    "keeps producer-owned $name terminal evidence in the requester settle wake",
    async ({ expectedRouteInstruction, requesterOrigin }) => {
      const terminalReply = {
        disposition: "visible",
        text: "authoritative final output",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const;
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
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

      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ requesterOrigin }))).toBe(
        true,
      );
      const message = String(deliveredCallArg().triggerMessage);
      expect(message).not.toContain("stale retained findings");
      expect(message).not.toContain("stale child output");
      expect(message).toContain(terminalReply.text);
      expect(message.split(terminalReply.modelRouteChange)).toHaveLength(2);
      expect(message).toContain(expectedRouteInstruction);
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
    const requesterTurnRunId = "requester-cancellation-owner";
    const children = ["run-a", "run-b"].map((runId) =>
      makeSettledChild({
        runId,
        requesterTurnRunId,
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
    );
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"]);
    expect(children.map((child) => child.requesterTurnRunId)).toEqual([
      requesterTurnRunId,
      requesterTurnRunId,
    ]);
  });

  it("records a transcript turn assertion as one permanent completion failure", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    const error = "Session transcript keyed user is outside the current turn: old-input";
    deliverSpy.mockImplementationOnce(async (params) => {
      if (typeof params.onBeforeDispatch !== "function") {
        throw new Error("expected completion dispatch preparation");
      }
      await params.onBeforeDispatch();
      throw new Error(error);
    });

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

  it.each([undefined, "ambiguous", "permanent_failure"] as const)(
    "does not retry an unknown or terminal delivery failure: %s",
    async (disposition) => {
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
        makeSettledChild({ runId: "run-a" }),
        makeSettledChild({ runId: "run-b" }),
      ]);
      deliverSpy.mockResolvedValueOnce({
        delivered: false,
        path: "direct",
        disposition,
      });

      const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

      expect(woke).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(1);
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"], undefined, {
        delivered: false,
        path: "direct",
        disposition,
      });
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();
    },
  );

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

  it("reconciles an interrupted child even when its earlier result was delivered", async () => {
    const child = makeSettledChild({
      runId: "run-interrupted",
      completionRequesterSessionId: "sess-main",
      execution: {
        status: "terminal",
        startedAt: 2_000,
        endedAt: 3_000,
        interruptionReason: "gateway-restart",
        outcome: { status: "error", error: "gateway restarted" },
      },
      delivery: { status: "delivered" },
      completion: {
        required: true,
        resultText: "saved partial work",
        terminalReply: { disposition: "visible", text: "saved partial work" },
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
    ).toBe(true);

    expect(deliverSpy).toHaveBeenCalledOnce();
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).toContain("Unfinished child sessions to reconcile:");
    expect(message).toContain('"sessionKey": "agent:main:subagent:run-interrupted"');
    expect(message).toContain("saved partial work");
    expect(message).not.toContain("Already delivered child results");
  });

  it("wakes the settled batch's parent with interrupted child identities and continuation guidance", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        outcome: { status: "error", error: "provider unavailable" },
        completion: {
          required: true,
          resultText: "provider unavailable",
          terminalReply: { disposition: "visible", text: "provider unavailable" },
        },
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
        completion: {
          required: true,
          resultText: "saved partial work",
          terminalReply: { disposition: "visible", text: "saved partial work" },
        },
      }),
    ]);
    for (const child of listedRequesterRuns()) {
      sessionStore[child.childSessionKey] = { sessionId: `session-${child.runId}` };
    }
    findTranscriptEventMock.mockImplementation(async ({ sessionId }, match) => {
      const child = listedRequesterRuns().find(
        (entry) => sessionStore[entry.childSessionKey]?.sessionId === sessionId,
      );
      const event = {
        type: "message",
        message: {
          role: "assistant",
          display: true,
          content: [{ type: "text", text: child?.completion?.resultText }],
          __openclaw: { runId: child?.runId },
        },
      };
      return child && matchesTranscriptEvent(event, match) ? { event } : undefined;
    });

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
