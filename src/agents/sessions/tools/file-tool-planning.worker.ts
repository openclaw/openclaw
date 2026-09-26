import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { serveWorkerTasks } from "../../../infra/worker-task-server.js";
import { prepareFileEdit, type Edit } from "./edit-diff.js";
import { prepareFileWriteDiff } from "./file-diff.js";

export type FileToolPlanningRequest =
  | { kind: "edit"; path: string; content: string; edits: Edit[] }
  | ({ kind: "write" } & Parameters<typeof prepareFileWriteDiff>[0]);

export type FileToolPlanningResult =
  | { kind: "edit"; plan: ReturnType<typeof prepareFileEdit> }
  | { kind: "write"; receipt: ReturnType<typeof prepareFileWriteDiff> };

function isEdit(value: unknown): value is Edit {
  return isRecord(value) && typeof value.oldText === "string" && typeof value.newText === "string";
}

serveWorkerTasks<FileToolPlanningResult>((input) => {
  if (isRecord(input) && typeof input.path === "string" && typeof input.content === "string") {
    if (input.kind === "edit" && Array.isArray(input.edits) && input.edits.every(isEdit)) {
      return { kind: "edit", plan: prepareFileEdit(input.content, input.edits, input.path) };
    }
    if (
      input.kind === "write" &&
      (input.beforeText === undefined || typeof input.beforeText === "string") &&
      (input.created === undefined || typeof input.created === "boolean")
    ) {
      return {
        kind: "write",
        receipt: prepareFileWriteDiff({
          path: input.path,
          content: input.content,
          beforeText: input.beforeText,
          created: input.created,
        }),
      };
    }
  }
  throw new Error("Invalid file-tool planning request");
});
