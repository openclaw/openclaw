import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withPreparedRestartRecoveryTarget } from "./main-session-recovery-admission.js";
import { createMainSessionRecoveryCapacity } from "./main-session-recovery-capacity.js";
import { dispatchRestartRecoveryWithinCapacity } from "./main-session-restart-dispatch-capacity.js";

it("terminal capacity follows the started child after its actual preparation reader retires", async () => {
  await withOpenClawTestState({ label: "restart-reader-retirement" }, async () => {
    const sessionKey = "agent:main:retired-recovery-reader";
    const sessionId = "retained-child-session";
    const runId = "retained-child-run";
    const target = {
      agentId: "main",
      sessionKey,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    };
    await replaceSessionEntry(target, { sessionId, updatedAt: 1 });
    const claim = claimAgentRunContext(
      runId,
      {
        sessionKey,
        sessionId,
        agentId: "main",
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
      },
      { trackOwner: true, ownsContext: true },
    );
    const firstWait = createDeferredCore<{ status: string; endedAt?: number }>();
    const finalWait = createDeferredCore<{ status: string; endedAt?: number }>();
    const secondWaitEntered = createDeferredCore();
    const capacityReleased = createDeferredCore();
    let waits = 0;
    const runtime: GatewayRecoveryRuntime = {
      dispatchSessionMethod: vi.fn(),
      sendRecoveryNotice: vi.fn(),
      dispatchAgent: async <T>(
        _request: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[0],
        _timeout: number | undefined,
        options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
      ) => {
        options?.onStartOwner?.({
          observe: () => ({ executionStarted: true, expiresAtMs: Date.now() + 60_000 }),
          abort: () => false,
        });
        options?.onAccepted?.({ runId, status: "accepted" });
        await options?.onExecutionStarted?.();
        // Cached acceptance has a real started owner; its terminal is observed via agent.wait.
        return { runId, status: "in_flight" } as T;
      },
      waitForAgent: async <T>() => {
        waits += 1;
        if (waits === 1) {
          return (await firstWait.promise) as T;
        }
        secondWaitEntered.resolve();
        return (await finalWait.promise) as T;
      },
    };
    const capacity = createMainSessionRecoveryCapacity({ limit: 1 });
    let assertReaderCurrent: (() => void) | undefined;
    const release = vi.fn();
    try {
      const outcome = await withPreparedRestartRecoveryTarget(target, async (source) => {
        assertReaderCurrent = source.assertSourceCurrent;
        const permit = await capacity.acquire(() => {
          source.assertSourceCurrent();
          return true;
        });
        return await dispatchRestartRecoveryWithinCapacity({
          agentParams: {
            agentId: "main",
            sessionKey,
            expectedExistingSessionId: sessionId,
            idempotencyKey: runId,
            message: "continue",
          },
          releaseCapacity: () => {
            release();
            permit?.();
            capacityReleased.resolve();
          },
          gatewayRuntime: runtime,
          beginDispatch: () => {
            source.assertSourceCurrent();
            return true;
          },
          shouldContinue: () => {
            source.assertSourceCurrent();
            return true;
          },
        });
      });
      expect(outcome?.kind).toBe("started");
      expect(() => assertReaderCurrent!()).toThrow(
        "Session entry read consumer is no longer active",
      );
      expect(release).not.toHaveBeenCalled();
      firstWait.resolve({ status: "timeout" });
      await Promise.race([secondWaitEntered.promise, capacityReleased.promise]);
      expect(waits).toBe(2);
      expect(release).not.toHaveBeenCalled();
      finalWait.resolve({ status: "error", endedAt: 20 });
      await capacityReleased.promise;
      expect(release).toHaveBeenCalledOnce();
      const next = await capacity.acquire(() => true);
      expect(next).toBeDefined();
      next?.();
    } finally {
      firstWait.resolve({ status: "error", endedAt: 20 });
      finalWait.resolve({ status: "error", endedAt: 20 });
      releaseAgentRunContext(runId, claim);
    }
  });
});
