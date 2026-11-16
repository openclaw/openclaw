import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import { isContextOverflowErrorFromTables } from "./failover/context-overflow-tables.js";

/**
 * A precheck publishes a tentative overflow lifecycle error before recovery runs.
 * When recovery then fails, its own result names the cause; the tentative error
 * must not replace it.
 */
export function resolveCompactionRecoveryLifecycleError(
  result: Pick<EmbeddedAgentRunResult, "meta">,
  lifecycleError: string | undefined,
): string | undefined {
  if (
    result.meta.error?.kind !== "compaction_failure" ||
    !lifecycleError ||
    !isContextOverflowErrorFromTables(lifecycleError)
  ) {
    return undefined;
  }
  return (
    result.meta.finalAssistantVisibleText?.trim() ||
    result.meta.error.message.trim() ||
    "Auto-compaction failed. Try again or run /compact."
  );
}
