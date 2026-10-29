import { getProcessSupervisor } from "../process/supervisor/index.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import { waitForExecScope } from "./bash-process-registry.js";

export function registerOneShotExecScopeCleanup(
  options: InternalCodingToolsOptions | undefined,
  scopeKey: string | undefined,
): void {
  if (!options?.oneShotCliRun || !scopeKey || !options.registerRunCleanup) {
    return;
  }
  const supervisor = getProcessSupervisor();
  // Sandbox runtimes retain their configured lifetime; host commands still
  // need tree cleanup, including elevated commands from sandboxed sessions.
  const cleanupScope = supervisor.acquireScopeCleanup(scopeKey, { processTree: "owned-only" });
  options.registerRunCleanup(async () => {
    // Transport closure can precede backend finalization. Join both owners
    // before their local artifacts or the invocation state can be released.
    const settled = await Promise.allSettled([cleanupScope(), waitForExecScope(scopeKey)]);
    const failed = settled.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
  });
}
