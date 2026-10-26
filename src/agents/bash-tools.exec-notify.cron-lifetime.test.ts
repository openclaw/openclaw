import "../test-utils/prepare-compiled-subprocesses.js";
import { describe, expect, it, vi } from "vitest";
import * as handoff from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  bindCronJobAdmittedRun,
  clearCronJobActive,
  markCronJobActive,
} from "../cron/active-jobs.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { addSession, markBackgrounded } from "./bash-process-registry.js";
import { createProcessSessionFixture } from "./bash-process-registry.test-helpers.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import {
  maybeNotifyOnExit,
  prepareExecExitNotification,
  recoverExecExitNotifications,
} from "./bash-tools.exec-notify.js";
import { createAgentRunDirectAbortError, isAgentRunDirectAbortReason } from "./run-termination.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

// The queue is external I/O here. This proves the real producer's captured cancellation
// contract; queue enforcement and Gateway/model execution have separate integration proof.
describe("cron background completion lifetime", () => {
  it.each(["timeout", "operator cancellation"] as const)(
    "keeps accepted and late exec notifications bound to cron %s",
    async (terminal) => {
      await withOpenClawTestState({ label: `exec-cron-${terminal}` }, async (state) => {
        const config = { agents: { entries: { main: {} } } };
        setRuntimeConfigSnapshot(config);
        openOpenClawStateDatabase({ env: state.env });
        const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
        const jobId = "bounded-maintenance";
        const runId = "source-model-turn";
        const sessionId = "cron-occurrence";
        const sessionKey = `agent:main:cron:${jobId}:run:${sessionId}`;
        writeSessionEntry(database, sessionKey, {
          sessionId,
          lifecycleRevision: "original-revision",
          updatedAt: 1,
          permissionMode: "full",
        });
        const marker = markCronJobActive(jobId, { agentId: "main" });
        const controller = new AbortController();
        const admission = prepareAgentRunAdmission({
          cfg: config,
          operationalRunInstance: createOperationalRunInstanceRef(runId),
          facts: {
            runId,
            agentId: "main",
            ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          },
        });
        const admitted = await admission.admit("embedded");
        bindCronJobAdmittedRun(marker, admitted, controller.signal);
        const claim = claimAgentRunContext(
          runId,
          { agentId: "main", sessionKey, sessionId },
          { trackOwner: true },
        );
        const enqueue = vi.spyOn(handoff, "enqueueSessionEventForHost").mockImplementation(() => ({
          id: "accepted-exec",
          cancel: () => true,
          accepted: Promise.resolve({ ok: true }),
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
        }));
        const processes = ["accepted-result", "late-result"].map((id) => {
          const process = createProcessSessionFixture({ id, command: "synthetic" });
          Object.assign(process, {
            agentId: "main",
            sessionKey,
            notifyOnExit: true,
            notifyOnExitEmptySuccess: true,
            tail: "synthetic retained result",
          });
          addSession(process);
          return process;
        });
        try {
          for (const process of processes) {
            await withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey,
                operationalRunInstance: admitted.operationalRunInstance,
                receiptAuthority: () => !controller.signal.aborted,
              },
              () => prepareExecExitNotification(process, false),
            );
            expect(process.notifySessionTarget).toBeDefined();
            markBackgrounded(process);
          }
          await maybeNotifyOnExit(processes[0]!, "completed", false);
          expect(enqueue).toHaveBeenCalledTimes(1);
          const options = enqueue.mock.calls[0]![1];
          releaseAgentRunContext(runId, claim);
          admission.close();
          // Queue acceptance outlives the model invocation, but never a revoked cron occurrence.
          expect(() => options.expectedTarget?.assertCurrent?.()).not.toThrow();
          if (terminal === "timeout") {
            const error = new Error("cron: job execution timed out");
            error.name = "TimeoutError";
            controller.abort(error);
          } else {
            controller.abort(createAgentRunDirectAbortError());
          }
          expect(() => options.expectedTarget?.assertCurrent?.()).toThrow();
          expect(options.abortSignal?.aborted).toBe(true);
          expect(isAgentRunDirectAbortReason(options.abortSignal?.reason)).toBe(true);
          await maybeNotifyOnExit(processes[1]!, "completed", false);
          expect(enqueue).toHaveBeenCalledTimes(1);
          for (const process of processes) {
            expect(process.tail).toBe("synthetic retained result");
            expect(process.exitNotificationPersistence).toBeUndefined();
          }
          // Keep the exact cron session on disk across a simulated Gateway incarnation.
          // Its completed occurrence never leaves a restart notification obligation.
          clearCronJobActive(jobId, marker);
          resetProcessRegistryForTests();
          rotateAgentEventLifecycleGeneration();
          const retained = await readSessionEntryReadOnlyInWorker({
            agentId: "main",
            sessionKey,
            env: state.env,
            storePath: database.path,
          });
          expect(retained?.sessionId).toBe(sessionId);
          expect(retained?.pendingExecNotifications).toBeUndefined();
          await recoverExecExitNotifications(config, new AbortController().signal);
          expect(enqueue).toHaveBeenCalledTimes(1);
        } finally {
          controller.abort();
          clearCronJobActive(jobId, marker);
          releaseAgentRunContext(runId, claim);
          admission.close();
          enqueue.mockRestore();
          resetProcessRegistryForTests();
        }
      });
    },
  );
});
