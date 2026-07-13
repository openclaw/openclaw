/** Dispatches browser cleanup without holding the subagent completion path. */
import type { cleanupBrowserSessionsForLifecycleEnd } from "../browser-lifecycle-cleanup.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export async function dispatchSubagentBrowserCleanup(params: {
  entry: SubagentRunRecord;
  runId: string;
  cleanupBrowserSessionsForLifecycleEnd?: typeof cleanupBrowserSessionsForLifecycleEnd;
  loadCleanupBrowserSessionsForLifecycleEnd: () => Promise<
    typeof cleanupBrowserSessionsForLifecycleEnd
  >;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  maskRunId: (runId: string) => string;
  maskSessionKey: (sessionKey: string) => string;
  buildSafeLifecycleErrorMeta: (error: unknown) => Record<string, string>;
}): Promise<void> {
  if (params.entry.browserCleanupDispatchedAt !== undefined) {
    return;
  }
  const dispatchedAt = Date.now();
  params.entry.browserCleanupDispatchedAt = dispatchedAt;
  let cleanupBrowserSessions: typeof cleanupBrowserSessionsForLifecycleEnd | undefined;
  try {
    cleanupBrowserSessions =
      params.cleanupBrowserSessionsForLifecycleEnd ??
      (await params.loadCleanupBrowserSessionsForLifecycleEnd());
  } catch (error) {
    if (params.entry.browserCleanupDispatchedAt === dispatchedAt) {
      params.entry.browserCleanupDispatchedAt = undefined;
    }
    params.warn("failed to cleanup browser sessions for completed subagent", {
      error: params.buildSafeLifecycleErrorMeta(error),
      runId: params.maskRunId(params.runId),
      childSessionKey: params.maskSessionKey(params.entry.childSessionKey),
    });
  }
  // The sync marker owns this dispatch; the gate protects successors after handoff.
  if (cleanupBrowserSessions !== undefined) {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      try {
        await cleanupBrowserSessions({
          sessionKeys: [params.entry.childSessionKey],
          ownerId: params.runId,
          onWarn: (message) => params.warn(message, { runId: params.entry.runId }),
        });
      } catch (error) {
        params.warn("failed to cleanup browser sessions for completed subagent", {
          error: params.buildSafeLifecycleErrorMeta(error),
          runId: params.maskRunId(params.runId),
          childSessionKey: params.maskSessionKey(params.entry.childSessionKey),
        });
      }
    }).catch((error: unknown) => {
      if (params.entry.browserCleanupDispatchedAt === dispatchedAt) {
        params.entry.browserCleanupDispatchedAt = undefined;
      }
      params.warn("failed to admit browser cleanup for completed subagent", {
        error: params.buildSafeLifecycleErrorMeta(error),
        runId: params.maskRunId(params.runId),
        childSessionKey: params.maskSessionKey(params.entry.childSessionKey),
      });
    });
  }
}
