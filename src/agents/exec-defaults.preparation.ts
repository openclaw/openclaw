import { prepareExecApprovalsCurrentRead } from "../infra/exec-approvals-store.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  prepareExecDefaults,
  resolveExecConfigState,
  resolvePreparedExecDefaultsAsync,
  type ResolveExecDefaultsParams,
  type ResolvedExecDefaults,
} from "./exec-defaults.js";
import { withSandboxRuntimeStatusInWorker } from "./sandbox/runtime-status.js";
import type { PreparedToolConstruction } from "./tool-construction-preparation.js";

/** Keep classification and approval preparation inside the consuming construction's lifetime. */
export async function withPreparedExecDefaults<T>(
  params: ResolveExecDefaultsParams,
  shared: PreparedToolConstruction,
  consume: (
    defaults: ResolvedExecDefaults,
    prepareCurrentRead: () => Promise<() => ResolvedExecDefaults>,
  ) => Promise<T>,
): Promise<T> {
  const { agentId } = resolveExecConfigState(params);
  const scope = { cfg: params.cfg, agentId, sessionKey: params.sessionKey };
  return await withSandboxRuntimeStatusInWorker(scope, shared, async (sandbox) => {
    const preparation = prepareExecDefaults(params, sandbox);
    const defaults = await resolvePreparedExecDefaultsAsync(preparation, shared.loadExecApprovals);
    shared.assertCurrent();
    return await consume(defaults, async () => {
      if (preparation.kind === "resolved") {
        shared.assertCurrent();
        return () => preparation.defaults;
      }
      const read = await prepareExecApprovalsCurrentRead(
        captureOpenClawStateWorkerContext({ env: shared.env }),
      );
      shared.assertCurrent();
      return () => preparation.resolve(read());
    });
  });
}
