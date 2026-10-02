import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolveRuntimeProcessEntrypointUrl } from "../../../infra/runtime-process-url.js";
import { WorkerTaskPool } from "../../../infra/worker-task-pool.js";
import type { Edit, EditDiffError, EditDiffResult } from "./edit-diff.js";
import type {
  FileToolPlanningRequest,
  FileToolPlanningResult,
} from "./file-tool-planning.worker.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";

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

/** Preview reads stay with the caller; execution always plans against its own queued read. */
export async function computeEditsDiff(
  path: string,
  edits: Edit[],
  cwd: string,
  operations?: {
    readFile: (absolutePath: string) => Promise<Buffer | string>;
    access: (absolutePath: string) => Promise<void>;
  },
  resolvePath = operations ? resolveToCwd : resolveLocalPathToCwd,
): Promise<EditDiffResult | EditDiffError> {
  const absolutePath = resolvePath(path, cwd);
  try {
    try {
      await (operations ? operations.access(absolutePath) : access(absolutePath, constants.R_OK));
    } catch (error: unknown) {
      const message =
        error instanceof Error && "code" in error
          ? `Error code: ${String(error.code)}`
          : String(error);
      return { error: `Could not edit file: ${path}. ${message}.` };
    }
    const raw = operations
      ? await operations.readFile(absolutePath)
      : await readFile(absolutePath, "utf8");
    const prepared = await planFileEdit({
      path,
      edits,
      content: typeof raw === "string" ? raw : raw.toString("utf8"),
    });
    return prepared.changed
      ? { diff: prepared.receipt.diff, firstChangedLine: prepared.receipt.firstChangedLine }
      : { diff: "", firstChangedLine: undefined };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
