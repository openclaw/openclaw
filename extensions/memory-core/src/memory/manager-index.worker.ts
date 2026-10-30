import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type { MemoryIndexTask, MemoryIndexTaskResult } from "./manager-cpu-worker-runtime.js";
import { prepareMemoryIndexChunks } from "./manager-index-preparation.js";
import { prepareSessionIndexStream } from "./manager-session-index-preparation.js";

serveWorkerTasks<MemoryIndexTaskResult>(async (input, channel, control) => {
  // SAFETY: The paired runtime owns this private discriminated task protocol.
  const task = input as MemoryIndexTask;
  if (task.kind === "prepare") {
    return { kind: "prepared", value: prepareMemoryIndexChunks(task.input) };
  }
  if (task.kind === "prepare-session") {
    if (!channel) {
      throw new Error("Session index preparation requires its source channel");
    }
    await prepareSessionIndexStream(task.input, channel, control);
    return { kind: "prepared", value: { contentHash: undefined, chunks: [] } };
  }
  if (task.kind === "transcript-stats") {
    // Pure chunk preparation must not cold-load session storage during shutdown drain.
    const { readTranscriptStatsBatchReadOnlySync } =
      await import("openclaw/plugin-sdk/memory-core-host-engine-sessions");
    return {
      kind: "transcript-stats",
      stats: readTranscriptStatsBatchReadOnlySync(
        task.scopes.map((scope) => Object.assign({}, scope, { env: task.env })),
      ),
    };
  }
  throw new Error("Invalid memory indexing task");
});
