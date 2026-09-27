import {
  clearToolActivityRun,
  getLastToolActivityMs,
  notifyToolActivity,
  onToolActivity,
} from "../../../shared/tool-activity-heartbeat.js";
import { copyAgentToolMetadata } from "../../agent-tool-metadata.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../../runtime/internal-hooks.js";
import type { AnyAgentTool } from "../../tools/common.js";

export { clearToolActivityRun, getLastToolActivityMs, notifyToolActivity, onToolActivity };

export async function withEmbeddedAttemptToolActivity<R>(
  runId: string,
  operation: () => Promise<R>,
): Promise<R> {
  const interval = setInterval(() => notifyToolActivity(runId), 60_000);
  interval.unref?.();
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
  const wrappedTool = {
    ...tool,
    execute: ((...args: Parameters<typeof originalExecute>) =>
      withEmbeddedAttemptToolActivity(runId, () =>
        originalExecute(...args),
      )) as typeof originalExecute,
  } as T;
  // Tool metadata is identity-keyed, so object spread is insufficient.
  copyAgentToolMetadata(tool, wrappedTool, (source) =>
    wrapEmbeddedAttemptToolWithActivity(source, runId),
  );
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(wrappedTool, async (params) => {
      const prepared = await withEmbeddedAttemptToolActivity(runId, () => sourcePreparer(params));
      return prepared.kind === "ready"
        ? {
            ...prepared,
            execute: (start) =>
              withEmbeddedAttemptToolActivity(runId, () => prepared.execute(start)),
          }
        : prepared;
    });
  }
  return wrappedTool;
}
