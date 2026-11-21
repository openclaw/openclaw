import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi, type Mock } from "vitest";
import * as sessionEvents from "../../../auto-reply/reply/session-event-handoff.js";
import * as sessionAccessor from "../../../config/sessions/session-accessor.js";
import {
  appendSessionTranscriptReport,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
} from "../../../config/sessions/session-accessor.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import { resumeMarkedSessions } from "../../../gateway/session-restart-resume.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../../infra/agent-run-registry.js";
import { bindGatewayContextResolver } from "../../../plugins/runtime/gateway-request-scope.js";
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
  it("shows every consumed result when a frozen batch settles in separate owner partitions", async () => {
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
      (event) => isRecord(event) && event.customType === "subagent-completion" && event.display,
    );
    expect(reports).toHaveLength(2);
    for (const runId of batchRunIds) {
      expect(
        reports.some(
          (event) =>
            isRecord(event) && String(event.content).includes(`Saved answer from ${runId}`),
        ),
      ).toBe(true);
    }
  });

  it.each([
    "yielded settle",
    "aborted announce",
    "aborted consumed announce",
    "fallback write failure",
  ] as const)(
    "preserves a visible child outcome through spawn, drain, restart and %s",
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
          expect(request.params?.inputProvenance?.sourceTool).toBe(
            yielded ? "subagent_settle" : "subagent_announce",
          );
          const committed = await appendSessionTranscriptReport(requester, {
            kind: "custom",
            customTypes: ["synthetic-child-input"],
            selectReport: () => ({
              customType: "synthetic-child-input",
              content: String(request.params?.message),
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
      const appendReport = sessionAccessor.appendSessionTranscriptReport;
      let failFallback = shape === "fallback write failure";
      const append = vi
        .spyOn(sessionAccessor, "appendSessionTranscriptReport")
        .mockImplementation(async (...args) => {
          if (
            failFallback &&
            args[1].kind === "custom" &&
            args[1].customTypes.includes("subagent-completion")
          ) {
            throw new Error("synthetic fallback write failure");
          }
          return appendReport(...args);
        });
      onTestFinished(() => append.mockRestore());
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
      if (failFallback) {
        const retained = loadSubagentRegistryFromSqlite().get(child.runId);
        expect(retained?.delivery?.status).not.toBe("delivered");
        expect(retained?.requesterSettleWake).toBeDefined();
        failFallback = false;
        await registry.resetSubagentRegistryForTests({ persist: false });
        await registry.initSubagentRegistry();
        const retried = createGatewayContext();
        await registry.activateSubagentRegistry(() => retried);
        await resumeMarkedSessions({
          context: retried,
          signal: new AbortController().signal,
          log: { warn: vi.fn() },
        });
        await registry.testing.sweepOnceForTests();
        await flushOwnedWork();
      }
      const events = await loadTranscriptEvents(requester);
      const visible = events.filter(
        (event) => isRecord(event) && event.type === "custom_message" && event.display === true,
      );
      const visibleContent = visible
        .map((event) => (isRecord(event) ? event.content : ""))
        .join("\n");
      expect(visibleContent).toContain(child.childSessionKey);
      expect(visibleContent).toContain(child.runId);
      expect(visibleContent).toMatch(/Gateway stopped|Gateway restart/);
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
