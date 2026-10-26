import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
// Preserve registry fixture setup before its consumers.
// oxfmt-ignore
import { makeRestartRecoveryRun, useSubagentRestartRecoveryFixture } from "./subagent-restart-recovery.test-support.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../../config/sessions/session-sqlite-target.js";
import { setGatewayDedupeEntry, waitForAgentJob } from "../../../gateway/agent-turn/agent-job.js";
import * as gatewayCall from "../../../gateway/call.js";
import { persistGatewaySessionLifecycleEvent } from "../../../gateway/session-lifecycle-state.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  onAgentEvent,
  rotateAgentEventLifecycleGeneration,
} from "../../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
} from "../../../plugins/runtime/gateway-request-scope.js";
import { cleanupSessionStateForTest } from "../../../test-utils/session-state-cleanup.js";
import { prepareCommandSessionRecoveryEntry } from "../../command/session-preparation.js";
import { buildMainSessionRecoverySettlementPatch } from "../../main-session-recovery/main-session-recovery-clear.js";
import { createRecoveryRuntimeFixture } from "../../main-session-recovery/main-session-recovery-runtime.test-support.js";
import { markStartupOrphanedMainSessionsForRecovery } from "../../main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverRestartAbortedMainSessions } from "../../main-session-recovery/main-session-restart-recovery.js";
import { runSubagentAnnounceFlow } from "../announce/subagent-announce.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { recoverInterruptedSubagentRow } from "./subagent-registry-restart-recovery.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import {
  prepareSubagentRecoveryFixture,
  writeSubagentSessionEntry,
} from "./subagent-registry.persistence.test-support.js";
import {
  addSubagentRunForTests,
  initSubagentRegistry,
  resetSubagentRegistryForTests,
  testing,
} from "./subagent-registry.test-helpers.js";
import { buildRequesterSettleWakeIdentity } from "./subagent-requester-settle-identity.js";

describe("nested requester wake crash recovery", () => {
  const fixture = useSubagentRestartRecoveryFixture();

  it.each(["registered", "recovered"] as const)(
    "settles a %s run from its persisted final after a restart",
    async (kind) => {
      const now = Date.now();
      const sessionKey = `agent:main:subagent:previous-boot-${kind}`;
      const sessionId = `previous-boot-${kind}`;
      const lifecycleRevision = `previous-boot-revision-${kind}`;
      const runId =
        kind === "recovered"
          ? "announce:requester-settle:previous-boot"
          : "previous-boot-registered";
      const executionRunId = kind === "recovered" ? "previous-boot-recovered" : runId;
      const startedAt = now - 2 * 60_000;
      const endedAt = now - 5_000;
      const finalText = "The previous boot finished the assigned work successfully.";
      const run = makeRestartRecoveryRun({
        runId,
        childSessionKey: sessionKey,
        childAgentId: "main",
        childSessionIdentity: { sessionId, lifecycleRevision },
        requesterSessionKey: "agent:main:director",
        expectsCompletionMessage: true,
        createdAt: startedAt,
        execution: { status: "running", startedAt },
      });
      await prepareSubagentRecoveryFixture(run, { stateDir: fixture.stateDir });
      await addSubagentRunForTests(run);
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: sessionId,
        lifecycleRevision,
      });
      const target = { agentId: "main", storePath, sessionKey };
      await appendTranscriptMessage(
        { ...target, sessionId },
        {
          message: {
            role: "assistant",
            content: finalText,
            stopReason: "stop",
            __openclaw: { runId: executionRunId },
          },
        },
      );
      if (kind === "recovered") {
        await replaceSessionEntry(target, {
          ...loadSessionEntryReadOnly(target)!,
          restartRecoveryTerminalDeliveryEvidence: [
            {
              runId,
              transcriptRunId: executionRunId,
              captured: true,
              payloads: [{ visible: true }],
            },
          ],
        });
      }
      for (const [phase, ts] of [
        ["start", startedAt],
        ["end", endedAt],
      ] as const) {
        await persistGatewaySessionLifecycleEvent({
          sessionKey,
          event: {
            runId: executionRunId,
            sessionId,
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            ts,
            data: {
              phase,
              startedAt,
              ...(phase === "end" ? { endedAt, executionSettled: true } : {}),
            },
          },
        });
      }
      expect(loadSessionEntryReadOnly(target)).toMatchObject({
        status: "done",
        lastRunId: executionRunId,
      });
      expect(loadSubagentRegistryFromSqlite().get(runId)?.execution.status).toBe("running");

      await fixture.settle();
      await resetSubagentRegistryForTests({ persist: false });
      await cleanupSessionStateForTest({ stateDir: fixture.stateDir });
      rotateAgentEventLifecycleGeneration();
      expect(await waitForAgentJob({ runId: executionRunId, timeoutMs: 0 })).toBeNull();
      await initSubagentRegistry();
      await fixture.activateGatewayRuntime();
      await fixture.settle();
      await testing.sweepOnceForTests();
      await fixture.settle();

      expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
        execution: { status: "terminal", startedAt, endedAt, outcome: { status: "ok" } },
        completion: {
          resultText: finalText,
          terminalReply: { disposition: "visible", text: finalText },
        },
        delivery: { status: "delivered" },
      });
      await testing.sweepOnceForTests();
      await fixture.settle();
      expect(
        vi.mocked(runSubagentAnnounceFlow).mock.calls.filter(([call]) => call.childRunId === runId),
      ).toEqual([
        [
          expect.objectContaining({
            childRunId: runId,
            outcome: expect.objectContaining({ status: "ok" }),
            terminalReply: { disposition: "visible", text: finalText },
          }),
        ],
      ]);
    },
  );

  async function prepareStaleWake(mapping: "claim" | "receipt" | "unmapped") {
    await resetSubagentRegistryForTests({ persist: false });
    vi.mocked(onAgentEvent).mockReset();
    await fixture.activateGatewayRuntime();
    vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("delivered");
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.UTC(2026, 0, 1);
    vi.setSystemTime(now);
    const sessionKey = "agent:main:subagent:sweep-lead";
    const sessionId = "sweep-lead-session";
    const lifecycleRevision = "sweep-lead-revision";
    const runId = "announce:requester-settle:sweep-pause-wake";
    const executionRunId = `sweep-recovered-${mapping}`;
    const finalText = "Worker results are already pending; the lead is still blocked.";
    const startedAt = now - 10_000;
    const endedAt = now - 5_000;
    const wake = makeRestartRecoveryRun({
      runId,
      childSessionKey: sessionKey,
      childAgentId: "main",
      childSessionIdentity: { sessionId, lifecycleRevision },
      requesterSessionKey: "agent:main:director",
      expectsCompletionMessage: true,
      createdAt: now - 60_000,
      execution: { status: "running", startedAt: now - 60_000 },
    });
    await prepareSubagentRecoveryFixture(wake, { stateDir: fixture.stateDir });
    await addSubagentRunForTests(wake);
    const storePath = await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey,
      defaultSessionId: sessionId,
      lifecycleRevision,
    });
    const target = { agentId: "main", storePath, sessionKey };
    await replaceSessionEntry(target, {
      ...loadSessionEntryReadOnly(target)!,
      status: "done",
      lifecycleRunId: "later-parent-followup",
      startedAt: now - 2_000,
      endedAt: now - 1_000,
      updatedAt: now - 1_000,
      ...(mapping === "claim"
        ? {
            restartRecoveryDeliveryRunId: executionRunId,
            restartRecoveryDeliverySourceRunId: runId,
          }
        : {
            restartRecoveryTerminalDeliveryEvidence: [
              {
                runId: mapping === "receipt" ? runId : "another-registered-wake",
                transcriptRunId: executionRunId,
                captured: true as const,
                payloads: [{ visible: true }],
              },
            ],
          }),
    });
    setGatewayDedupeEntry({
      dedupe: new Map(),
      key: `agent:${executionRunId}`,
      entry: {
        ts: endedAt,
        ok: true,
        payload: {
          status: "completed",
          startedAt,
          endedAt,
          terminalReply: { disposition: "visible", text: finalText },
        },
      },
      session: {
        sessionKey,
        sessionId,
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
    });
    return { runId, executionRunId, sessionKey, sessionId, finalText, startedAt, endedAt, now };
  }

  it.each(["claim", "receipt"] as const)(
    "sweeps a stale pause wake using its own recovered execution (%s)",
    async (mapping) => {
      try {
        const run = await prepareStaleWake(mapping);
        await testing.sweepOnceForTests();
        await fixture.settle();
        expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
          execution: {
            status: "terminal",
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            outcome: { status: "ok" },
          },
          completion: { resultText: run.finalText },
          delivery: { status: "delivered" },
        });
        emitAgentEvent({
          runId: run.executionRunId,
          sessionKey: run.sessionKey,
          sessionId: run.sessionId,
          agentId: "main",
          lifecycleGeneration: getAgentEventLifecycleGeneration(),
          stream: "lifecycle",
          data: {
            phase: "end",
            startedAt: run.startedAt,
            endedAt: run.endedAt,
            terminalReply: { disposition: "visible", text: run.finalText },
            executionSettled: true,
          },
        });
        await fixture.settle();
        await testing.sweepOnceForTests();
        await fixture.settle();
        expect(
          vi
            .mocked(runSubagentAnnounceFlow)
            .mock.calls.filter(([call]) => call.childRunId === run.runId),
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("leaves an unmapped stale wake pending until its own stale-run cutoff", async () => {
    try {
      const run = await prepareStaleWake("unmapped");
      await testing.sweepOnceForTests();
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
        execution: { status: "running", startedAt: run.now - 60_000 },
      });
      expect(vi.mocked(runSubagentAnnounceFlow)).not.toHaveBeenCalled();
      vi.setSystemTime(run.now + 2 * 60 * 60 * 1_000);
      await testing.sweepOnceForTests();
      await fixture.settle();
      expect(loadSubagentRegistryFromSqlite().get(run.runId)).toMatchObject({
        execution: {
          status: "terminal",
          endedAt: run.now + 2 * 60 * 60 * 1_000,
          outcome: { status: "error", error: "subagent run lost active execution context" },
        },
        delivery: { status: "delivered" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["visible", "missing"] as const)(
    "settles an admitted wake from its recovered %s final",
    async (reply) => {
      await resetSubagentRegistryForTests({ persist: false });
      vi.mocked(onAgentEvent).mockReset();
      await fixture.activateGatewayRuntime();
      vi.mocked(runSubagentAnnounceFlow).mockResolvedValue("delivered");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const sessionKey = "agent:main:subagent:lead";
      const sessionId = "lead-session";
      const lifecycleRevision = "lead-revision";
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      const runId = buildRequesterSettleWakeIdentity({
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        batchRunIds: ["worker"],
        rearmGeneration: 1,
      }).runId;
      const storePath = await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey,
        defaultSessionId: sessionId,
        lifecycleRevision,
      });
      const target = { agentId: "main", storePath, sessionKey };
      const provenance = {
        kind: "inter_session" as const,
        sourceTool: "subagent_settle",
        sourceChannel: "internal",
        sourceSessionKey: "agent:main:subagent:worker",
      };
      await replaceSessionEntry(
        target,
        prepareCommandSessionRecoveryEntry({
          entry: { ...loadSessionEntryReadOnly(target)!, spawnDepth: 1 },
          sessionId,
          sessionKey,
          agentId: "main",
          runId,
          now: Date.now(),
          lifecycleGeneration,
          isSessionRollover: false,
          opts: { message: "Continue with the worker result.", inputProvenance: provenance },
        }).nextEntry,
      );
      await persistGatewaySessionLifecycleEvent({
        sessionKey,
        event: {
          runId,
          sessionId,
          lifecycleGeneration,
          ts: Date.now(),
          data: { phase: "start", startedAt: Date.now() },
        },
      });
      await appendTranscriptMessage(
        { ...target, sessionId },
        {
          cwd: fixture.stateDir,
          message: {
            role: "user",
            content: "Continue with the worker result.",
            idempotencyKey: runId,
            provenance,
          },
        },
      );
      await appendTranscriptMessage(
        { ...target, sessionId },
        { message: { role: "toolResult", content: "Saved progress before the crash." } },
      );
      const worker = makeRestartRecoveryRun({
        runId: "worker",
        childSessionKey: "agent:main:subagent:worker",
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        completionRequesterSessionId: sessionId,
        completionRequesterLifecycleRevision: lifecycleRevision,
        expectsCompletionMessage: true,
        requesterTurnRunId: "lead-original-turn",
        execution: { status: "terminal", endedAt: Date.now(), outcome: { status: "ok" } },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          batchRunIds: ["worker"],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      const wake = makeRestartRecoveryRun({
        runId,
        childSessionKey: sessionKey,
        childAgentId: "main",
        childSessionIdentity: { sessionId, lifecycleRevision },
        requesterSessionKey: "agent:main:director",
        expectsCompletionMessage: true,
        execution: { status: "running", startedAt: Date.now(), lifecycleGeneration },
      });
      await prepareSubagentRecoveryFixture(wake, { stateDir: fixture.stateDir });
      await prepareSubagentRecoveryFixture(worker, {
        stateDir: fixture.stateDir,
        entries: { [sessionKey]: loadSessionEntryReadOnly(target)! },
      });
      worker.requesterStorePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
      await replaceSessionEntry(target, {
        ...loadSessionEntryReadOnly(target)!,
        restartRecoveryOperatorSource: { ...worker.operatorRecoverySource!, sourceRunId: runId },
      });
      await addSubagentRunForTests(worker);
      await addSubagentRunForTests(wake);
      rotateAgentEventLifecycleGeneration();
      bindGatewayContextResolver(
        subagentRuns.get(worker.runId)!,
        getGatewayContextResolver(fixture.gatewayRuntime)!,
      );
      try {
        const recoverWake = () =>
          recoverInterruptedSubagentRow({
            runId,
            entry: subagentRuns.get(runId)!,
            gatewayRuntime: fixture.gatewayRuntime,
            isCurrent: () => true,
            warn: vi.fn(),
          });
        expect(await recoverWake()).toEqual({ status: "handled" });
        expect(
          await markStartupOrphanedMainSessionsForRecovery({ stateDir: fixture.stateDir }),
        ).toMatchObject({ marked: 1 });
        expect(loadSessionEntryReadOnly(target)?.lifecycleRunId).toBeUndefined();
        expect(await recoverWake()).toEqual({ status: "handled" });
        const settlement = createDeferred();
        const dispatch = vi.spyOn(gatewayCall, "callGateway").mockResolvedValue({ runId });
        const runtime = createRecoveryRuntimeFixture({
          callGateway: gatewayCall.callGateway,
          getDispatchSettlement: () => settlement.promise,
          sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
        });
        Object.assign(fixture.gatewayRuntime, runtime);
        try {
          expect(
            await recoverRestartAbortedMainSessions({
              stateDir: fixture.stateDir,
              gatewayRuntime: fixture.gatewayRuntime,
            }),
          ).toMatchObject({ started: 1, failed: 0 });
          await recoverRestartAbortedMainSessions({
            stateDir: fixture.stateDir,
            gatewayRuntime: fixture.gatewayRuntime,
          });
          expect(dispatch).toHaveBeenCalledOnce();
          expect(loadSessionEntryReadOnly(target)).toMatchObject({
            restartRecoveryDeliverySourceRunId: runId,
            abortedLastRun: false,
          });
          const events = await loadTranscriptEvents({ ...target, sessionId });
          expect(
            events.filter(
              (event) =>
                isRecord(event) &&
                event.type === "message" &&
                isRecord(event.message) &&
                event.message.role === "user",
            ),
          ).toHaveLength(1);
          expect(subagentRuns.get(runId)?.terminalOwner).toBeUndefined();
          const recovered = loadSessionEntryReadOnly(target)!;
          const recoveryRunId = recovered.restartRecoveryDeliveryRunId!;
          expect(recoveryRunId).toBeTruthy();
          expect(recoveryRunId).not.toBe(runId);
          const finalText = "Integrated the worker result; all checks passed.";
          const terminalReply =
            reply === "visible" ? { disposition: "visible" as const, text: finalText } : undefined;
          if (reply === "visible") {
            await appendTranscriptMessage(
              { ...target, sessionId },
              {
                message: { role: "assistant", content: finalText },
              },
            );
          }
          const endedAt = Date.now() + 1_000;
          vi.setSystemTime(endedAt);
          const event = {
            runId: recoveryRunId,
            sessionKey,
            sessionId,
            agentId: "main",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            stream: "lifecycle",
            data: { phase: "end", endedAt, terminalReply, executionSettled: true },
          };
          emitAgentEvent(event);
          settlement.resolve();
          await fixture.settle();
          const completedSession = {
            ...loadSessionEntryReadOnly(target)!,
            ...buildMainSessionRecoverySettlementPatch({
              entry: recovered,
              recordTerminalSource: true,
              terminalRunId: recoveryRunId,
              terminalDeliveryEvidence: {
                captured: true,
                payloads: [{ visible: reply === "visible" }],
              },
            }),
            status: "done" as const,
            endedAt,
            updatedAt: endedAt,
          };
          await replaceSessionEntry(target, completedSession);
          await testing.sweepOnceForTests();
          await fixture.settle();
          const outcome =
            reply === "visible"
              ? { status: "ok" }
              : { status: "error", error: "subagent run ended before producing a final reply" };
          expect(loadSubagentRegistryFromSqlite().get(runId)).toMatchObject({
            execution: { status: "terminal", outcome },
            completion: { resultText: reply === "visible" ? finalText : null },
            delivery: { status: "delivered" },
          });
          const parentCompletions = () =>
            vi
              .mocked(runSubagentAnnounceFlow)
              .mock.calls.filter(([call]) => call.childRunId === runId);
          expect(parentCompletions()).toEqual([
            [
              expect.objectContaining({
                childRunId: runId,
                outcome: expect.objectContaining(outcome),
              }),
            ],
          ]);
          // The terminal receipt still routes a duplicate after recovery clears its claim.
          emitAgentEvent(event);
          await fixture.settle();
          expect(parentCompletions()).toHaveLength(1);
        } finally {
          settlement.resolve();
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
