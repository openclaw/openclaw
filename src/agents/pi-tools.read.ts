import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import type { AccessPolicyConfig } from "../config/types.tools.js";
import { checkAccessPolicy } from "../infra/access-policy.js";
import {
  appendFileWithinRoot,
  SafeOpenError,
  openFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
import { detectMime } from "../media/mime.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import type { ImageSanitizationLimits } from "./image-sanitization.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { wrapHostEditToolWithPostWriteRecovery } from "./pi-tools.host-edit.js";
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

/**
 * Resolve symlinks before a policy check. For paths that don't exist yet
 * (e.g. a new file being created), resolves the parent directory so that
 * intermediate symlinks are followed. Without this, a write to
 * `/allowed/link/new.txt` where `link → /denied` would pass the check
 * (path.resolve does not follow symlinks) and then land in the denied
 * target when fs.writeFile follows the symlink.
 */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // Path doesn't exist yet — walk up ancestors until we find one that exists,
    // resolve it, then reconstruct the full path.
    const parts: string[] = [];
    let ancestor = p;
    while (true) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return path.resolve(p);
      }
      parts.unshift(path.basename(ancestor));
      ancestor = parent;
      try {
        return path.join(realpathSync(ancestor), ...parts);
      } catch {
        // Keep walking up.
      }
    }
  }
}

type OpenClawReadToolOptions = {
  modelContextWindowTokens?: number;
  imageSanitization?: ImageSanitizationLimits;
  permissions?: AccessPolicyConfig;
  /** Workspace root used to resolve relative paths for permission checks. */
  workspaceRoot?: string;
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

export function wrapToolWorkspaceRootGuard(tool: AnyAgentTool, root: string): AnyAgentTool {
  return wrapToolWorkspaceRootGuardWithOptions(tool, root);
}

function mapContainerPathToWorkspaceRoot(params: {
  filePath: string;
  root: string;
  containerWorkdir?: string;
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
    try {
      candidate = fileURLToPath(candidate);
    } catch {
      try {
        const parsed = new URL(candidate);
        if (parsed.protocol !== "file:") {
          return params.filePath;
        }
        candidate = decodeURIComponent(parsed.pathname || "");
        if (!candidate.startsWith("/")) {
          return params.filePath;
        }
      } catch {
        return params.filePath;
      }
    }
  }

  const normalizedCandidate = candidate.replace(/\\/g, "/");
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

async function appendMemoryFlushContent(params: {
  absolutePath: string;
  root: string;
  relativePath: string;
  content: string;
  sandbox?: MemoryFlushAppendOnlyWriteOptions["sandbox"];
  signal?: AbortSignal;
}) {
  if (!params.sandbox) {
    await appendFileWithinRoot({
      rootDir: params.root,
      relativePath: params.relativePath,
      data: params.content,
      mkdir: true,
      prependNewlineIfNeeded: true,
    });
    return;
  }

  const existing = await readOptionalUtf8File({
    absolutePath: params.absolutePath,
    relativePath: params.relativePath,
    sandbox: params.sandbox,
    signal: params.signal,
  });
  const separator =
    existing.length > 0 && !existing.endsWith("\n") && !params.content.startsWith("\n") ? "\n" : "";
  const next = `${existing}${separator}${params.content}`;
  if (params.sandbox) {
    const parent = path.posix.dirname(params.relativePath);
    if (parent && parent !== ".") {
      await params.sandbox.bridge.mkdirp({
        filePath: parent,
        cwd: params.sandbox.root,
        signal: params.signal,
      });
    }
    await params.sandbox.bridge.writeFile({
      filePath: params.relativePath,
      cwd: params.sandbox.root,
      data: next,
      mkdir: true,
      signal: params.signal,
    });
    return;
  }
  await fs.mkdir(path.dirname(params.absolutePath), { recursive: true });
  await fs.writeFile(params.absolutePath, next, "utf-8");
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

      await appendMemoryFlushContent({
        absolutePath: allowedAbsolutePath,
        root: options.root,
        relativePath: options.relativePath,
        content,
        sandbox: options.sandbox,
        signal,
      });
      return {
        content: [{ type: "text", text: `Appended content to ${options.relativePath}.` }],
        details: {
          path: options.relativePath,
          appendOnly: true,
        },
      };
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
  return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
}

export function createSandboxedEditTool(params: SandboxToolParams) {
  const base = createEditTool(params.root, {
    operations: createSandboxEditOperations(params),
  }) as unknown as AnyAgentTool;
  return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.edit);
}

export function createHostWorkspaceWriteTool(
  root: string,
  options?: { workspaceOnly?: boolean; permissions?: AccessPolicyConfig },
) {
  const base = createWriteTool(root, {
    operations: createHostWriteOperations(root, options),
  }) as unknown as AnyAgentTool;
  return wrapToolParamNormalization(base, CLAUDE_PARAM_GROUPS.write);
}

export function createHostWorkspaceEditTool(
  root: string,
  options?: { workspaceOnly?: boolean; permissions?: AccessPolicyConfig },
) {
  const base = createEditTool(root, {
    operations: createHostEditOperations(root, options),
  }) as unknown as AnyAgentTool;
  const withRecovery = wrapHostEditToolWithPostWriteRecovery(base, root);
  return wrapToolParamNormalization(withRecovery, CLAUDE_PARAM_GROUPS.edit);
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
      const filePath = typeof record?.path === "string" ? String(record.path) : "<unknown>";
      // Path-level permission check (when tools.fs.permissions is configured).
      // Use the resolved path for the actual read — closes the TOCTOU window where a
      // symlink swapped between check and open could redirect I/O to an unchecked path.
      // This mirrors the write/edit tools which return the resolved path from
      // assertWritePermitted/assertEditPermitted and use it for the subsequent I/O call.
      let readArgs = (normalized ?? params ?? {}) as Record<string, unknown>;
      if (options?.permissions && filePath !== "<unknown>") {
        const resolvedPath = safeRealpath(
          path.isAbsolute(filePath)
            ? filePath
            : path.resolve(options.workspaceRoot ?? process.cwd(), filePath),
        );
        if (checkAccessPolicy(resolvedPath, "read", options.permissions) === "deny") {
          throw new Error(`Permission denied: read access to ${resolvedPath} is not allowed.`);
        }
        readArgs = { ...readArgs, path: resolvedPath };
      }
      const result = await executeReadWithAdaptivePaging({
        base,
        toolCallId,
        args: readArgs,
        signal,
        maxBytes: resolveAdaptiveReadMaxBytes(options),
      });
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

function createHostWriteOperations(
  root: string,
  options?: { workspaceOnly?: boolean; permissions?: AccessPolicyConfig },
) {
  const workspaceOnly = options?.workspaceOnly ?? false;
  const permissions = options?.permissions;
  // Resolve root once so that safeRealpath(child) paths can be compared against
  // it — if root itself is a symlink, toRelativeWorkspacePath would otherwise
  // throw "path escapes workspace root" for every path inside the workspace.
  const resolvedRoot = safeRealpath(root);

  // Returns the safeRealpath-resolved path so callers use the same concrete path
  // for I/O that was checked by the policy — closes the TOCTOU window where a
  // symlink swap between permission check and fs call could redirect I/O.
  function assertWritePermitted(absolutePath: string): string {
    const resolved = safeRealpath(absolutePath);
    if (permissions && checkAccessPolicy(resolved, "write", permissions) === "deny") {
      throw new Error(`Permission denied: write access to ${resolved} is not allowed.`);
    }
    return resolved;
  }

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow writes anywhere on the host
    return {
      mkdir: async (dir: string) => {
        const resolved = assertWritePermitted(dir);
        await fs.mkdir(resolved, { recursive: true });
      },
      writeFile: async (absolutePath: string, content: string) => {
        const resolved = assertWritePermitted(absolutePath);
        await writeHostFile(resolved, content);
      },
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    mkdir: async (dir: string) => {
      const resolved = assertWritePermitted(dir);
      const relative = toRelativeWorkspacePath(resolvedRoot, resolved, { allowRoot: true });
      const absResolved = relative
        ? path.resolve(resolvedRoot, relative)
        : path.resolve(resolvedRoot);
      await assertSandboxPath({ filePath: absResolved, cwd: resolvedRoot, root: resolvedRoot });
      await fs.mkdir(absResolved, { recursive: true });
    },
    writeFile: async (absolutePath: string, content: string) => {
      const resolved = assertWritePermitted(absolutePath);
      const relative = toRelativeWorkspacePath(resolvedRoot, resolved);
      await writeFileWithinRoot({
        rootDir: resolvedRoot,
        relativePath: relative,
        data: content,
        mkdir: true,
      });
    },
  } as const;
}

function createHostEditOperations(
  root: string,
  options?: { workspaceOnly?: boolean; permissions?: AccessPolicyConfig },
) {
  const workspaceOnly = options?.workspaceOnly ?? false;
  const permissions = options?.permissions;
  const resolvedRoot = safeRealpath(root);

  // Edit = read + write the same file; check both permissions and return the
  // safeRealpath-resolved path so callers use the same concrete path for I/O
  // that was checked — closes the TOCTOU window where a symlink swap between
  // permission check and fs call could redirect I/O to an unchecked target.
  function assertEditPermitted(absolutePath: string): string {
    const resolved = safeRealpath(absolutePath);
    if (permissions) {
      if (checkAccessPolicy(resolved, "read", permissions) === "deny") {
        throw new Error(`Permission denied: read access to ${resolved} is not allowed.`);
      }
      if (checkAccessPolicy(resolved, "write", permissions) === "deny") {
        throw new Error(`Permission denied: write access to ${resolved} is not allowed.`);
      }
    }
    return resolved;
  }

  // access() checks existence only — requires read permission but not write.
  // Using assertEditPermitted here would block existence checks on r-- paths before
  // any write is attempted, producing a misleading "write access denied" error.
  function assertReadPermitted(absolutePath: string): string {
    const resolved = safeRealpath(absolutePath);
    if (permissions && checkAccessPolicy(resolved, "read", permissions) === "deny") {
      throw new Error(`Permission denied: read access to ${resolved} is not allowed.`);
    }
    return resolved;
  }

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow edits anywhere on the host
    return {
      readFile: async (absolutePath: string) => {
        const resolved = assertEditPermitted(absolutePath);
        return await fs.readFile(resolved);
      },
      writeFile: async (absolutePath: string, content: string) => {
        const resolved = assertEditPermitted(absolutePath);
        await writeHostFile(resolved, content);
      },
      access: async (absolutePath: string) => {
        const resolved = assertReadPermitted(absolutePath);
        await fs.access(resolved);
      },
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    readFile: async (absolutePath: string) => {
      const resolved = assertEditPermitted(absolutePath);
      const relative = toRelativeWorkspacePath(resolvedRoot, resolved);
      const safeRead = await readFileWithinRoot({
        rootDir: resolvedRoot,
        relativePath: relative,
      });
      return safeRead.buffer;
    },
    writeFile: async (absolutePath: string, content: string) => {
      const resolved = assertEditPermitted(absolutePath);
      const relative = toRelativeWorkspacePath(resolvedRoot, resolved);
      await writeFileWithinRoot({
        rootDir: resolvedRoot,
        relativePath: relative,
        data: content,
        mkdir: true,
      });
    },
    access: async (absolutePath: string) => {
      const resolved = assertReadPermitted(absolutePath);
      let relative: string;
      try {
        relative = toRelativeWorkspacePath(resolvedRoot, resolved);
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
