import { constants } from "node:fs";
import {
  access as fsAccess,
  readFile as fsReadFile,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { repairJson } from "@openclaw/ai/internal/runtime";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasErrnoCode } from "../../../infra/errno.js";
import { captureAgentToolSourceExecutionGuard } from "../../agent-tool-source-execution-guard.js";
import type { AgentTool } from "../../runtime/index.js";
import { textResult } from "../../tools/tool-results.js";
import { decodeUtf8File } from "../../utf8-file.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeyResolution,
} from "./file-mutation-queue.js";
import { planFileEdit } from "./file-tool-planning.js";
import { type PersistedFileStat, verifyPersistedUtf8File } from "./file-write-verification.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";
import type { EditToolDetails, EditToolInput } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { editSchema, EditToolOutputSchema } from "./tool-schemas.js";

const EDIT_MISMATCH_MESSAGE = "Could not find the exact text in";
const EDIT_MISMATCH_HINT_LIMIT = 800;

/**
 * Pluggable operations for the edit tool.
 * Override these to delegate file editing to remote systems (for example SSH).
 */
interface EditOperations {
  /** Resolve the physical identity used to order this backend's file operations. */
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>;
  /** Read file contents as a Buffer */
  readFile: (absolutePath: string) => Promise<Buffer>;
  /** Write content to a file */
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Stat the target before reporting success */
  statFile: (absolutePath: string) => Promise<PersistedFileStat | null>;
  /** Check if file is readable and writable (throw if not) */
  access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  statFile: async (path) => {
    try {
      const stat = await fsStat(path);
      return {
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      } as const;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  },
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

export interface EditToolOptions {
  /** Custom operations for file editing. Default: local filesystem */
  operations?: EditOperations;
}

function prepareEditArguments(input: unknown): EditToolInput {
  if (!input || typeof input !== "object") {
    return input as EditToolInput;
  }

  const args = { ...(input as Record<string, unknown>) };

  // Serialized replacements contain literal file text, so valid JSON escapes must
  // survive rather than being reinterpreted by the repair owner's path heuristic.
  if (typeof args.edits === "string") {
    try {
      const parsed = JSON.parse(repairJson(args.edits, { preserveValidControlEscapes: true }));
      if (Array.isArray(parsed)) {
        args.edits = parsed;
      }
    } catch {}
  }

  let edits = Array.isArray(args.edits)
    ? args.edits.map((edit) => {
        if (!isRecord(edit)) {
          return edit;
        }
        return { oldText: edit.oldText, newText: edit.newText };
      })
    : args.edits;

  const { oldText, newText } = args;
  if (typeof oldText === "string" && typeof newText === "string") {
    const batch = Array.isArray(edits) ? edits : [];
    if (
      !batch.some(
        (edit: unknown) => isRecord(edit) && edit.oldText === oldText && edit.newText === newText,
      )
    ) {
      batch.push({ oldText, newText });
    }
    edits = batch;
  }

  // Keep the strict provider schema while tolerating model-added metadata.
  return { path: args.path, edits } as EditToolInput;
}

function appendMismatchHint(error: Error, currentContent: string): Error {
  const snippet =
    currentContent.length <= EDIT_MISMATCH_HINT_LIMIT
      ? currentContent
      : `${truncateUtf16Safe(currentContent, EDIT_MISMATCH_HINT_LIMIT)}\n... (truncated)`;
  const enhanced = new Error(`${error.message}\nCurrent file contents:\n${snippet}`, {
    cause: error,
  });
  enhanced.stack = error.stack;
  return enhanced;
}

export function createEditTool(
  cwd: string,
  options?: EditToolOptions,
): AgentTool<typeof editSchema> {
  const ops = options?.operations ?? defaultEditOperations;
  const resolvePath = options?.operations ? resolveToCwd : resolveLocalPathToCwd;
  return wrapToolDefinition<typeof editSchema, EditToolDetails>({
    name: "edit",
    label: "edit",
    description:
      "Exact single-file replacements. oldText unique/non-overlapping against original. Merge nearby changes; omit large unchanged spans.",
    parameters: editSchema,
    outputSchema: EditToolOutputSchema,
    prepareArguments: prepareEditArguments,
    async execute(_toolCallId, input, signal, _onUpdate, _ctx) {
      const assertCurrent = captureAgentToolSourceExecutionGuard();
      if (!Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
      }
      const { path, edits: originalEdits } = input;
      const absolutePath = resolvePath(path, cwd);
      const queueKey = resolveFileMutationQueueKey(absolutePath, ops.resolveQueueKey, signal);

      return withFileMutationQueueKeyResolution(queueKey, async () => {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        assertCurrent();

        let editCount = 0;
        let expectedContent: string | undefined;

        try {
          await ops.access(absolutePath);
        } catch (error: unknown) {
          const errorMessage =
            error instanceof Error && "code" in error
              ? `Error code: ${String(error.code)}`
              : String(error);
          throw new Error(`Could not edit file: ${path}. ${errorMessage}.`, {
            cause: error,
          });
        }

        const buffer = await ops.readFile(absolutePath);
        const rawContent = decodeUtf8File(buffer, absolutePath);
        try {
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          assertCurrent();

          const plan = await planFileEdit(
            { path, content: rawContent, edits: originalEdits },
            signal,
          );
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          assertCurrent();
          if (!plan.changed) {
            return textResult(plan.message, { changed: false } satisfies EditToolDetails);
          }
          editCount = plan.editCount;
          expectedContent = plan.content;
          await ops.writeFile(absolutePath, expectedContent);
          if (signal?.aborted) {
            throw new Error("Operation aborted");
          }
          assertCurrent();
          if (!(await verifyPersistedUtf8File(absolutePath, expectedContent, ops))) {
            throw new Error(
              `Edit verification failed for ${path}: the persisted regular file does not match the requested content. Inspect the target and retry.`,
            );
          }

          assertCurrent();
          return textResult<EditToolDetails>(
            `Successfully replaced ${editCount} block(s) in ${path}.`,
            { changed: true, ...plan.receipt },
          );
        } catch (error: unknown) {
          assertCurrent();
          const normalizedError = error instanceof Error ? error : new Error(String(error));
          const currentContent = await ops
            .readFile(absolutePath)
            .then((current) => current.toString("utf-8"))
            .catch(() => rawContent);
          if (
            expectedContent !== undefined &&
            (await verifyPersistedUtf8File(absolutePath, expectedContent, ops))
          ) {
            assertCurrent();
            return textResult<EditToolDetails>(
              `Successfully replaced ${editCount} block(s) in ${path}.`,
              { changed: true, diff: "", patch: "" },
            );
          }
          if (normalizedError.message.includes(EDIT_MISMATCH_MESSAGE)) {
            throw appendMismatchHint(normalizedError, currentContent);
          }
          throw normalizedError;
        }
      });
    },
  });
}
