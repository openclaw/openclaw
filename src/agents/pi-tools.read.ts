import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import {
  SafeOpenError,
  openFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
import { trySafeFileURLToPath } from "../infra/local-file-access.js";
// Lazy-load workspace lock manager to avoid startup memory overhead.
let _withWorkspaceLock:
  | typeof import("../infra/workspace-lock-manager.js").withWorkspaceLock
  | undefined;
async function getWithWorkspaceLock() {
  if (!_withWorkspaceLock) {
    _withWorkspaceLock = (await import("../infra/workspace-lock-manager.js")).withWorkspaceLock;
  }
  return _withWorkspaceLock;
}
import { detectMime } from "../media/mime.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import {
  CLAUDE_PARAM_GROUPS,
  assertRequiredParams,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { parseSandboxBindMount } from "./sandbox/fs-paths.js";
import { sanitizeToolResultImages } from "./tool-images.js";

export {
  CLAUDE_PARAM_GROUPS,
  assertRequiredParams,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.params.js";

// NOTE(steipete): Upstream read now does file-magic MIME detection; we keep the wrapper
// to normalize payloads and sanitize oversized images before they hit providers.
type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

const DEFAULT_READ_PAGE_MAX_BYTES = 50 * 1024;
const MAX_ADAPTIVE_READ_MAX_BYTES = 512 * 1024;
const ADAPTIVE_READ_CONTEXT_SHARE = 0.2;
const CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_ADAPTIVE_READ_PAGES = 8;

type OpenClawReadToolOptions = {
  modelContextWindowTokens?: number;
  imageSanitization?: ImageSanitizationLimits;
};

type ReadTruncationDetails = {
  truncated: boolean;
  outputLines: number;
  firstLineExceedsLimit: boolean;
};

const READ_CONTINUATION_NOTICE_RE =
  /\n\n\[(?:Showing lines [^\]]*?Use offset=\d+ to continue\.|\d+ more lines in file\. Use offset=\d+ to continue\.)\]\s*$/;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveAdaptiveReadMaxBytes(options?: OpenClawReadToolOptions): number {
  const contextWindowTokens = options?.modelContextWindowTokens;
  if (
    typeof contextWindowTokens !== "number" ||
    !Number.isFinite(contextWindowTokens) ||
    contextWindowTokens <= 0
  ) {
    return DEFAULT_READ_PAGE_MAX_BYTES;
  }
  const fromContext = Math.floor(
    contextWindowTokens * CHARS_PER_TOKEN_ESTIMATE * ADAPTIVE_READ_CONTEXT_SHARE,
  );
  return clamp(fromContext, DEFAULT_READ_PAGE_MAX_BYTES, MAX_ADAPTIVE_READ_MAX_BYTES);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
}

function getToolResultText(result: AgentToolResult<unknown>): string | undefined {
  const content = Array.isArray(result.content) ? result.content : [];
  const textBlocks = content
    .map((block) => {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string"
      ) {
        return (block as { text: string }).text;
      }
      return undefined;
    })
    .filter((value): value is string => typeof value === "string");
  if (textBlocks.length === 0) {
    return undefined;
  }
  return textBlocks.join("\n");
}

function withToolResultText(
  result: AgentToolResult<unknown>,
  text: string,
): AgentToolResult<unknown> {
  const content = Array.isArray(result.content) ? result.content : [];
  let replaced = false;
  const nextContent: ToolContentBlock[] = content.map((block) => {
    if (
      !replaced &&
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text"
    ) {
      replaced = true;
      return {
        ...(block as TextContentBlock),
        text,
      };
    }
    return block;
  });
  if (replaced) {
    return {
      ...result,
      content: nextContent as unknown as AgentToolResult<unknown>["content"],
    };
  }
  const textBlock = { type: "text", text } as unknown as TextContentBlock;
  return {
    ...result,
    content: [textBlock] as unknown as AgentToolResult<unknown>["content"],
  };
}

function extractReadTruncationDetails(
  result: AgentToolResult<unknown>,
): ReadTruncationDetails | null {
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const truncation = (details as { truncation?: unknown }).truncation;
  if (!truncation || typeof truncation !== "object") {
    return null;
  }
  const record = truncation as Record<string, unknown>;
  if (record.truncated !== true) {
    return null;
  }
  const outputLinesRaw = record.outputLines;
  const outputLines =
    typeof outputLinesRaw === "number" && Number.isFinite(outputLinesRaw)
      ? Math.max(0, Math.floor(outputLinesRaw))
      : 0;
  return {
    truncated: true,
    outputLines,
    firstLineExceedsLimit: record.firstLineExceedsLimit === true,
  };
}

function stripReadContinuationNotice(text: string): string {
  return text.replace(READ_CONTINUATION_NOTICE_RE, "");
}

function stripReadTruncationContentDetails(
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> {
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return result;
  }

  const detailsRecord = details as Record<string, unknown>;
  const truncationRaw = detailsRecord.truncation;
  if (!truncationRaw || typeof truncationRaw !== "object") {
    return result;
  }

  const truncation = truncationRaw as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(truncation, "content")) {
    return result;
  }

  const { content: _content, ...restTruncation } = truncation;
  return {
    ...result,
    details: {
      ...detailsRecord,
      truncation: restTruncation,
    },
  };
}

async function executeReadWithAdaptivePaging(params: {
  base: AnyAgentTool;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  maxBytes: number;
}): Promise<AgentToolResult<unknown>> {
  const userLimit = params.args.limit;
  const hasExplicitLimit =
    typeof userLimit === "number" && Number.isFinite(userLimit) && userLimit > 0;
  if (hasExplicitLimit) {
    return await params.base.execute(params.toolCallId, params.args, params.signal);
  }

  const offsetRaw = params.args.offset;
  let nextOffset =
    typeof offsetRaw === "number" && Number.isFinite(offsetRaw) && offsetRaw > 0
      ? Math.floor(offsetRaw)
      : 1;
  let firstResult: AgentToolResult<unknown> | null = null;
  let aggregatedText = "";
  let aggregatedBytes = 0;
  let capped = false;
  let continuationOffset: number | undefined;

  for (let page = 0; page < MAX_ADAPTIVE_READ_PAGES; page += 1) {
    const pageArgs = { ...params.args, offset: nextOffset };
    const pageResult = await params.base.execute(params.toolCallId, pageArgs, params.signal);
    firstResult ??= pageResult;

    const rawText = getToolResultText(pageResult);
    if (typeof rawText !== "string") {
      return pageResult;
    }

    const truncation = extractReadTruncationDetails(pageResult);
    const canContinue =
      Boolean(truncation?.truncated) &&
      !truncation?.firstLineExceedsLimit &&
      (truncation?.outputLines ?? 0) > 0 &&
      page < MAX_ADAPTIVE_READ_PAGES - 1;
    const pageText = canContinue ? stripReadContinuationNotice(rawText) : rawText;
    const delimiter = aggregatedText ? "\n\n" : "";
    const nextBytes = Buffer.byteLength(`${delimiter}${pageText}`, "utf-8");

    if (aggregatedText && aggregatedBytes + nextBytes > params.maxBytes) {
      capped = true;
      continuationOffset = nextOffset;
      break;
    }

    aggregatedText += `${delimiter}${pageText}`;
    aggregatedBytes += nextBytes;

    if (!canContinue || !truncation) {
      return withToolResultText(pageResult, aggregatedText);
    }

    nextOffset += truncation.outputLines;
    continuationOffset = nextOffset;

    if (aggregatedBytes >= params.maxBytes) {
      capped = true;
      break;
    }
  }

  if (!firstResult) {
    return await params.base.execute(params.toolCallId, params.args, params.signal);
  }

  let finalText = aggregatedText;
  if (capped && continuationOffset) {
    finalText += `\n\n[Read output capped at ${formatBytes(params.maxBytes)} for this call. Use offset=${continuationOffset} to continue.]`;
  }
  return withToolResultText(firstResult, finalText);
}

function rewriteReadImageHeader(text: string, mimeType: string): string {
  // pi-coding-agent uses: "Read image file [image/png]"
  if (text.startsWith("Read image file [") && text.endsWith("]")) {
    return `Read image file [${mimeType}]`;
  }
  return text;
}

async function normalizeReadImageResult(
  result: AgentToolResult<unknown>,
  filePath: string,
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];

  const image = content.find(
    (b): b is ImageContentBlock =>
      !!b &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "image" &&
      typeof (b as { data?: unknown }).data === "string" &&
      typeof (b as { mimeType?: unknown }).mimeType === "string",
  );
  if (!image) {
    return result;
  }

  if (!image.data.trim()) {
    throw new Error(`read: image payload is empty (${filePath})`);
  }

  const sniffed = await sniffMimeFromBase64(image.data);
  if (!sniffed) {
    return result;
  }

  if (!sniffed.startsWith("image/")) {
    throw new Error(
      `read: file looks like ${sniffed} but was treated as ${image.mimeType} (${filePath})`,
    );
  }

  if (sniffed === image.mimeType) {
    return result;
  }

  const nextContent = content.map((block) => {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "image") {
      const b = block as ImageContentBlock & { mimeType: string };
      return { ...b, mimeType: sniffed } satisfies ImageContentBlock;
    }
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      const b = block as TextContentBlock & { text: string };
      return {
        ...b,
        text: rewriteReadImageHeader(b.text, sniffed),
      } satisfies TextContentBlock;
    }
    return block;
  });

  return { ...result, content: nextContent };
}

const workspaceMutationLocks = new Map<string, Promise<void>>();
const WORKSPACE_MUTATION_LOCK_TIMEOUT_MS = 120_000;
const WORKSPACE_MUTATION_LOCK_TTL_MS = 60_000;

// Serialize the async "resolve lock key → read map → insert into map" section
// so two concurrent calls that map to the same canonical path cannot both see
// an empty map and proceed in parallel.
let _lockKeyEnqueueChain: Promise<void> = Promise.resolve();

export function wrapToolMutationLock(
  tool: AnyAgentTool,
  root: string,
  options?: { containerWorkdir?: string; bindMounts?: string[] },
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      const filePathRaw = record?.path;
      if (typeof filePathRaw !== "string" || !filePathRaw.trim()) {
        return tool.execute(toolCallId, params, signal, onUpdate);
      }

      // Strip leading `@` alias so `@file.txt` and `file.txt` produce the same lock key.
      const filePathNormalized = filePathRaw.startsWith("@") ? filePathRaw.slice(1) : filePathRaw;
      const resolvedPath = mapContainerPathToWorkspaceRoot({
        filePath: filePathNormalized,
        root,
        containerWorkdir: options?.containerWorkdir,
        bindMounts: options?.bindMounts,
      });

      // Serialize key resolution + map lookup/insert so concurrent calls
      // targeting the same canonical path always queue behind each other.
      type EnqueueResult = {
        lockKey: string;
        applyPatchPrevious: Promise<void> | undefined;
        previous: Promise<void>;
        release: (() => void) | undefined;
        current: Promise<void>;
      };
      const enqueued = await new Promise<EnqueueResult>((resolveEnqueue) => {
        _lockKeyEnqueueChain = _lockKeyEnqueueChain.then(async () => {
          const lockKey = await canonicalizeMutationLockKey(path.resolve(root, resolvedPath));
          const applyPatchQueueKey = `${APPLY_PATCH_WORKSPACE_LOCK_PREFIX}${path.resolve(root)}`;
          const applyPatchPrevious = workspaceMutationLocks.get(applyPatchQueueKey);
          const previous = workspaceMutationLocks.get(lockKey) ?? Promise.resolve();
          let release: (() => void) | undefined;
          const current = new Promise<void>((resolve) => {
            release = resolve;
          });
          workspaceMutationLocks.set(lockKey, current);
          resolveEnqueue({ lockKey, applyPatchPrevious, previous, release, current });
        });
      });
      const { lockKey, applyPatchPrevious, previous, current } = enqueued;
      let { release } = enqueued;

      let ranMutation = false;
      try {
        if (applyPatchPrevious) {
          await waitForQueuedMutation(applyPatchPrevious, signal);
        }
        await waitForQueuedMutation(previous, signal);
        ranMutation = true;
        const lockFn = await getWithWorkspaceLock();
        return await lockFn(
          lockKey,
          {
            kind: "file",
            timeoutMs: WORKSPACE_MUTATION_LOCK_TIMEOUT_MS,
            ttlMs: WORKSPACE_MUTATION_LOCK_TTL_MS,
            signal,
          },
          async () => {
            return await tool.execute(toolCallId, params, signal, onUpdate);
          },
        );
      } finally {
        if (ranMutation) {
          // Mutation completed (or failed) — release so next waiter can proceed.
          release?.();
          if (workspaceMutationLocks.get(lockKey) === current) {
            workspaceMutationLocks.delete(lockKey);
          }
        } else {
          // Aborted/errored before mutation ran — keep `current` in the map so
          // new same-path writes still queue behind it, then forward resolution
          // to when our predecessor completes.
          void previous.then(
            () => {
              release?.();
              if (workspaceMutationLocks.get(lockKey) === current) {
                workspaceMutationLocks.delete(lockKey);
              }
            },
            () => {
              release?.();
              if (workspaceMutationLocks.get(lockKey) === current) {
                workspaceMutationLocks.delete(lockKey);
              }
            },
          );
        }
      }
    },
  };
}
/**
 * Wrap apply_patch with a workspace-root-level mutation lock.
 * Unlike per-file locks used by write/edit, apply_patch can touch multiple
 * files atomically, so we serialize it against all other workspace mutations
 * using the workspace root as the lock key.
 */
/**
 * The workspace-level lock key used by apply_patch. Exported so per-file
 * mutation locks (wrapToolMutationLock) can also wait on this, ensuring
 * apply_patch and write/edit never overlap on the same workspace.
 */
export const APPLY_PATCH_WORKSPACE_LOCK_PREFIX = "apply_patch_ws:";

function extractApplyPatchTouchedPaths(root: string, params: unknown): string[] {
  const input =
    params &&
    typeof params === "object" &&
    typeof (params as { input?: unknown }).input === "string"
      ? (params as { input: string }).input
      : "";
  if (!input) {
    return [];
  }

  const touched = new Set<string>();
  let currentFile: string | null = null;
  for (const line of input.split(/\r?\n/)) {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/);
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1].trim();
      touched.add(path.resolve(root, currentFile));
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to:\s+(.+)$/);
    if (moveMatch?.[1] && currentFile) {
      touched.add(path.resolve(root, moveMatch[1].trim()));
    }
  }
  return [...touched].toSorted();
}

async function normalizeCanonicalLockKeys(paths: string[]): Promise<string[]> {
  const canonical = await Promise.all(
    paths.map(async (target) => await canonicalizeMutationLockKey(target)),
  );
  return [...new Set(canonical)].toSorted();
}

export function wrapApplyPatchMutationLock(tool: AnyAgentTool, root: string): AnyAgentTool {
  const resolvedRoot = path.resolve(root);
  const queueKey = `${APPLY_PATCH_WORKSPACE_LOCK_PREFIX}${resolvedRoot}`;

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const previous = workspaceMutationLocks.get(queueKey) ?? Promise.resolve();
      let release: (() => void) | undefined;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      workspaceMutationLocks.set(queueKey, current);

      let ranMutation = false;
      try {
        // Snapshot per-file queue promises *before* waiting on `previous` so we
        // only wait on writes that were already enqueued at the time this
        // apply_patch was queued — not on writes that arrive later and might in
        // turn wait on *us*, which would deadlock.
        const touchedPaths = await normalizeCanonicalLockKeys(
          extractApplyPatchTouchedPaths(resolvedRoot, params),
        );
        const perFileSnapshots: Array<{ tp: string; prev: Promise<void> }> = [];
        for (const tp of touchedPaths) {
          const perFilePrevious = workspaceMutationLocks.get(tp);
          if (perFilePrevious) {
            perFileSnapshots.push({ tp, prev: perFilePrevious });
          }
        }

        await waitForQueuedMutation(previous, signal);

        for (const { prev } of perFileSnapshots) {
          await waitForQueuedMutation(prev, signal);
        }

        ranMutation = true;
        const lockFn = await getWithWorkspaceLock();
        const runTool = async (): Promise<ReturnType<typeof tool.execute>> =>
          await tool.execute(toolCallId, params, signal, onUpdate);

        if (touchedPaths.length === 0) {
          return await lockFn(
            resolvedRoot,
            {
              kind: "dir",
              timeoutMs: WORKSPACE_MUTATION_LOCK_TIMEOUT_MS,
              ttlMs: WORKSPACE_MUTATION_LOCK_TTL_MS,
              signal,
            },
            runTool,
          );
        }

        const runWithFileLocks = async (
          index: number,
        ): Promise<ReturnType<typeof tool.execute>> => {
          const target = touchedPaths[index];
          if (!target) {
            return await runTool();
          }
          return await lockFn(
            target,
            {
              kind: "file",
              timeoutMs: WORKSPACE_MUTATION_LOCK_TIMEOUT_MS,
              ttlMs: WORKSPACE_MUTATION_LOCK_TTL_MS,
              signal,
            },
            async () => await runWithFileLocks(index + 1),
          );
        };

        return await runWithFileLocks(0);
      } finally {
        if (ranMutation) {
          release?.();
          if (workspaceMutationLocks.get(queueKey) === current) {
            workspaceMutationLocks.delete(queueKey);
          }
        } else {
          void previous.then(
            () => {
              release?.();
              if (workspaceMutationLocks.get(queueKey) === current) {
                workspaceMutationLocks.delete(queueKey);
              }
            },
            () => {
              release?.();
              if (workspaceMutationLocks.get(queueKey) === current) {
                workspaceMutationLocks.delete(queueKey);
              }
            },
          );
        }
      }
    },
  };
}

async function waitForQueuedMutation(previous: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await previous;
    return;
  }

  if (signal.aborted) {
    throw createAbortError();
  }

  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(createAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    await Promise.race([previous, abortPromise]);
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function createAbortError(): Error {
  const error = new Error("Operation aborted.");
  error.name = "AbortError";
  return error;
}

async function canonicalizeMutationLockKey(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let cursor = resolved;
  const normalizeCase = await shouldNormalizeMutationLockCase(resolved);

  while (true) {
    try {
      const canonical = await fs.realpath(cursor);
      if (suffix.length === 0) {
        return canonical;
      }
      return path.join(canonical, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return resolved;
      }
      const basename = path.basename(cursor);
      suffix.push(normalizeCase ? basename.toLowerCase() : basename);
      cursor = parent;
    }
  }
}

async function shouldNormalizeMutationLockCase(targetPath: string): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  if (process.platform !== "darwin") {
    return false;
  }

  let cursor = path.resolve(targetPath);
  while (true) {
    try {
      return await probeDirectoryCaseInsensitive(cursor);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        return false;
      }
      cursor = parent;
    }
  }
}

async function probeDirectoryCaseInsensitive(existingPath: string): Promise<boolean> {
  const parent = path.dirname(existingPath);
  const probeName = `.openclaw-case-probe-${process.pid}-${randomUUID()}`;
  const probePath = path.join(parent, probeName);
  const altPath = path.join(parent, probeName.toUpperCase());
  await fs.writeFile(probePath, "", { flag: "wx" });
  try {
    await fs.stat(altPath);
    return true;
  } catch {
    return false;
  } finally {
    await fs.rm(probePath, { force: true }).catch(() => undefined);
  }
}

export function wrapToolWorkspaceRootGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return wrapToolWorkspaceRootGuardWithOptions(tool, root);
}

function mapContainerPathToWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
  bindMounts?: string[];
}): string {
  const containerWorkdir = params.containerWorkdir?.trim();
  if (!containerWorkdir) {
    return params.filePath;
  }
  const normalizedWorkdir = containerWorkdir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalizedWorkdir.startsWith("/")) {
    return params.filePath;
  }
  if (!normalizedWorkdir) {
    return params.filePath;
  }

  let candidate = params.filePath.startsWith("@") ? params.filePath.slice(1) : params.filePath;
  if (/^file:\/\//i.test(candidate)) {
    const localFilePath = trySafeFileURLToPath(candidate);
    if (!localFilePath) {
      return params.filePath;
    }
    candidate = localFilePath;
  }

  const posixCandidate = path.posix.normalize(candidate.replace(/\\/g, "/"));
  const normalizedCandidate =
    posixCandidate === "/" ? "/" : posixCandidate.replace(/\/+$/, "") || ".";

  const bindMatches = (params.bindMounts ?? [])
    .map((bind) => parseSandboxBindMount(bind))
    .filter((bind): bind is NonNullable<ReturnType<typeof parseSandboxBindMount>> => !!bind)
    .toSorted((a, b) => b.containerRoot.length - a.containerRoot.length);

  // If the candidate is already a host path under one of the bind mounts, return it directly.
  // This avoids double-mapping when someone passes a host-resolved path.
  // Skip root binds (hostRoot="/") — they match everything and would prevent
  // container-path remapping from ever running.
  for (const bind of bindMatches) {
    const hostNorm = bind.hostRoot.replace(/\/+$/, "") || "/";
    if (hostNorm === "/") {
      continue;
    }
    if (normalizedCandidate === hostNorm) {
      return bind.hostRoot;
    }
    const hostPrefix = `${hostNorm}/`;
    if (normalizedCandidate.startsWith(hostPrefix)) {
      return path.resolve(normalizedCandidate);
    }
  }

  for (const bind of bindMatches) {
    if (normalizedCandidate === bind.containerRoot) {
      return bind.hostRoot;
    }
    const bindPrefix = bind.containerRoot === "/" ? "/" : `${bind.containerRoot}/`;
    if (normalizedCandidate.startsWith(bindPrefix)) {
      const relative = normalizedCandidate.slice(bindPrefix.length);
      return path.resolve(bind.hostRoot, ...relative.split("/").filter(Boolean));
    }
  }

  if (normalizedCandidate === normalizedWorkdir) {
    return path.resolve(params.root);
  }
  const prefix = `${normalizedWorkdir}/`;
  if (!normalizedCandidate.startsWith(prefix)) {
    return candidate;
  }
  const relative = normalizedCandidate.slice(prefix.length);
  if (!relative) {
    return path.resolve(params.root);
  }
  return path.resolve(params.root, ...relative.split("/").filter(Boolean));
}

export function resolveToolPathAgainstWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
}): string {
  const mapped = mapContainerPathToWorkspaceRoot(params);
  const candidate = mapped.startsWith("@") ? mapped.slice(1) : mapped;
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(params.root, candidate || ".");
}

type MemoryFlushAppendOnlyWriteOptions = {
  root: string;
  relativePath: string;
  containerWorkdir?: string;
  /** When true, the inner write tool is already wrapped with wrapToolMutationLock;
   *  skip the outer file lock to avoid nested-lock deadlock. */
  mutationLockingEnabled?: boolean;
  sandbox?: {
    root: string;
    bridge: SandboxFsBridge;
  };
};

async function readOptionalUtf8File(params: {
  absolutePath: string;
  relativePath: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
}): Promise<string> {
  try {
    if (params.sandbox) {
      const stat = await params.sandbox.bridge.stat({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      if (!stat) {
        return "";
      }
      const buffer = await params.sandbox.bridge.readFile({
        filePath: params.relativePath,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
      return buffer.toString("utf-8");
    }
    return await fs.readFile(params.absolutePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

export function wrapToolMemoryFlushAppendOnlyWrite(
  tool: AnyAgentTool,
  options: MemoryFlushAppendOnlyWriteOptions,
): AnyAgentTool {
  const allowedAbsolutePath = path.resolve(options.root, options.relativePath);
  return {
    ...tool,
    description: `${tool.description} During memory flush, this tool may only append to ${options.relativePath}.`,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.write, tool.name);
      const filePath =
        typeof record?.path === "string" && record.path.trim() ? record.path : undefined;
      const content = typeof record?.content === "string" ? record.content : undefined;
      if (!filePath || content === undefined) {
        return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
      }

      const resolvedPath = resolveToolPathAgainstWorkspaceRoot({
        filePath,
        root: options.root,
        containerWorkdir: options.containerWorkdir,
      });
      if (resolvedPath !== allowedAbsolutePath) {
        throw new Error(
          `Memory flush writes are restricted to ${options.relativePath}; use that path only.`,
        );
      }

      // Wrap the read-then-write in a file-level workspace lock so concurrent
      // memory flushes to the same file cannot read the same old content before
      // the lock serialises the writes (fixes lost-update race).
      //
      // When the inner write tool is already mutation-locked
      // (mutationLockingEnabled=true), skip the outer lock to avoid
      // nested-lock deadlock — the inner tool already serialises file writes.
      const doFlush = async () => {
        const existing = await readOptionalUtf8File({
          absolutePath: allowedAbsolutePath,
          relativePath: options.relativePath,
          sandbox: options.sandbox,
          signal,
        });
        const separator =
          existing.length > 0 && !existing.endsWith("\n") && !content.startsWith("\n") ? "\n" : "";

        return await tool.execute(
          toolCallId,
          {
            ...record,
            path: options.relativePath,
            content: `${existing}${separator}${content}`,
          },
          signal,
          onUpdate,
        );
      };

      if (options.mutationLockingEnabled) {
        // Inner tool already holds a file-level mutation lock; run directly.
        return await doFlush();
      }

      const lockFn = await getWithWorkspaceLock();
      return await lockFn(
        allowedAbsolutePath,
        {
          kind: "file",
          timeoutMs: WORKSPACE_MUTATION_LOCK_TIMEOUT_MS,
          ttlMs: WORKSPACE_MUTATION_LOCK_TTL_MS,
          signal,
        },
        doFlush,
      );
    },
  };
}

export function wrapToolWorkspaceRootGuardWithOptions(
  tool: AnyAgentTool,
  root: string,
  options?: {
    containerWorkdir?: string;
  },
): AnyAgentTool {
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const normalized = normalizeToolParams(args);
      const record =
        normalized ??
        (args && typeof args === "object" ? (args as Record<string, unknown>) : undefined);
      const filePath = record?.path;
      if (typeof filePath === "string" && filePath.trim()) {
        const sandboxPath = mapContainerPathToWorkspaceRoot({
          filePath,
          root,
          containerWorkdir: options?.containerWorkdir,
        });
        await assertSandboxPath({ filePath: sandboxPath, cwd: root, root });
      }
      return tool.execute(toolCallId, normalized ?? args, signal, onUpdate);
    },
  };
}

type SandboxToolParams = {
  root: string;
  bridge: SandboxFsBridge;
  modelContextWindowTokens?: number;
  imageSanitization?: ImageSanitizationLimits;
  mutationLockingEnabled?: boolean;
  containerWorkdir?: string;
  bindMounts?: string[];
};

export function createSandboxedReadTool(params: SandboxToolParams) {
  const base = createReadTool(params.root, {
    operations: createSandboxReadOperations(params),
  }) as unknown as AnyAgentTool;
  return createOpenClawReadTool(base, {
    modelContextWindowTokens: params.modelContextWindowTokens,
    imageSanitization: params.imageSanitization,
  });
}

export function createSandboxedWriteTool(params: SandboxToolParams) {
  const base = createWriteTool(params.root, {
    operations: createSandboxWriteOperations(params),
  }) as unknown as AnyAgentTool;
  const normalized = wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
  return params.mutationLockingEnabled
    ? wrapToolMutationLock(normalized, params.root, {
        containerWorkdir: params.containerWorkdir,
        bindMounts: params.bindMounts,
      })
    : normalized;
}

export function createSandboxedEditTool(params: SandboxToolParams) {
  const base = createEditTool(params.root, {
    operations: createSandboxEditOperations(params),
  }) as unknown as AnyAgentTool;
  const withRecovery = wrapEditToolWithRecovery(base, {
    root: params.root,
    readFile: async (absolutePath: string) =>
      (await params.bridge.readFile({ filePath: absolutePath, cwd: params.root })).toString("utf8"),
  });
  const normalized = wrapToolParamNormalization(withRecovery, CLAUDE_PARAM_GROUPS.edit);
  return params.mutationLockingEnabled
    ? wrapToolMutationLock(normalized, params.root, {
        containerWorkdir: params.containerWorkdir,
        bindMounts: params.bindMounts,
      })
    : normalized;
}

export function createHostWorkspaceWriteTool(
  root: string,
  options?: { workspaceOnly?: boolean; mutationLockingEnabled?: boolean },
) {
  const base = createWriteTool(root, {
    operations: createHostWriteOperations(root, options),
  }) as unknown as AnyAgentTool;
  const normalized = wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
  return options?.mutationLockingEnabled ? wrapToolMutationLock(normalized, root) : normalized;
}

export function createHostWorkspaceEditTool(
  root: string,
  options?: { workspaceOnly?: boolean; mutationLockingEnabled?: boolean },
) {
  const base = createEditTool(root, {
    operations: createHostEditOperations(root, options),
  }) as unknown as AnyAgentTool;
  const withRecovery = wrapEditToolWithRecovery(base, {
    root,
    readFile: (absolutePath: string) => fs.readFile(absolutePath, "utf-8"),
  });
  const normalized = wrapToolParamNormalization(withRecovery, CLAUDE_PARAM_GROUPS.edit);
  return options?.mutationLockingEnabled ? wrapToolMutationLock(normalized, root) : normalized;
}

export function createOpenClawReadTool(
  base: AnyAgentTool,
  options?: OpenClawReadToolOptions,
): AnyAgentTool {
  const patched = patchToolSchemaForClaudeCompatibility(base);
  return {
    ...patched,
    execute: async (toolCallId, params, signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);
      const result = await executeReadWithAdaptivePaging({
        base,
        toolCallId,
        args: (normalized ?? params ?? {}) as Record<string, unknown>,
        signal,
        maxBytes: resolveAdaptiveReadMaxBytes(options),
      });
      const filePath = typeof record?.path === "string" ? String(record.path) : "<unknown>";
      const strippedDetailsResult = stripReadTruncationContentDetails(result);
      const normalizedResult = await normalizeReadImageResult(strippedDetailsResult, filePath);
      return sanitizeToolResultImages(
        normalizedResult,
        `read:${filePath}`,
        options?.imageSanitization,
      );
    },
  };
}

function createSandboxReadOperations(params: SandboxToolParams) {
  return {
    readFile: (absolutePath: string) =>
      params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
    access: async (absolutePath: string) => {
      const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
      if (!stat) {
        throw createFsAccessError("ENOENT", absolutePath);
      }
    },
    detectImageMimeType: async (absolutePath: string) => {
      const buffer = await params.bridge.readFile({ filePath: absolutePath, cwd: params.root });
      const mime = await detectMime({ buffer, filePath: absolutePath });
      return mime && mime.startsWith("image/") ? mime : undefined;
    },
  } as const;
}

function createSandboxWriteOperations(params: SandboxToolParams) {
  return {
    mkdir: async (dir: string) => {
      await params.bridge.mkdirp({ filePath: dir, cwd: params.root });
    },
    writeFile: async (absolutePath: string, content: string) => {
      await params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content });
    },
  } as const;
}

function createSandboxEditOperations(params: SandboxToolParams) {
  return {
    readFile: (absolutePath: string) =>
      params.bridge.readFile({ filePath: absolutePath, cwd: params.root }),
    writeFile: (absolutePath: string, content: string) =>
      params.bridge.writeFile({ filePath: absolutePath, cwd: params.root, data: content }),
    access: async (absolutePath: string) => {
      const stat = await params.bridge.stat({ filePath: absolutePath, cwd: params.root });
      if (!stat) {
        throw createFsAccessError("ENOENT", absolutePath);
      }
    },
  } as const;
}

async function writeHostFile(absolutePath: string, content: string) {
  const resolved = path.resolve(absolutePath);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
}

function createHostWriteOperations(root: string, options?: { workspaceOnly?: boolean }) {
  const workspaceOnly = options?.workspaceOnly ?? false;

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow writes anywhere on the host
    return {
      mkdir: async (dir: string) => {
        const resolved = path.resolve(dir);
        await fs.mkdir(resolved, { recursive: true });
      },
      writeFile: writeHostFile,
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    mkdir: async (dir: string) => {
      const relative = toRelativeWorkspacePath(root, dir, { allowRoot: true });
      const resolved = relative ? path.resolve(root, relative) : path.resolve(root);
      await assertSandboxPath({ filePath: resolved, cwd: root, root });
      await fs.mkdir(resolved, { recursive: true });
    },
    writeFile: async (absolutePath: string, content: string) => {
      const relative = toRelativeWorkspacePath(root, absolutePath);
      await writeFileWithinRoot({
        rootDir: root,
        relativePath: relative,
        data: content,
        mkdir: true,
      });
    },
  } as const;
}

function createHostEditOperations(root: string, options?: { workspaceOnly?: boolean }) {
  const workspaceOnly = options?.workspaceOnly ?? false;

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow edits anywhere on the host
    return {
      readFile: async (absolutePath: string) => {
        const resolved = path.resolve(absolutePath);
        return await fs.readFile(resolved);
      },
      writeFile: writeHostFile,
      access: async (absolutePath: string) => {
        const resolved = path.resolve(absolutePath);
        await fs.access(resolved);
      },
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    readFile: async (absolutePath: string) => {
      const relative = toRelativeWorkspacePath(root, absolutePath);
      const safeRead = await readFileWithinRoot({
        rootDir: root,
        relativePath: relative,
      });
      return safeRead.buffer;
    },
    writeFile: async (absolutePath: string, content: string) => {
      const relative = toRelativeWorkspacePath(root, absolutePath);
      await writeFileWithinRoot({
        rootDir: root,
        relativePath: relative,
        data: content,
        mkdir: true,
      });
    },
    access: async (absolutePath: string) => {
      let relative: string;
      try {
        relative = toRelativeWorkspacePath(root, absolutePath);
      } catch {
        // Path escapes workspace root.  Don't throw here – the upstream
        // library replaces any `access` error with a misleading "File not
        // found" message.  By returning silently the subsequent `readFile`
        // call will throw the same "Path escapes workspace root" error
        // through a code-path that propagates the original message.
        return;
      }
      try {
        const opened = await openFileWithinRoot({
          rootDir: root,
          relativePath: relative,
        });
        await opened.handle.close().catch(() => {});
      } catch (error) {
        if (error instanceof SafeOpenError && error.code === "not-found") {
          throw createFsAccessError("ENOENT", absolutePath);
        }
        if (error instanceof SafeOpenError && error.code === "outside-workspace") {
          // Don't throw here – see the comment above about the upstream
          // library swallowing access errors as "File not found".
          return;
        }
        throw error;
      }
    },
  } as const;
}

function createFsAccessError(code: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(`Sandbox FS error (${code}): ${filePath}`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}
