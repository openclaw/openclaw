import fs from "node:fs";
import path from "node:path";
import { ErrorCodes } from "./error-codes.js";
import { expandHome } from "./paths.js";

export function readTask(taskPath) {
  const resolvedPath = path.resolve(expandHome(taskPath));
  const raw = fs.readFileSync(resolvedPath, "utf8");
  return JSON.parse(raw);
}

export function validateTask(task) {
  if (!task || typeof task !== "object") {
    return { ok: false, code: ErrorCodes.E_TASK_INVALID, message: "Task must be an object." };
  }
  if (!task.taskId || typeof task.taskId !== "string") {
    return { ok: false, code: ErrorCodes.E_TASK_INVALID, message: "taskId is required." };
  }
  if (!task.input || typeof task.input !== "object") {
    return { ok: false, code: ErrorCodes.E_TASK_INVALID, message: "input is required." };
  }
  const { exactPath, fileHint, layerName, newText, edits } = task.input;
  if (!exactPath && !fileHint) {
    return {
      ok: false,
      code: ErrorCodes.E_TASK_INVALID,
      message: "input.exactPath or input.fileHint is required.",
    };
  }
  const hasLegacy = typeof layerName === "string" && typeof newText === "string";
  const hasEdits = Array.isArray(edits) && edits.length > 0;
  if (!hasLegacy && !hasEdits) {
    return {
      ok: false,
      code: ErrorCodes.E_TASK_INVALID,
      message: "input.edits[] or input.layerName/input.newText is required.",
    };
  }
  return { ok: true, code: ErrorCodes.OK };
}

export function normalizeTask(task) {
  const edits = Array.isArray(task.input.edits)
    ? task.input.edits
    : [{ layerName: task.input.layerName, newText: task.input.newText }];
  const normalizedEdits = edits
    .filter(
      (item) => item && typeof item.layerName === "string" && typeof item.newText === "string",
    )
    .map((item) => ({
      layerName: item.layerName.trim(),
      newText: item.newText,
    }))
    .filter((item) => item.layerName.length > 0);

  const workflow = task.workflow || {};
  const output = task.output || {};
  const normalizedOutput = {
    psd: output.psd || {
      mode: output.mode || "overwrite",
      path: output.path,
    },
    exports: Array.isArray(output.exports) ? output.exports : [],
  };

  return {
    ...task,
    workflow: {
      sourceMode: workflow.sourceMode || "inplace",
      copyToDir: workflow.copyToDir,
    },
    input: {
      exactPath: task.input.exactPath,
      fileHint: task.input.fileHint,
      edits: normalizedEdits,
    },
    output: normalizedOutput,
  };
}
