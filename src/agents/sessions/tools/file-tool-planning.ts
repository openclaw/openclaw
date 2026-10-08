import { resolveRuntimeProcessEntrypointUrl } from "../../../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../../../infra/worker-task-pool.js";
import type {
  FileToolPlanningRequest,
  FileToolPlanningResult,
} from "./file-tool-planning.worker.js";

const pool = new WorkerTaskPool<FileToolPlanningRequest, FileToolPlanningResult>({
  sharedCompute: true,
  workerUrl: resolveRuntimeProcessEntrypointUrl("fileToolPlanning"),
});

function plan(input: FileToolPlanningRequest, signal?: AbortSignal) {
  const chars =
    input.path.length +
    input.content.length +
    (input.kind === "edit"
      ? input.edits.reduce((sum, edit) => sum + edit.oldText.length + edit.newText.length, 0)
      : (input.beforeText?.length ?? 0));
  return pool.run(input, { signal, inputBytes: chars * 2 });
}

export async function planFileEdit(
  input: Omit<Extract<FileToolPlanningRequest, { kind: "edit" }>, "kind">,
  signal?: AbortSignal,
) {
  const result = await plan({ kind: "edit", ...input }, signal);
  if (result.kind !== "edit") {
    throw new Error("Unexpected file edit planning result");
  }
  return result.plan;
}

export async function planFileWriteDiff(
  input: Omit<Extract<FileToolPlanningRequest, { kind: "write" }>, "kind">,
  signal?: AbortSignal,
) {
  const result = await plan({ kind: "write", ...input }, signal);
  if (result.kind !== "write") {
    throw new Error("Unexpected file write planning result");
  }
  return result.receipt;
}
