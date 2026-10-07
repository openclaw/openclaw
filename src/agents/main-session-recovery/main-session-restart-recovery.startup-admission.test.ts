import path from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { callGateway } from "../../gateway/call.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import * as gatewayWorkAdmission from "../../process/gateway-work-admission.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { scheduleRestartAbortedMainSessionRecovery } from "./main-session-restart-recovery-runtime.js";

// mock-isolation: Keep recovery RPC dispatch synthetic while exercising real startup preparation and cancellation.
vi.mock("../../gateway/call.js", () => ({
  callGateway: vi.fn(async () => ({ runId: "resumed-startup-run" })),
}));

it.for(["resume", "stop"] as const)(
  "handles deferred admission inside startup scope without waiting for later work: %s",
  async (outcome, { signal, onTestFailed }) => {
    vi.mocked(callGateway).mockClear();
    const checkpoints: string[] = [];
    onTestFailed(() => console.error("startup-recovery-checkpoints", JSON.stringify(checkpoints)));
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "main";
      const sessionKey = "agent:main:startup-pending";
      const sessionId = "startup-pending-session";
      const storePath = path.join(state.sessionsDir(agentId), "sessions.json");
      const target = { agentId, sessionKey, sessionId, storePath };
      await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
      await appendTranscriptMessage(target, {
        cwd: state.workspaceDir,
        message: { role: "user", content: "Resume the interrupted work", timestamp: 1 },
      });
      await persistGatewaySessionLifecycleEvent({
        ...target,
        event: {
          ts: 1,
          sessionId,
          runId: "interrupted-startup-run",
          data: { phase: "start", startedAt: 1 },
        },
      });
      const started = loadSessionEntry(target);
      expect(started).toMatchObject({
        lifecycleRunId: "interrupted-startup-run",
        abortedLastRun: false,
      });
      expect(started?.status).toBeUndefined();
      const dispatched = createDeferred();
      vi.mocked(callGateway).mockImplementation(async () => {
        dispatched.resolve();
        return { runId: "resumed-startup-run" };
      });
      const gatewayRuntime = createRecoveryRuntimeFixture({
        callGateway,
        getDispatchSettlement: () => Promise.resolve(),
        sendRecoveryNotice: async () => ({ suppressed: false }),
      });
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const refusal = createAgentDatabaseInspectionRefusal({
          agentId,
          paths: [state.statePath("agents", agentId, "agent", "openclaw-agent.sqlite")],
          reason: "Startup preparation held by the fixture",
          pending: true,
        });
        recordAgentDatabaseAdmissions([refusal], { env: state.env, source: "startup" });
        const releasePreparation = createDeferred();
        const laterWork = createDeferred();
        const preparation = preparePendingAgentDatabase(
          refusal,
          { env: state.env, assertCurrent: () => admission.signal.throwIfAborted() },
          () => releasePreparation.promise,
        );
        admission.track(preparation);
        const lifetime = admission.adopt();
        const firstScan = createDeferred();
        const runRoot = gatewayWorkAdmission.runWithGatewayIndependentRootWorkAdmission;
        const rootSpy = vi
          .spyOn(gatewayWorkAdmission, "runWithGatewayIndependentRootWorkAdmission")
          .mockImplementation((run, label, abortSignal) => {
            const result = runRoot(run, label, abortSignal);
            if (label === "main-session:startup-recovery") {
              void result.then(() => firstScan.resolve(), firstScan.reject);
            }
            return result;
          });
        const recovery = scheduleRestartAbortedMainSessionRecovery({
          delayMs: 0,
          getConfig: () => ({ agents: { entries: { main: {} } } }),
          stateDir: state.stateDir,
          gatewayRuntime,
        });
        try {
          checkpoints.push("waiting-for-first-scan");
          await withinTest(firstScan.promise, signal);
          checkpoints.push("first-scan-complete");
          expect(readAgentDatabaseAdmissionRefusal(agentId, { env: state.env })).toBe(refusal);
          expect(callGateway).not.toHaveBeenCalled();
          checkpoints.push("scan-finished-with-live-refusal-and-no-dispatch");
          admission.track(laterWork.promise);
          if (outcome === "stop") {
            await recovery.stop();
          }
          releasePreparation.resolve();
          await preparation;
          checkpoints.push("preparation-complete");
          expect(readAgentDatabaseAdmissionRefusal(agentId, { env: state.env })).toBeUndefined();
          if (outcome === "resume") {
            checkpoints.push("refusal-cleared-waiting-for-automatic-dispatch");
            await withinTest(dispatched.promise, signal);
            checkpoints.push("automatic-dispatch-observed");
            await gatewayRuntime.expectAdmission(1, recovery, { storePath, sessionKey });
            expect(loadSessionEntry(target)).toMatchObject({ abortedLastRun: false });
          } else {
            expect(callGateway).not.toHaveBeenCalled();
            const stopped = loadSessionEntry(target);
            expect(stopped).toMatchObject({
              lifecycleRunId: "interrupted-startup-run",
              abortedLastRun: false,
            });
            expect(stopped?.status).toBeUndefined();
          }
        } finally {
          releasePreparation.resolve();
          laterWork.resolve();
          await preparation;
          await recovery.stop();
          await lifetime.stop();
          rootSpy.mockRestore();
        }
      });
    });
  },
);
