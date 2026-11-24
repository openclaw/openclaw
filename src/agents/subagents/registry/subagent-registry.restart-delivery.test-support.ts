import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import * as sessionEvents from "../../../auto-reply/reply/session-event-handoff.js";
import {
  appendSessionTranscriptReport,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import { resumeMarkedSessions } from "../../../gateway/session-restart-resume.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { sessionControllerMailboxes } from "../../../sessions/session-controller.mailbox.js";
import { createSubagentRunParams } from "../../subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import type { GatewayRequest } from "./subagent-registry.lifecycle-fixture.test-support.js";
import {
  createRequesterYieldTool,
  visibleChild,
} from "./subagent-registry.requester-wake-receipts.test-support.js";
import type { RequesterWakeFixture } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

export function registerRequesterRestartDeliveryTests<Response>({
  requesterSessionKey,
  getFixture,
  prepareChildSession,
  callGatewayMock,
  spawnVisibleChild,
  settleTurn,
  flushOwnedWork,
  waitForDeliveredCleanup,
  getRequesterWakeCalls,
  createGatewayContext,
  getLifecycleHandler,
}: Pick<
  RequesterWakeFixture,
  | "requesterSessionKey"
  | "getFixture"
  | "prepareChildSession"
  | "spawnVisibleChild"
  | "settleTurn"
  | "flushOwnedWork"
  | "waitForDeliveredCleanup"
  | "getRequesterWakeCalls"
  | "createGatewayContext"
  | "getLifecycleHandler"
> & { callGatewayMock: Mock<(request: GatewayRequest) => Promise<Response>> }): void {
  it.each([false, true])(
    "settles an ended child's restart-aborted delivery without replay (consumed=%s)",
    async (consumed) => {
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      const child = visibleChild("ended-before-shutdown");
      const sessionEntry = await prepareChildSession(child.childSessionKey, "sess-ended-child");
      const requester = {
        agentId: "main",
        sessionKey: requesterSessionKey,
        storePath: getFixture().sessionStorePath,
        sessionId: getFixture().sessionStore[requesterSessionKey]!.sessionId,
      };
      const entered = createDeferred();
      const aborted = createDeferred();
      const dispatch = callGatewayMock.getMockImplementation()!;
      let attempts = 0;
      let deliveries = 0;
      callGatewayMock.mockImplementation(async (request) => {
        if (request.method !== "agent") {
          return dispatch(request);
        }
        attempts++;
        if (consumed) {
          const committed = await appendSessionTranscriptReport(requester, {
            kind: "custom",
            customTypes: ["synthetic-child-input"],
            selectReport: () => ({
              customType: "synthetic-child-input",
              content: [
                String(request.params?.message),
                JSON.stringify(request.params?.internalEvents ?? []),
              ].join("\n"),
              display: false,
            }),
          });
          expect(committed.ok).toBe(true);
          const runId = request.params?.idempotencyKey;
          const input = [...sessionControllerMailboxes()]
            .flatMap((mailbox) => mailbox.entries)
            .find((entry) => entry.protocolRunId === runId);
          await expectDefined(input?.onTranscriptCommitted, "input commit callback")(String(runId));
          deliveries++;
        }
        entered.resolve();
        await aborted.promise;
        return { status: "timeout", stopReason: "restart" } as Response;
      });
      onTestFinished(() => {
        aborted.resolve();
        resetGatewayWorkAdmission();
        callGatewayMock.mockImplementation(dispatch);
      });
      await registry.registerSubagentRun(
        createSubagentRunParams({
          ...child,
          sessionEntry,
          requesterSessionKey,
          requesterAgentId: "main",
          cleanup: "keep",
          gatewayContextResolver: context.resolveGatewayContext,
        }),
      );
      getLifecycleHandler()!({
        stream: "lifecycle",
        runId: child.runId,
        seq: 1,
        ts: Date.now(),
        sessionKey: child.childSessionKey,
        data: {
          phase: "end",
          endedAt: Date.now(),
          terminalReply: {
            disposition: "visible",
            text: "SAVED_COMPLETED_CHILD_RESULT",
          },
        },
      });
      await entered.promise;
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.completion?.resultText).toBe(
        "SAVED_COMPLETED_CHILD_RESULT",
      );
      markGatewayRestartDraining();
      aborted.resolve();
      await flushOwnedWork();
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.status).toBe("delivered");
      await registry.resetSubagentRegistryForTests({ persist: false });
      resetGatewayWorkAdmission();
      const restarted = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => restarted);
      await resumeMarkedSessions({
        context: restarted,
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await registry.testing.sweepOnceForTests();
      await flushOwnedWork();
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.delivery?.status).toBe("delivered");
      await registry.testing.sweepOnceForTests();
      await flushOwnedWork();
      expect(deliveries).toBe(consumed ? 1 : 0);
      expect(attempts).toBe(1);
      const events = await loadTranscriptEvents(requester);
      expect(
        events.filter((event) => isRecord(event) && event.customType === "synthetic-child-input"),
      ).toHaveLength(consumed ? 1 : 0);
      const statuses = events.filter(
        (event) => isRecord(event) && event.customType === "subagent-completion",
      );
      expect(statuses).toEqual(
        consumed
          ? []
          : [
              expect.objectContaining({
                display: false,
                content: expect.stringContaining("SAVED_COMPLETED_CHILD_RESULT"),
                details: expect.objectContaining({ childRunIds: [child.runId] }),
              }),
            ],
      );
      if (!consumed) {
        expect(statuses[0]).not.toHaveProperty("excludeFromContext");
      }
    },
  );

  it("settles consumed results across separate owner partitions without replay", async () => {
    const contexts = [createGatewayContext(), createGatewayContext()];
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => contexts[0]!);
    const batchRunIds = ["partition-alpha", "partition-beta"];
    for (const [index, runId] of batchRunIds.entries()) {
      const childSessionKey = `agent:main:subagent:${runId}`;
      const sessionEntry = await prepareChildSession(childSessionKey, `sess-${runId}`);
      await registry.addSubagentRunForTests({
        runId,
        childSessionKey,
        childAgentId: "main",
        childSessionIdentity: sessionEntry,
        requesterSessionKey,
        requesterAgentId: "main",
        expectsCompletionMessage: true,
        completionTarget: "parent",
        endedAt: Date.now(),
        outcome: { status: "ok" },
        completion: { required: true, resultText: `Saved answer from ${runId}` },
        delivery: {
          status: "pending",
          requesterDelivery: { state: "consumed", runId: "shared-requester", at: Date.now() },
        },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 1,
          requesterYieldBatch: true,
          requesterRunId: "shared-requester",
          yieldedFinalDeliverable: true,
          batchRunIds,
          rearmGeneration: 1,
        },
      });
      bindGatewayContextResolver(subagentRuns.get(runId)!, contexts[index]!.resolveGatewayContext);
    }
    for (const runId of batchRunIds) {
      registry.resumeSubagentRun(runId);
      await flushOwnedWork();
      expect(loadSubagentRegistryFromSqlite().get(runId)?.delivery?.status).toBe("delivered");
    }
    expect(getRequesterWakeCalls()).toEqual([]);
    const events = await loadTranscriptEvents({
      agentId: "main",
      sessionKey: requesterSessionKey,
      storePath: getFixture().sessionStorePath,
      sessionId: getFixture().sessionStore[requesterSessionKey]!.sessionId,
    });
    const reports = events.filter(
      (event) => isRecord(event) && event.customType === "subagent-completion",
    );
    expect(reports).toEqual([]);
  });

  it.each(["yielded settle", "aborted announce", "aborted consumed announce"] as const)(
    "preserves a child outcome in model-visible history through spawn, drain, restart and %s",
    async (shape) => {
      const child = visibleChild(`drain-${shape.replaceAll(" ", "-")}`);
      const yielded = !shape.startsWith("aborted");
      const context = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => context);
      const sessionEntry = await prepareChildSession(child.childSessionKey, `sess-${child.runId}`);
      await registry.registerSubagentRun(
        createSubagentRunParams({
          ...child,
          sessionEntry,
          requesterSessionKey,
          requesterAgentId: "main",
          requesterTurnRunId: yielded ? "before-drain" : undefined,
          cleanup: "delete",
          gatewayContextResolver: context.resolveGatewayContext,
        }),
      );
      const claim = claimAgentRunContext(
        child.runId,
        { sessionKey: child.childSessionKey, sessionId: sessionEntry.sessionId },
        { trackOwner: true },
      );
      onTestFinished(() => releaseAgentRunContext(child.runId, claim));
      if (yielded) {
        await createRequesterYieldTool(requesterSessionKey, "before-drain").execute("yield", {});
        await settleTurn("before-drain", [child]);
      }
      await registry.terminateLiveSubagentsForShutdown(
        expectDefined(context.resolveGatewayContext, "draining Gateway context"),
      );
      releaseAgentRunContext(child.runId, claim);
      await flushOwnedWork();
      expect(loadSubagentRegistryFromSqlite().get(child.runId)?.execution.outcome).toMatchObject({
        status: "error",
        error: "Gateway stopped",
      });
      await registry.resetSubagentRegistryForTests({ persist: false });

      const requester = {
        agentId: "main",
        sessionKey: requesterSessionKey,
        storePath: getFixture().sessionStorePath,
        sessionId: getFixture().sessionStore[requesterSessionKey]!.sessionId,
      };
      const dispatch = callGatewayMock.getMockImplementation()!;
      onTestFinished(() => {
        callGatewayMock.mockImplementation(dispatch);
      });
      let dispatchCount = 0;
      callGatewayMock.mockImplementation(async (request) => {
        if (request.method !== "agent") {
          return dispatch(request);
        }
        dispatchCount += 1;
        const runId = request.params?.idempotencyKey;
        const input = [...sessionControllerMailboxes()]
          .flatMap((mailbox) => mailbox.entries)
          .find((entry) => entry.protocolRunId === runId);
        if (yielded || shape === "aborted consumed announce") {
          expect(request.params?.inputProvenance).toMatchObject({
            sourceTool: yielded ? "subagent_settle" : "subagent_announce",
            sourceSessionKey: child.childSessionKey,
          });
          const committed = await appendSessionTranscriptReport(requester, {
            kind: "custom",
            customTypes: ["synthetic-child-input"],
            selectReport: () => ({
              customType: "synthetic-child-input",
              content: [
                String(request.params?.message),
                JSON.stringify(request.params?.internalEvents ?? []),
              ].join("\n"),
              display: false,
            }),
          });
          expect(committed.ok).toBe(true);
          await expectDefined(
            input?.onTranscriptCommitted,
            "completion input commit callback",
          )(String(runId));
        }
        return {
          status: "ok",
          result: {
            payloads: [],
            meta: { durationMs: 1, [yielded ? "yielded" : "aborted"]: true },
          },
        } as Response;
      });
      const restarted = createGatewayContext();
      await registry.initSubagentRegistry();
      await registry.activateSubagentRegistry(() => restarted);
      await resumeMarkedSessions({
        context: restarted,
        signal: new AbortController().signal,
        log: { warn: vi.fn() },
      });
      await registry.testing.sweepOnceForTests();
      await flushOwnedWork();
      expect(dispatchCount).toBeGreaterThan(0);
      const events = await loadTranscriptEvents(requester);
      const statuses = events.filter(
        (event) => isRecord(event) && event.customType === "subagent-completion",
      );
      const inputs = events.filter(
        (event) => isRecord(event) && event.customType === "synthetic-child-input",
      );
      const consumed = yielded || shape === "aborted consumed announce";
      expect(statuses).toHaveLength(consumed ? 0 : 1);
      expect(inputs).toHaveLength(consumed ? 1 : 0);
      const history = consumed ? inputs : statuses;
      expect(history[0]).toMatchObject({ type: "custom_message", display: false });
      expect(history[0]).not.toHaveProperty("excludeFromContext");
      const content = history.map((event) => (isRecord(event) ? event.content : "")).join("\n");
      if (!consumed) {
        expect(content).toContain(child.childSessionKey);
      }
      expect(content).toContain(child.runId);
      expect(content).toMatch(/Gateway stopped|Gateway restart/);
    },
  );

  it("wakes a yielded parent when startup fails its child's unreachable yield", async () => {
    const child = visibleChild("restart-lost-yield");
    const parentRunId = "parent-before-restart";
    await spawnVisibleChild({ ...child, requesterTurnRunId: parentRunId });
    await createRequesterYieldTool(requesterSessionKey, parentRunId).execute("yield", {});
    await settleTurn(parentRunId, [child]);
    const entry = getFixture().sessionStore[child.childSessionKey]!;
    // The child's own awaited completion disappeared with the previous Gateway.
    getLifecycleHandler()!({
      stream: "lifecycle",
      runId: child.runId,
      seq: 1,
      ts: Date.now(),
      sessionKey: child.childSessionKey,
      data: { phase: "end", yielded: true },
    });
    await flushOwnedWork();
    expect(subagentRuns.get(child.runId)?.pauseReason).toBe("sessions_yield");
    const restartInput = vi.spyOn(sessionEvents, "enqueueSessionEventForHost");
    onTestFinished(() => restartInput.mockRestore());
    const parent = getFixture().sessionStore[requesterSessionKey]!;
    for (const data of [
      { phase: "start" },
      { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" },
    ]) {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: requesterSessionKey,
        agentId: "main",
        event: { runId: parentRunId, sessionId: parent.sessionId, ts: Date.now(), data },
      });
    }
    for (const data of [
      { phase: "start" },
      { phase: "end", yielded: true, livenessState: "paused", stopReason: "end_turn" },
    ]) {
      await persistGatewaySessionLifecycleEvent({
        sessionKey: child.childSessionKey,
        agentId: "main",
        event: { runId: child.runId, sessionId: entry.sessionId, ts: Date.now(), data },
      });
    }
    await resumeMarkedSessions({
      context: createGatewayContext(),
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
    });
    await flushOwnedWork();
    expect(
      loadExactSessionEntryReadOnly({
        agentId: "main",
        sessionKey: child.childSessionKey,
      })?.entry.status,
    ).toBe("failed");
    expect(
      loadExactSessionEntryReadOnly({ agentId: "main", sessionKey: requesterSessionKey })?.entry
        .status,
    ).not.toBe("failed");
    expect(restartInput).not.toHaveBeenCalled();
    expect(subagentRuns.get(child.runId)?.execution.outcome).toMatchObject({
      status: "error",
      error: expect.stringContaining("no registered continuation can resume it"),
    });
    expect(getRequesterWakeCalls()).toHaveLength(1);
    expect(getRequesterWakeCalls()[0]?.params).toMatchObject({
      inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
    });
    await waitForDeliveredCleanup(child.runId);
  });
}
