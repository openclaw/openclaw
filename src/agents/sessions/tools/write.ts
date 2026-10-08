import {
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isMissingPathError } from "../../../infra/errors.js";
import { captureAgentToolSourceExecutionGuard } from "../../agent-tool-source-execution-guard.js";
import type { AgentTool } from "../../runtime/index.js";
import { textResult } from "../../tools/tool-results.js";
import { WRITE_DIFF_MAX_BYTES } from "./file-diff.js";
import {
  resolveFileMutationQueueKey,
  withFileMutationQueueKeyResolution,
} from "./file-mutation-queue.js";
import { assertFileToolNotAborted } from "./file-tool-abort.js";
import { planFileWriteDiff } from "./file-tool-planning.js";
import {
  type PersistedFileStat,
  readPersistedFileStat,
  verifyPersistedUtf8File,
} from "./file-write-verification.js";
import { resolveLocalPathToCwd, resolveToCwd } from "./path-utils.js";
import type { WriteToolDetails } from "./tool-contracts.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { writeSchema, WriteToolOutputSchema } from "./tool-schemas.js";

/**
 * Pluggable operations for the write tool.
 * Override these to delegate file writing to remote systems (for example SSH).
 */
interface WriteOperations {
  /** Resolve the physical identity used to order this backend's file operations. */
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  /** Create directory recursively */
  mkdir: (dir: string) => Promise<void>;
  /** Read persisted content before reporting success */
  readFile: (absolutePath: string) => Promise<Buffer | string>;
  /** Stat the target for prechecks and persisted-file verification */
  statFile: (absolutePath: string) => Promise<PersistedFileStat | null>;
}

const defaultWriteOperations: WriteOperations = {
  writeFile: (path, content) => fsWriteFile(path, content, "utf-8"),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
  readFile: (path) => fsReadFile(path),
  statFile: (path) => readPersistedFileStat(path, isMissingPathError),
};

export interface WriteToolOptions {
  /** Custom operations for file writing. Default: local filesystem */
  operations?: WriteOperations;
}

type WriteToolPrecheck = {
  state: "different" | "same" | "unknown";
  beforeStat?: PersistedFileStat | null;
  beforeText?: string;
  readAttempted?: boolean;
};

function isMissingFileError(error: unknown): boolean {
  if (isMissingPathError(error)) {
    return true;
  }
  // Injected write operations may preserve only their legacy human-readable error.
  return error instanceof Error && error.message.includes("No such file or directory");
}

async function readOriginalWriteState(
  absolutePath: string,
  content: string,
  ops: WriteOperations,
): Promise<WriteToolPrecheck> {
  let stat: PersistedFileStat | null;
  try {
    stat = await ops.statFile(absolutePath);
  } catch (error) {
    return isMissingFileError(error)
      ? { state: "different", beforeStat: null }
      : { state: "unknown" };
  }
  if (!stat) {
    return { state: "different", beforeStat: stat };
  }
  if (stat.type !== "file") {
    return { state: "unknown", beforeStat: stat };
  }
  if (stat.size !== Buffer.byteLength(content, "utf8")) {
    return { state: "different", beforeStat: stat };
  }
  if (stat.size > WRITE_DIFF_MAX_BYTES) {
    return { state: "unknown", beforeStat: stat };
  }

  try {
    const originalContent = await ops.readFile(absolutePath);
    const originalBytes = Buffer.isBuffer(originalContent)
      ? originalContent
      : Buffer.from(originalContent, "utf8");
    const originalText = originalBytes.toString("utf8");
    if (Buffer.byteLength(originalText, "utf8") > WRITE_DIFF_MAX_BYTES) {
      return { state: "unknown", beforeStat: stat, readAttempted: true };
    }
    return {
      // No-op receipts need the same encoded bytes as post-write verification.
      state: originalBytes.equals(Buffer.from(content, "utf8")) ? "same" : "different",
      beforeStat: stat,
      beforeText: originalText,
      readAttempted: true,
    };
  } catch {
    return { state: "unknown", beforeStat: stat, readAttempted: true };
  }
}

async function resolveWriteDetails(params: {
  absolutePath: string;
  content: string;
  ops: WriteOperations;
  path: string;
  precheck: WriteToolPrecheck;
  signal?: AbortSignal;
}): Promise<WriteToolDetails> {
  if (Buffer.byteLength(params.content, "utf8") > WRITE_DIFF_MAX_BYTES) {
    // Keep diff work bounded; a partial patch would misrepresent the write.
    if (params.precheck.beforeStat === null) {
      return { changed: true, created: true };
    }
    return params.precheck.beforeStat ? { changed: true, created: false } : { changed: true };
  }
  const beforeStat = params.precheck.beforeStat;
  let beforeText = params.precheck.beforeText;
  if (
    beforeText === undefined &&
    !params.precheck.readAttempted &&
    beforeStat?.type === "file" &&
    beforeStat.size <= WRITE_DIFF_MAX_BYTES
  ) {
    const originalContent = await params.ops.readFile(params.absolutePath).catch(() => undefined);
    const candidate = Buffer.isBuffer(originalContent)
      ? originalContent.toString("utf8")
      : originalContent;
    if (candidate !== undefined && Buffer.byteLength(candidate, "utf8") <= WRITE_DIFF_MAX_BYTES) {
      beforeText = candidate;
    }
  }
  const created = beforeStat === null ? true : beforeStat ? false : undefined;
  const receipt = await planFileWriteDiff(
    { path: params.path, content: params.content, beforeText, created },
    params.signal,
  );
  return { changed: true, ...(created === undefined ? {} : { created }), ...receipt };
}

async function didWriteMetadataChange(
  absolutePath: string,
  beforeStat: PersistedFileStat | null | undefined,
  ops: WriteOperations,
): Promise<boolean> {
  if (!beforeStat) {
    return false;
  }
  const afterStat = await ops.statFile(absolutePath).catch(() => null);
  if (!afterStat || afterStat.type !== "file") {
    return false;
  }
  return afterStat.size !== beforeStat.size || afterStat.mtimeMs !== beforeStat.mtimeMs;
}

function isWriteRecoveryCandidate(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    error.name === "TimeoutError" ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function successfulWriteResult(path: string, content: string, details: WriteToolDetails) {
  return textResult(
    `Successfully wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}`,
    details,
  );
}

export function createWriteTool(
  cwd: string,
  options?: WriteToolOptions,
): AgentTool<typeof writeSchema> {
  const ops = options?.operations ?? defaultWriteOperations;
  const resolvePath = options?.operations ? resolveToCwd : resolveLocalPathToCwd;
  return wrapToolDefinition<typeof writeSchema, WriteToolDetails>({
    name: "write",
    label: "write",
    description: "Write/overwrite file; creates parent directories.",
    parameters: writeSchema,
    outputSchema: WriteToolOutputSchema,
    async execute(_toolCallId, { path, content }, signal, _onUpdate, _ctx) {
      const assertCurrent = captureAgentToolSourceExecutionGuard();
      const absolutePath = resolvePath(path, cwd);
      const dir = dirname(absolutePath);
      const queueKey = resolveFileMutationQueueKey(absolutePath, ops.resolveQueueKey, signal);
      return withFileMutationQueueKeyResolution(queueKey, async () => {
        const precheck = await readOriginalWriteState(absolutePath, content, ops);
        assertFileToolNotAborted(signal);
        assertCurrent();
        // No-op: file already has identical content. Not terminal — the model
        // may still be mid-task and needs a continuation, not an ended turn.
        if (precheck.state === "same") {
          return textResult(`No changes made to ${path}. The file already has identical content.`, {
            changed: false,
          } satisfies WriteToolDetails);
        }
        const details = await resolveWriteDetails({
          absolutePath,
          content,
          ops,
          path,
          precheck,
          signal,
        });
        assertCurrent();
        assertFileToolNotAborted(signal);
        try {
          assertCurrent();
          await ops.mkdir(dir);
          assertFileToolNotAborted(signal);
          assertCurrent();
          await ops.writeFile(absolutePath, content);
          assertFileToolNotAborted(signal);
          assertCurrent();
          if (!(await verifyPersistedUtf8File(absolutePath, content, ops))) {
            throw new Error(
              `Write verification failed for ${path}: the persisted regular file does not match the requested content. Inspect the target and retry.`,
            );
          }
          assertCurrent();
          return successfulWriteResult(path, content, details);
        } catch (error: unknown) {
          assertCurrent();
          if (isWriteRecoveryCandidate(error, signal)) {
            const verified = await verifyPersistedUtf8File(absolutePath, content, ops);
            const changed =
              precheck.state === "different" ||
              (precheck.state === "unknown" &&
                (await didWriteMetadataChange(absolutePath, precheck.beforeStat, ops)));
            if (verified && changed) {
              assertCurrent();
              return successfulWriteResult(path, content, details);
            }
          }
          throw error;
        }
      });
    },
  });
}
