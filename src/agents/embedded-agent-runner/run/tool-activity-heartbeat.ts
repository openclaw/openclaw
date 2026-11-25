import { notifyToolActivity } from "../../../shared/tool-activity-heartbeat.js";
import { wrapAgentToolExecutionContext } from "../../agent-tool-metadata.js";
import type { AnyAgentTool } from "../../tools/common.js";

export async function withEmbeddedAttemptToolActivity<R>(
  runId: string,
  operation: () => Promise<R>,
): Promise<R> {
  const interval = setInterval(() => notifyToolActivity(runId), 60_000);
  interval.unref();
  try {
    notifyToolActivity(runId);
    return await operation();
  } finally {
    clearInterval(interval);
    notifyToolActivity(runId);
  }
}

export function wrapEmbeddedAttemptToolWithActivity<T extends AnyAgentTool>(
  tool: T,
  runId: string,
): T {
  const originalExecute = tool.execute;
  return wrapAgentToolExecutionContext(
    tool,
    ((...args: Parameters<typeof originalExecute>) =>
      withEmbeddedAttemptToolActivity(runId, () =>
        originalExecute(...args),
      )) as typeof originalExecute,
    (operation) => withEmbeddedAttemptToolActivity(runId, operation),
    (source) => wrapEmbeddedAttemptToolWithActivity(source, runId),
  );
}
