import {
  resolveExecConfigState,
  resolveExecDefaults,
  resolveNodeExecEligibility,
  type ResolveExecDefaultsParams,
} from "./exec-defaults.js";
import { resolveSandboxRuntimeStatusLegacy } from "./sandbox/runtime-status.legacy.js";

/** @deprecated Only for synchronous Plugin SDK compatibility; use resolveExecDefaultsAsync. */
export function resolveExecDefaultsLegacy(params: ResolveExecDefaultsParams) {
  const { agentId } = resolveExecConfigState(params);
  return resolveExecDefaults(
    params,
    params.sessionKey
      ? resolveSandboxRuntimeStatusLegacy({
          cfg: params.cfg,
          sessionKey: params.sessionKey,
          agentId,
        })
      : undefined,
  );
}

/** @deprecated Only for synchronous skill-command discovery compatibility. */
export function resolveNodeExecEligibilityLegacy(
  params: Omit<ResolveExecDefaultsParams, "scope" | "elevatedRequested">,
) {
  return resolveNodeExecEligibility(params, resolveExecDefaultsLegacy(params));
}
