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
  consume: (defaults: ResolvedExecDefaults) => Promise<T>,
): Promise<T> {
  const { agentId } = resolveExecConfigState(params);
  const scope = { cfg: params.cfg, agentId, sessionKey: params.sessionKey };
  return await withSandboxRuntimeStatusInWorker(scope, shared, async (sandbox) => {
    const defaults = await resolvePreparedExecDefaultsAsync(
      prepareExecDefaults(params, sandbox),
      shared.loadExecApprovals,
    );
    shared.assertCurrent();
    return await consume(defaults);
  });
}
