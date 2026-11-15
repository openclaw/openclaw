import { serveWorkerTasks } from "../../../infra/worker-task-server.js";
import { isTrustedToolInputError } from "../../tool-input-error.js";
import { prepareFileEdit, type Edit } from "./edit-diff.js";
import { prepareFileWriteDiff } from "./file-diff.js";

export type FileToolPlanningRequest =
  | { kind: "edit"; path: string; content: string; edits: Edit[] }
  | ({ kind: "write" } & Parameters<typeof prepareFileWriteDiff>[0]);

export type FileToolPlanningResult =
  | { kind: "invalid_input"; message: string }
  | { kind: "edit"; plan: ReturnType<typeof prepareFileEdit> }
  | { kind: "write"; receipt: ReturnType<typeof prepareFileWriteDiff> };

serveWorkerTasks<FileToolPlanningResult, FileToolPlanningRequest>((input) => {
  if (input.kind === "edit") {
    try {
      return { kind: "edit", plan: prepareFileEdit(input.content, input.edits, input.path) };
    } catch (error) {
      if (error instanceof Error && isTrustedToolInputError(error)) {
        return { kind: "invalid_input", message: error.message };
      }
      throw error;
    }
  }
  return { kind: "write", receipt: prepareFileWriteDiff(input) };
});
