// No top-level import needed - using dynamic import above to avoid circular deps
import fs from "node:fs/promises";
import path from "node:path";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import {
  appendFileWithinRoot,
  SafeOpenError,
  openFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
} from "../infra/fs-safe.js";
import { trySafeFileURLToPath } from "../infra/local-file-access.js";
import { detectMime } from "../media/mime.js";
import { toRelativeWorkspacePath } from "./path-policy.js";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";

const normalizeToolParams = (params: unknown): Record<string, unknown> | undefined => {
  if (!params) {return undefined;}
  if (typeof params === "object") {return params as Record<string, unknown>;}
  return undefined;
};

const CLAUDE_PARAM_GROUPS = {
  read: [{ keys: ["path"] }] as const,
  write: [{ keys: ["path", "content"] }] as const,
  edit: [{ keys: ["file_path", "old_string", "new_string"] }] as const,
};

type OpenClawReadToolOptions = {
  modelContextWindowTokens?: number;
  imageSanitization?: import("./image-sanitization.js").ImageSanitizationLimits;
  root?: string;
  containerWorkdir?: string;
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${bytes}B`;
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
    const localFilePath = trySafeFileURLToPath(candidate);
    if (!localFilePath) {
      return params.filePath;
    }
    candidate = localFilePath;
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
      const record = getToolParamsRecord(args);
      assertRequiredParams(record, REQUIRED_PARAM_GROUPS.write, tool.name);
      const filePath =
        typeof record?.path === "string" && record.path.trim() ? record.path : undefined;
      const content = typeof record?.content === "string" ? record.content : undefined;
      if (!filePath || content === undefined) {
        return tool.execute(toolCallId, args, signal, onUpdate);
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
    pathParamKeys?: readonly string[];
    normalizeGuardedPathParams?: boolean;
  },
): AnyAgentTool {
  const pathParamKeys =
    options?.pathParamKeys && options.pathParamKeys.length > 0 ? options.pathParamKeys : ["path"];
  return {
    ...tool,
    execute: async (toolCallId, args, signal, onUpdate) => {
      const record = getToolParamsRecord(args);
      let normalizedRecord: Record<string, unknown> | undefined;
      for (const key of pathParamKeys) {
        const filePath = record?.[key];
        if (typeof filePath !== "string" || !filePath.trim()) {
          continue;
        }
        const sandboxPath = mapContainerPathToWorkspaceRoot({
          filePath,
          root,
          containerWorkdir: options?.containerWorkdir,
        });
        const sandboxResult = await assertSandboxPath({ filePath: sandboxPath, cwd: root, root });
        if (options?.normalizeGuardedPathParams && record) {
          normalizedRecord ??= { ...record };
          normalizedRecord[key] = sandboxResult.resolved;
        }
      }
      return tool.execute(toolCallId, normalizedRecord ?? args, signal, onUpdate);
    },
  };
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv"]);
const MAX_DIR_ENTRIES = 200; // P2 FIX: Maximum directory entries to display

function getImageMimeType(ext: string): string {
  if (ext === "svg") {return "image/svg+xml";}
  if (ext === "jpg") {return "image/jpeg";}
  return `image/${ext}`;
}

type SandboxToolParams = {
  root: string;
  bridge: SandboxFsBridge;
  modelContextWindowTokens?: number;
  imageSanitization?: import("./image-sanitization.js").ImageSanitizationLimits;
};

export function createSandboxedReadTool(params: SandboxToolParams) {
  const base = createReadTool(params.root, {
    operations: createSandboxReadOperations(params),
  }) as unknown as AnyAgentTool;
  return createOpenClawReadTool(base, {
    root: params.root,
    modelContextWindowTokens: params.modelContextWindowTokens,
    imageSanitization: params.imageSanitization,
  });
}

export function createSandboxedWriteTool(params: SandboxToolParams) {
  const base = createWriteTool(params.root, {
    operations: createSandboxWriteOperations(params),
  }) as unknown as AnyAgentTool;
  return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write);
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
  return wrapToolParamValidation(withRecovery, REQUIRED_PARAM_GROUPS.edit);
}

export function createHostWorkspaceWriteTool(root: string, options?: { workspaceOnly?: boolean }) {
  const base = createWriteTool(root, {
    operations: createHostWriteOperations(root, options),
  }) as unknown as AnyAgentTool;
  return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write);
}

export function createHostWorkspaceEditTool(root: string, options?: { workspaceOnly?: boolean }) {
  const base = createEditTool(root, {
    operations: createHostEditOperations(root, options),
  }) as unknown as AnyAgentTool;
  const withRecovery = wrapEditToolWithRecovery(base, {
    root,
    readFile: (absolutePath: string) => fs.readFile(absolutePath, "utf-8"),
  });
  return wrapToolParamValidation(withRecovery, REQUIRED_PARAM_GROUPS.edit);
}

export function createOpenClawReadTool(
  base: AnyAgentTool,
  options?: OpenClawReadToolOptions,
): AnyAgentTool {
  return {
    ...base,
    execute: async (toolCallId, params, _signal) => {
      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);

      let rawPath = typeof record?.path === "string" ? record.path : ".";
      rawPath = rawPath.match(/[\x20-\x7E]/g)?.join('') || '';

      // P1 FIX #3: Get paging parameters for text files
      const offset = typeof record?.offset === 'number' ? record.offset : 0;
      const limit = typeof record?.limit === 'number' ? record.limit : undefined;

      const rootDir = options?.root ? path.resolve(options.root) : process.cwd();

      let inputPath: string;

      if (path.isAbsolute(rawPath)) {
        inputPath = rawPath;
      } else {
        inputPath = path.resolve(rootDir, rawPath);
      }

      try {
        await fs.access(inputPath);
      } catch {
        const workspacePattern = new RegExp(`${rootDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.+)`);
        const match = rawPath.match(workspacePattern);
        if (match) {
          const alternativePath = path.resolve(rootDir, match[1]);
          try {
            await fs.access(alternativePath);
            inputPath = alternativePath;
          } catch {
            // Keep original inputPath
          }
        }
      }

      try {
        const stats = await fs.stat(inputPath);

        if (stats.isDirectory()) {
          // P2 FIX: Add truncation for directory listings
          let files = await fs.readdir(inputPath);
          let truncated = false;
          
          if (files.length > MAX_DIR_ENTRIES) {
            truncated = true;
            files = files.slice(0, MAX_DIR_ENTRIES);
          }
          
          const listingText = `Listing for ${inputPath}:\n${files.join("\n")}${
            truncated ? `\n\n... and ${files.length - MAX_DIR_ENTRIES} more entries not shown (limit: ${MAX_DIR_ENTRIES})` : ""
          }`;
          
          return {
            toolCallId,
            content: [{ type: "text", text: listingText }],
            details: { path: inputPath },
          };
        }

        const ext = inputPath.toLowerCase().split(".").pop() ?? "";
        const fileName = path.basename(inputPath);
        const mediaUrl = `http://localhost:18791${inputPath}`;

        // Handle images - keep base64 for images (they work)
        if (IMAGE_EXTENSIONS.has(ext)) {
          const fileBuffer = await fs.readFile(inputPath);
          // P1 FIX #1: Size cap for images
          if (fileBuffer.length > 5242880) {
            return {
              toolCallId,
              content: [{
                type: "text",
                text: `🖼️ ${fileName} - Image too large (${formatBytes(fileBuffer.length)}). View at: ${mediaUrl}`
              }],
              details: { path: inputPath, size: fileBuffer.length, truncated: true },
            };
          }
          const mimeType = getImageMimeType(ext);
          // FIXED: Use the correct working format for images with URL text
          return {
            toolCallId,
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mimeType,
                  data: fileBuffer.toString("base64"),
                },
              },
              {
                type: "text",
                text: `📷 [${fileName}](${mediaUrl})`,
              },
            ],
            details: { path: inputPath, size: fileBuffer.length },
          };
        }

        // Handle audio files - use URL streaming, NOT base64
        if (AUDIO_EXTENSIONS.has(ext)) {
          const MAX_AUDIO_SIZE = 10 * 1024 * 1024;
          if (stats.size > MAX_AUDIO_SIZE) {
            return {
              toolCallId,
              content: [{
                type: "text",
                text: `🎵 ${fileName} (${formatBytes(stats.size)}) - ${mediaUrl}`
              }],
              details: { path: inputPath, size: stats.size, streamed: true },
            };
          }

          let mimeType: string;
          if (ext === "mp3") { mimeType = "audio/mpeg"; }
          else if (ext === "wav") { mimeType = "audio/wav"; }
          else if (ext === "ogg") { mimeType = "audio/ogg"; }
          else if (ext === "m4a") { mimeType = "audio/mp4"; }
          else if (ext === "flac") { mimeType = "audio/flac"; }
          else if (ext === "aac") { mimeType = "audio/aac"; }
          else { mimeType = "audio/ogg"; }

          return {
            toolCallId,
            content: [
              {
                type: "audio",
                url: mediaUrl,
                mimeType: mimeType,
                filename: fileName,
              },
            ],
            details: { path: inputPath, size: stats.size },
          };
        }

        // Handle video files - use URL streaming, NOT base64
        if (VIDEO_EXTENSIONS.has(ext)) {
          const MAX_VIDEO_SIZE = 10 * 1024 * 1024;
          if (stats.size > MAX_VIDEO_SIZE) {
            return {
              toolCallId,
              content: [{
                type: "text",
                text: `🎬 ${fileName} (${formatBytes(stats.size)}) - ${mediaUrl}`
              }],
              details: { path: inputPath, size: stats.size, streamed: true },
            };
          }

          let mimeType: string;
          if (ext === "mp4") { mimeType = "video/mp4"; }
          else if (ext === "webm") { mimeType = "video/webm"; }
          else if (ext === "mov") { mimeType = "video/quicktime"; }
          else if (ext === "avi") { mimeType = "video/x-msvideo"; }
          else if (ext === "mkv") { mimeType = "video/x-matroska"; }
          else { mimeType = "video/mp4"; }

          return {
            toolCallId,
            content: [
              {
                type: "video",
                url: mediaUrl,
                mimeType: mimeType,
                filename: fileName,
              },
            ],
            details: { path: inputPath, size: stats.size },
          };
        }

        // Handle text files with P1 FIX #3 (offset/limit paging)
        const fileBuffer = await fs.readFile(inputPath, "utf-8");
        const maxChars = (options?.modelContextWindowTokens || 100000) * 4;
        let text = fileBuffer;
        let truncated = false;

        if (offset > 0 || limit !== undefined) {
          const lines = text.split('\n');
          const start = Math.max(0, Math.min(offset - 1, lines.length));
          const end = limit !== undefined ? Math.min(start + limit, lines.length) : lines.length;
          text = lines.slice(start, end).join('\n');
          truncated = true;
        } else if (text.length > maxChars) {
          text = text.slice(0, maxChars) + `\n\n[Truncated: File is ${formatBytes(fileBuffer.length)}]`;
          truncated = true;
        }

        return {
          toolCallId,
          content: [{ type: "text", text }],
          details: { path: inputPath, size: fileBuffer.length, truncated, offset, limit },
        };

      } catch (err) {
        const error = err as Error;
        return {
          toolCallId,
          content: [{ type: "text", text: `Read failed: ${error.message}. File path attempted: ${inputPath}` }],
          details: { isError: true, path: inputPath },
        };
      }
    },
  } as AnyAgentTool;
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
    return {
      mkdir: async (dir: string) => {
        const resolved = path.resolve(dir);
        await fs.mkdir(resolved, { recursive: true });
      },
      writeFile: writeHostFile,
    } as const;
  }

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