import { expect, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";

export function createRecoveryRuntimeFixture(params: {
  callGateway: typeof callGateway;
  getDispatchSettlement: () => Promise<void>;
  sendRecoveryNotice: GatewayRecoveryRuntime["sendRecoveryNotice"];
}) {
  return {
    async expectAdmission(
      expectedGatewayCalls: number,
      ...scopes: Array<{ storePath: string; sessionKey: string }>
    ) {
      const targets = scopes.map((scope) => {
        const entry = loadSessionEntry(scope);
        expect(entry, "recovery fixture session must exist").toBeDefined();
        return { scope, sessionId: entry?.sessionId };
      });
      const admitted = createDeferred();
      const observe = () => {
        if (
          targets.every(({ scope, sessionId }) => {
            const entry = loadSessionEntry(scope);
            return entry?.sessionId === sessionId && entry?.abortedLastRun === false;
          })
        ) {
          admitted.resolve();
        }
      };
      const unsubscribe = sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          targets.some(({ scope }) => scope.sessionKey === change.sessionKey)
        ) {
          observe();
        }
      });
      onTestFinished(unsubscribe);
      try {
        // Subscribe before reading so an already committed admission also completes.
        observe();
        await admitted.promise;
        expect(params.callGateway).toHaveBeenCalledTimes(expectedGatewayCalls);
      } finally {
        unsubscribe();
      }
    },
    dispatchSessionMethod: vi.fn(),
    dispatchAgent: async <T>(
      request: Record<string, unknown>,
      timeoutMs?: number,
      options?: Parameters<GatewayRecoveryRuntime["dispatchAgent"]>[2],
    ) => {
      const result = (await params.callGateway({
        method: "agent",
        params: request,
        timeoutMs,
      })) as T;
      const status = (result as { status?: unknown } | undefined)?.status;
      if (status === undefined) {
        options?.onStartOwner?.({
          observe: () => ({ executionStarted: true, expiresAtMs: Date.now() + 60_000 }),
          abort: () => false,
        });
        options?.onAccepted?.(result);
        options?.onExecutionStarted?.();
        await params.getDispatchSettlement();
      }
      return result;
    },
    waitForAgent: async <T>(request: Record<string, unknown>, timeoutMs?: number) => {
      if (request.timeoutMs === 30_000) {
        // Capacity observation follows this fixture's actual dispatch lifetime;
        // zero-time recovery probes below retain their independent RPC plan.
        await params.getDispatchSettlement();
        return { status: "ok", endedAt: Date.now() } as T;
      }
      return (await params.callGateway({ method: "agent.wait", params: request, timeoutMs })) as T;
    },
    sendRecoveryNotice: params.sendRecoveryNotice,
  };
}
