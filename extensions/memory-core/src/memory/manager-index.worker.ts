import { serveWorkerTasks } from "openclaw/plugin-sdk/process-runtime";
import type { MemoryIndexTask, MemoryIndexTaskResult } from "./manager-cpu-worker-runtime.js";
import { prepareMemoryIndexChunks } from "./manager-index-preparation.js";

serveWorkerTasks<MemoryIndexTaskResult>((input) => {
  // SAFETY: The paired runtime owns this private discriminated task protocol.
  const task = input as MemoryIndexTask;
  if (task.kind === "prepare") {
    return { kind: "prepared", value: prepareMemoryIndexChunks(task.input) };
  }
  throw new Error("Invalid memory indexing task");
});
