import { expect, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";

type RecoveryScope = { storePath: string; sessionKey: string };

export function createRecoveryRuntimeFixture(params: {
  callGateway: typeof callGateway;
  getDispatchSettlement: () => Promise<void>;
  sendRecoveryNotice: GatewayRecoveryRuntime["sendRecoveryNotice"];
}) {
  const expectState = async (
    expectedGatewayCalls: number,
    scopes: RecoveryScope[],
    matches: (entry: NonNullable<ReturnType<typeof loadSessionEntry>>) => boolean,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const targets = scopes.map((scope) => {
      const entry = loadSessionEntry(scope);
      expect(entry, "recovery fixture session must exist").toBeDefined();
      return { scope, sessionId: entry?.sessionId };
    });
    const settled = createDeferred();
    const observe = () => {
      try {
        if (
          targets.every(({ scope, sessionId }) => {
            const entry = loadSessionEntry(scope);
            return entry !== undefined && entry.sessionId === sessionId && matches(entry);
          })
        ) {
          settled.resolve();
        }
      } catch (error) {
        // Session-change listeners isolate throws, so this wait must retain its read failure.
        settled.reject(error);
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
    const abort = () => settled.reject(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    onTestFinished(unsubscribe);
    try {
      signal?.throwIfAborted();
      // Subscribe before reading so an already committed state also completes.
      observe();
      await settled.promise;
      signal?.throwIfAborted();
      expect(params.callGateway).toHaveBeenCalledTimes(expectedGatewayCalls);
    } finally {
      unsubscribe();
      signal?.removeEventListener("abort", abort);
    }
  };
  return {
    expectAdmission: (expectedGatewayCalls: number, ...scopes: RecoveryScope[]) =>
      expectState(expectedGatewayCalls, scopes, (entry) => entry.abortedLastRun === false),
    async expectFailedRecovery(
      expectedGatewayCalls: number,
      recovery: { stop: () => Promise<void> },
      signal: AbortSignal,
      ...scopes: RecoveryScope[]
    ) {
      try {
        await expectState(
          expectedGatewayCalls,
          scopes,
          (entry) => entry.status === "failed" && entry.abortedLastRun === false,
          signal,
        );
      } finally {
        await recovery.stop();
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
