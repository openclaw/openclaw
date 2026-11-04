import { FsSafeError } from "openclaw/plugin-sdk/security-runtime";
import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import {
  readWikiPagesTask,
  WIKI_SCAN_YIELD,
  type WikiPageReadResult,
  type WikiPageReadTask,
} from "./query-pages.js";

serveWorkerTasks(async (input, channel, control): Promise<WikiPageReadResult> => {
  // SAFETY: The paired host reader constructs the private task union.
  const task = input as WikiPageReadTask;
  // Scan tasks carry a channel: between segments the host says whether to go on.
  const shouldYield = channel
    ? async () => {
        const reply = await channel.request(null);
        reply.consumed();
        return reply.input === WIKI_SCAN_YIELD;
      }
    : undefined;
  try {
    // Pool cancellation is polled between pages so a cancelled scan stops early.
    return await readWikiPagesTask(
      task,
      { throwIfAborted: () => control.throwIfCancelled() },
      shouldYield,
    );
  } catch (error) {
    // Only an error message crosses the pool boundary; the host rebuilds the
    // boundary refusal from its code so callers keep the same error contract.
    if (error instanceof FsSafeError) {
      return { select: "refused", code: error.code, message: error.message };
    }
    throw error;
  }
});
