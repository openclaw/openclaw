import { captureCronJobContinuationLifetime } from "../cron/active-jobs.js";
import { execRequestAbortSignal, type ExecRequestOwner } from "../infra/exec-request-context.js";
import type { SpawnInitiation } from "../process/spawn-initiation.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isCronRunSessionKey } from "../sessions/session-key-utils.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

/** Compose startup cancellation without detaching physical work from its cron occurrence. */
export function prepareExecSignals(
  opts: { sessionKey?: string; requestOwners?: readonly ExecRequestOwner[] },
  initialStartupSignal?: AbortSignal,
) {
  const caller = getGatewayToolCallerIdentity();
  const cronJobId = isCronRunSessionKey(opts.sessionKey)
    ? parseAgentSessionKey(opts.sessionKey)?.rest.split(":")[1]
    : undefined;
  const cronLifetime = cronJobId
    ? captureCronJobContinuationLifetime(cronJobId, [
        ...(caller?.operationalRunInstance ? [caller.operationalRunInstance.runId] : []),
        ...(opts.requestOwners ?? []).flatMap((request) => Array.from(request.turnRunIds)),
      ])
    : undefined;
  // Physical background work belongs to the occurrence even when exit notifications
  // are disabled and the original model turn has already released its request scope.
  const requestSignal = execRequestAbortSignal(opts.requestOwners, cronLifetime?.signal);
  const startupSignal =
    requestSignal && initialStartupSignal
      ? AbortSignal.any([requestSignal, initialStartupSignal])
      : (requestSignal ?? initialStartupSignal);
  return { requestSignal, startupSignal };
}

export class ExecProcessPreflightError extends Error {
  constructor(readonly result: AgentToolResult<ExecToolDetails>) {
    super("exec denied by final preflight");
  }

  static unwrap(error: unknown): AgentToolResult<ExecToolDetails> {
    if (error instanceof ExecProcessPreflightError) {
      return error.result;
    }
    throw error;
  }
}

/** Retain launch custody separately from process lifetime and proven-no-initiation fallback. */
export function createExecLaunchLifecycle(
  initialInitiation?: SpawnInitiation,
  initialRelease?: (reason?: "retry") => void,
) {
  let initiateSpawn = initialInitiation;
  let releaseSpawn = initialRelease;
  let initiated = false;
  const release = (reason?: "retry") => releaseSpawn?.(reason);
  return {
    get initiated() {
      return initiated;
    },
    release,
    async prepare(
      assertSource: (() => void) | undefined,
      beforeSpawn: (() => Promise<AgentToolResult<ExecToolDetails> | undefined>) | undefined,
    ) {
      assertSource?.();
      const denied = await beforeSpawn?.();
      assertSource?.();
      if (denied) {
        throw new ExecProcessPreflightError(denied);
      }
    },
    dispose() {
      release();
      releaseSpawn = undefined;
      initiateSpawn = undefined;
    },
    wrap(assertCurrent: () => void, assertPolicy?: () => void): SpawnInitiation {
      return (launch, settlement) => {
        assertCurrent();
        assertPolicy?.();
        const initiate = () => {
          initiated = true;
          return launch();
        };
        try {
          return initiateSpawn ? initiateSpawn(initiate, settlement) : initiate();
        } finally {
          if (!settlement) {
            release();
          }
        }
      };
    },
  };
}
