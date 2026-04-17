import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import {
  appendFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
  mkdirPathWithinRoot,
} from "../infra/fs-safe.js";
import { trySafeFileURLToPath } from "../infra/local-file-access.js";
import { expandHomePrefix, resolveOsHomeDir } from "../infra/home-dir.js";
import { wrapEditToolWithRecovery } from "./pi-tools.host-edit.js";
import {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";
import type { AnyAgentTool, AgentToolResult } from "./pi-tools.types.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { getImageMetadata, resizeToJpeg } from "../media/image-ops.js";

export {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";

// Helper function to expand tilde to OS home directory
function expandTildeToOsHome(filePath: string): string {
  const home = resolveOsHomeDir();
  return home ? expandHomePrefix(filePath, { home }) : filePath;
}

// Helper function for host file writes with tilde expansion
async function writeHostFile(absolutePath: string, content: string): Promise<void> {
  const resolved = path.resolve(expandTildeToOsHome(absolutePath));
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf-8");
}

const normalizeToolParams = (params: unknown): Record<string, unknown> | undefined => {
  if (!params) {
    return undefined;
  }
  if (typeof params === "object") {
    return params as Record<string, unknown>;
  }
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
  bridge?: SandboxFsBridge;
  getBaseUrl?: () => string;
  transformForTransport?: boolean; // Apply transport transformation
};

// Helper function to resolve absolute paths within workspace
function resolveWorkspacePath(relativePath: string, root: string): string {
  // If the path is already absolute, check if it's within root
  if (path.isAbsolute(relativePath)) {
    // If it's within root, use it directly
    if (relativePath.startsWith(root)) {
      return relativePath;
    }
    // Otherwise, resolve relative to root (maintains original behavior for relative paths)
    return path.join(root, relativePath);
  }
  // Relative path: join with root
  return path.join(root, relativePath);
}

// Helper function to read text file with streaming/pagination support
async function readTextFileStreaming(
  filePath: string,
  offset: number,
  limit: number | undefined,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ content: string; truncated: boolean; totalLines: number; totalChars: number }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let totalLines = 0;
    let totalChars = 0;
    let collectedChars = 0;
    let isTruncated = false;
    let isRangeComplete = false;
    
    const startLine = Math.max(0, offset - 1);
    const endLine = limit !== undefined ? startLine + limit : undefined;
    
    const readStream = createReadStream(filePath, { encoding: "utf-8" });
    const rl = createInterface({
      input: readStream,
      crlfDelay: Infinity,
    });
    
    let currentLineNumber = 0;
    
    rl.on("line", (line) => {
      if (signal?.aborted) {
        rl.close();
        readStream.destroy();
        reject(new Error("Read operation aborted"));
        return;
      }
      
      totalLines++;
      
      // Check if we've reached the requested range
      const isInRange = currentLineNumber >= startLine && (endLine === undefined || currentLineNumber < endLine);
      
      if (isInRange) {
        // Always add newline except for the last line we're collecting
        // Since we don't know if this is the last line until we've processed all lines,
        // we'll add newline to all collected lines and strip trailing newline at the end
        const lineWithNewline = line + "\n";
        const lineChars = lineWithNewline.length;
        
        // Check if adding this line would exceed maxChars
        if (collectedChars + lineChars > maxChars) {
          const remainingChars = maxChars - collectedChars;
          if (remainingChars > 0) {
            const partialLine = line.slice(0, remainingChars);
            lines.push(partialLine);
            collectedChars += partialLine.length;
            totalChars += partialLine.length;
          }
          isTruncated = true;
          rl.close();
          readStream.destroy();
          return;
        }
        
        lines.push(lineWithNewline);
        collectedChars += lineChars;
        totalChars += line.length;
      }
      
      currentLineNumber++;
      
      // Stop if we've collected the requested range
      if (endLine !== undefined && currentLineNumber >= endLine) {
        isRangeComplete = true;
        rl.close();
        readStream.destroy();
        return;
      }
      
      // Stop if we've reached truncation limit
      if (isTruncated) {
        rl.close();
        readStream.destroy();
      }
    });
    
    rl.on("close", () => {
      let content = lines.join("");
      
      // Remove trailing newline if present (since we added newline to all lines)
      if (content.endsWith("\n")) {
        content = content.slice(0, -1);
      }
      
      // Apply final truncation if needed (for cases where we didn't hit the line limit)
      if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        isTruncated = true;
      }
      
      // Add truncation notice
      if (isTruncated) {
        content += `\n\n... [Content truncated to ${maxChars} chars]`;
      }
      
      resolve({
        content,
        truncated: isTruncated,
        totalLines,
        totalChars,
      });
    });
    
    rl.on("error", (error) => {
      reject(error);
    });
    
    readStream.on("error", (error) => {
      reject(error);
    });
  });
}

// Helper function for bridge mode (falls back to full read since bridges don't support streaming)
async function readTextFileBridge(
  bridge: SandboxFsBridge,
  filePath: string,
  cwd: string,
  offset: number,
  limit: number | undefined,
  maxChars: number,
  signal?: AbortSignal,
): Promise<{ content: string; truncated: boolean; totalLines: number }> {
  const buffer = await bridge.readFile({
    filePath,
    cwd,
    signal,
  });
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf-8") : String(buffer);
  const lines = text.split("\n");
  const totalLines = lines.length;
  
  const start = Math.max(0, Math.min(offset - 1, totalLines));
  const end = limit !== undefined ? Math.min(start + limit, totalLines) : totalLines;
  let content = lines.slice(start, end).join("\n");
  
  let truncated = false;
  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + `\n\n... [Content truncated to ${maxChars} chars]`;
    truncated = true;
  }
  
  return { content, truncated, totalLines };
}

// --- OPERATIONS HELPERS ---

function createSandboxReadOperations(params: SandboxToolParams) {
  return {
    readFile: (filePath: string) => params.bridge.readFile({ filePath, cwd: params.root }),
    stat: (filePath: string) => params.bridge.stat({ filePath, cwd: params.root }),
    readdir: (filePath: string) => params.bridge.stat({ filePath, cwd: params.root }).then(() => []),
    access: (filePath: string) =>
      params.bridge.stat({ filePath, cwd: params.root }).then((s) => {
        if (!s) {
          throw new Error("ENOENT");
        }
      }),
  };
}

function createSandboxWriteOperations(params: SandboxToolParams) {
  return {
    writeFile: (filePath: string, data: string) =>
      params.bridge.writeFile({ filePath, data, cwd: params.root, mkdir: true }),
    mkdir: (filePath: string) => params.bridge.mkdirp({ filePath, cwd: params.root }),
  };
}

function createSandboxEditOperations(params: SandboxToolParams) {
  return {
    readFile: (filePath: string) => params.bridge.readFile({ filePath, cwd: params.root }),
    writeFile: (filePath: string, data: string) =>
      params.bridge.writeFile({ filePath, data, cwd: params.root }),
    access: (filePath: string) =>
      params.bridge.stat({ filePath, cwd: params.root }).then((s) => {
        if (!s) {
          throw new Error("ENOENT");
        }
      }),
  };
}

function createHostWriteOperations(
  root: string,
  options?: { workspaceOnly?: boolean },
): {
  writeFile: (filePath: string, data: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
} {
  const workspaceOnly = options?.workspaceOnly ?? false;

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow writes anywhere on the host
    return {
      mkdir: async (dir: string) => {
        const resolved = path.resolve(expandTildeToOsHome(dir));
        await fs.mkdir(resolved, { recursive: true });
      },
      writeFile: writeHostFile,
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    writeFile: (relativePath: string, data: string) =>
      writeFileWithinRoot({
        rootDir: root,
        relativePath,
        data,
        mkdir: true,
      }),
    mkdir: (relativePath: string) =>
      mkdirPathWithinRoot({
        rootDir: root,
        relativePath,
      }).then(() => {}),
  };
}

function createHostEditOperations(
  root: string,
  options?: { workspaceOnly?: boolean },
): {
  readFile: (filePath: string) => Promise<Buffer>;
  writeFile: (filePath: string, data: string) => Promise<void>;
  access: (filePath: string) => Promise<void>;
} {
  const workspaceOnly = options?.workspaceOnly ?? false;

  if (!workspaceOnly) {
    // When workspaceOnly is false, allow edits anywhere on the host
    return {
      readFile: async (filePath: string) => {
        const resolved = path.resolve(expandTildeToOsHome(filePath));
        const content = await fs.readFile(resolved, "utf-8");
        return Buffer.from(content, "utf-8");
      },
      writeFile: writeHostFile,
      access: async (filePath: string) => {
        const resolved = path.resolve(expandTildeToOsHome(filePath));
        await fs.access(resolved);
      },
    } as const;
  }

  // When workspaceOnly is true, enforce workspace boundary
  return {
    readFile: (relativePath: string) =>
      readFileWithinRoot({ rootDir: root, relativePath }).then((res) => res.buffer),
    writeFile: (relativePath: string, data: string) =>
      writeFileWithinRoot({
        rootDir: root,
        relativePath,
        data,
      }),
    access: (relativePath: string) => {
      // Resolve the path correctly for absolute paths within workspace
      const resolvedPath = resolveWorkspacePath(relativePath, root);
      return fs.access(resolvedPath);
    },
  };
}

function getImageMimeType(ext: string): string {
  if (ext === "svg") {
    return "image/svg+xml";
  }
  if (ext === "jpg") {
    return "image/jpeg";
  }
  return `image/${ext}`;
}

function getAudioMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/mp4",
    flac: "audio/flac",
    aac: "audio/aac",
    opus: "audio/opus",
    wma: "audio/x-ms-wma",
  };
  return mimeMap[ext] ?? "audio/mpeg";
}

function getVideoMimeType(ext: string): string {
  const mimeMap: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    avi: "video/x-msvideo",
    mkv: "video/x-matroska",
    m4v: "video/x-m4v",
    mpg: "video/mpeg",
    mpeg: "video/mpeg",
  };
  return mimeMap[ext] ?? "video/mp4";
}

function normalizePathForUrl(filePath: string): string {
  // Convert Windows backslashes to forward slashes
  const normalized = filePath.replace(/\\/g, "/");
  
  // Handle Windows drive letters: "C:/" -> "/C:/"
  // This ensures the URL path is absolute and valid
  if (/^[a-zA-Z]:\//.test(normalized) || /^[a-zA-Z]:$/.test(normalized)) {
    return `/${normalized}`;
  }
  
  // Ensure Unix absolute paths start with /
  if (!normalized.startsWith("/") && path.isAbsolute(filePath)) {
    return `/${normalized}`;
  }
  
  return normalized;
}

function getMediaUrl(filePath: string, getBaseUrl?: () => string): string {
  const normalizedPath = normalizePathForUrl(filePath);
  const encodedPath = normalizedPath.split("/").map(encodeURIComponent).join("/");
  
  // Use dynamic base URL if provided, otherwise fall back to localhost
  const baseUrl = getBaseUrl?.() || "http://localhost:18791";
  
  // Ensure no double slashes
  const cleanBaseUrl = baseUrl.replace(/\/$/, "");
  return `${cleanBaseUrl}${encodedPath}`;
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
    bridge: params.bridge,
    transformForTransport: false, // Webchat doesn't need transform
  } as OpenClawReadToolOptions);
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

export function createHostWorkspaceWriteTool(
  root: string,
  options?: { workspaceOnly?: boolean },
) {
  const base = createWriteTool(root, {
    operations: createHostWriteOperations(root, options),
  }) as unknown as AnyAgentTool;
  return wrapToolParamValidation(base, REQUIRED_PARAM_GROUPS.write);
}

export function createHostWorkspaceEditTool(
  root: string,
  options?: { workspaceOnly?: boolean },
) {
  const base = createEditTool(root, {
    operations: createHostEditOperations(root, options),
  }) as unknown as AnyAgentTool;
  const withRecovery = wrapEditToolWithRecovery(base, {
    root,
    readFile: (absolutePath: string) => fs.readFile(absolutePath, "utf-8"),
  });
  return wrapToolParamValidation(withRecovery, REQUIRED_PARAM_GROUPS.edit);
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
    if (localFilePath) {
      candidate = localFilePath;
    } else {
      // Windows fallback: handle container-style file:///workspace/... paths
      let parsed: URL;
      try {
        parsed = new URL(candidate);
      } catch {
        return params.filePath;
      }
      if (parsed.protocol !== "file:") {
        return params.filePath;
      }
      const host = parsed.hostname.trim().toLowerCase();
      if (host && host !== "localhost") {
        return params.filePath;
      }
      let normalizedPathname: string;
      try {
        normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
      } catch {
        return params.filePath;
      }
      // Only map if the path is within the container workdir
      if (
        normalizedPathname === normalizedWorkdir ||
        normalizedPathname.startsWith(`${normalizedWorkdir}/`)
      ) {
        candidate = normalizedPathname;
      } else {
        // Not a container workdir path, keep original
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
    existing.length > 0 && !existing.endsWith("\n") && !params.content.startsWith("\n")
      ? "\n"
      : "";
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
        toolCallId,
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

// Supported media file extensions for the read tool
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus", "wma"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv", "m4v", "mpg", "mpeg"]);
const MAX_DIR_ENTRIES = 200;

// Transform function for transports to use
export function transformToolResultForTransport(result: AgentToolResult): AgentToolResult {
  if (!result.content || !Array.isArray(result.content)) {
    return result;
  }

  const transformedContent = result.content.map((block: any) => {
    // Transform image blocks from webchat format to transport format
    if (block.type === 'image' && block.source && block.source.type === 'base64') {
      return {
        type: 'image',
        data: block.source.data,
        mimeType: block.source.media_type,
      };
    }
    
    // Audio blocks - transports don't support them, convert to text
    if (block.type === 'audio') {
      return {
        type: 'text',
        text: `Audio file: ${block.filename || 'audio'}\nURL: ${block.url}`,
      };
    }
    
    // Video blocks - transports don't support them, convert to text
    if (block.type === 'video') {
      return {
        type: 'text',
        text: `Video file: ${block.filename || 'video'}\nURL: ${block.url}`,
      };
    }
    
    return block;
  });

  return {
    ...result,
    content: transformedContent as any,
  };
}

export function createOpenClawReadTool(
  base: AnyAgentTool,
  options?: OpenClawReadToolOptions,
): AnyAgentTool {
  const useBridge = !!options?.bridge;

  return {
    ...base,
    execute: async (toolCallId, params, signal, _onUpdate): Promise<AgentToolResult> => {
      if (signal?.aborted) {
        throw new Error("Read operation aborted");
      }

      const normalized = normalizeToolParams(params);
      const record =
        normalized ??
        (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);

      const rawPath = typeof record?.path === "string" ? record.path : ".";
      const offset = typeof record?.offset === "number" ? record.offset : 0;
      const limit = typeof record?.limit === "number" ? record.limit : undefined;

      const rootDirResolved = options?.root ? path.resolve(options.root) : process.cwd();

      const inputPath = resolveToolPathAgainstWorkspaceRoot({
        filePath: rawPath,
        root: rootDirResolved,
        containerWorkdir: options?.containerWorkdir,
      });

      try {
        let stats;
        let isDirectory = false;
        let fileSize = 0;

        if (useBridge) {
          const bridgeStats = await options.bridge!.stat({
            filePath: inputPath,
            cwd: rootDirResolved,
            signal,
          });
          if (!bridgeStats) {
            throw new Error(`ENOENT: ${inputPath} not found in sandbox`);
          }
          // SandboxFsStat uses 'type' property instead of isDirectory()
          isDirectory = bridgeStats.type === "directory";
          fileSize = bridgeStats.size;
          stats = { size: fileSize, isDirectory: () => isDirectory };
        } else {
          stats = await fs.stat(inputPath);
          isDirectory = stats.isDirectory();
          fileSize = stats.size;
        }

        if (isDirectory) {
          if (signal?.aborted) {
            throw new Error("Read operation aborted");
          }

          // For sandboxed mode, we cannot list directory contents through the bridge
          // because SandboxFsBridge doesn't have a readdir method. Return a message
          // indicating that directory listing is not supported in sandboxed mode.
          if (useBridge) {
            return {
              toolCallId,
              content: [
                {
                  type: "text",
                  text: `Cannot list directory ${inputPath} in sandboxed mode. Please specify a specific file path.`,
                },
              ],
              details: { path: inputPath },
            } as AgentToolResult;
          }

          // Host mode - can list directories
          const files = await fs.readdir(inputPath);
          
          // Sort files for deterministic output (fixes cache determinism issue)
          const sortedFiles = [...files].sort((a, b) => a.localeCompare(b));

          let truncated = false;
          let fileList = sortedFiles;
          if (fileList.length > MAX_DIR_ENTRIES) {
            truncated = true;
            fileList = fileList.slice(0, MAX_DIR_ENTRIES);
          }

          const listingText = `Listing for ${inputPath}:\n${fileList.join("\n")}${
            truncated
              ? `\n\n... and ${files.length - MAX_DIR_ENTRIES} more entries not shown (limit: ${MAX_DIR_ENTRIES})`
              : ""
          }`;

          return {
            toolCallId,
            content: [{ type: "text", text: listingText }],
            details: { path: inputPath },
          } as AgentToolResult;
        }

        const ext = inputPath.toLowerCase().split(".").pop() ?? "";
        const fileName = path.basename(inputPath);
        
        // Build valid media URLs using dynamic base URL (fixes localhost hardcoding issue)
        const mediaUrl = getMediaUrl(inputPath, options?.getBaseUrl);

        let result: AgentToolResult;

        if (IMAGE_EXTENSIONS.has(ext)) {
          if (signal?.aborted) {
            throw new Error("Read operation aborted");
          }

          // Use bridge for file reading if available
          let fileBuffer: Buffer;
          if (useBridge) {
            const buffer = await options.bridge!.readFile({
              filePath: inputPath,
              cwd: rootDirResolved,
              signal,
            });
            fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
          } else {
            fileBuffer = await fs.readFile(inputPath);
          }

          let mimeType = getImageMimeType(ext);

          if (options?.imageSanitization) {
            try {
              const maxDimensionPx = options.imageSanitization.maxDimensionPx || 3840;
              const maxBytes = options.imageSanitization.maxBytes || 5 * 1024 * 1024;

              const meta = await getImageMetadata(fileBuffer);
              if (meta?.width && meta?.height) {
                if (
                  meta.width > maxDimensionPx ||
                  meta.height > maxDimensionPx ||
                  fileBuffer.length > maxBytes
                ) {
                  const resized = await resizeToJpeg({
                    buffer: fileBuffer,
                    maxSide: maxDimensionPx,
                    quality: 85,
                    withoutEnlargement: true,
                  });
                  fileBuffer = Buffer.from(resized);
                  mimeType = "image/jpeg";
                }
              }
            } catch (sanitizeError) {
              console.warn(`Image sanitization failed for ${fileName}:`, sanitizeError);
            }
          }

          // KEEP THE ORIGINAL WORKING FORMAT
          result = {
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
              { type: "text", text: `📷 [${fileName}](${mediaUrl})` },
            ],
            details: { path: inputPath, size: fileBuffer.length },
          } as AgentToolResult;
        } else if (AUDIO_EXTENSIONS.has(ext)) {
          // Audio handling with player - KEEP ORIGINAL FORMAT
          const mimeType = getAudioMimeType(ext);

          result = {
            toolCallId,
            content: [
              {
                type: "audio",
                url: mediaUrl,
                filename: fileName,
                mimeType: mimeType,
              } as any,
              { type: "text", text: `🎵 [${fileName}](${mediaUrl})` },
            ],
            details: { path: inputPath, size: fileSize },
          } as AgentToolResult;
        } else if (VIDEO_EXTENSIONS.has(ext)) {
          // Video handling with player - KEEP ORIGINAL FORMAT
          const mimeType = getVideoMimeType(ext);

          result = {
            toolCallId,
            content: [
              {
                type: "video",
                url: mediaUrl,
                filename: fileName,
                mimeType: mimeType,
              } as any,
              { type: "text", text: `🎬 [${fileName}](${mediaUrl})` },
            ],
            details: { path: inputPath, size: fileSize },
          } as AgentToolResult;
        } else {
          if (signal?.aborted) {
            throw new Error("Read operation aborted");
          }

          const maxChars = options?.modelContextWindowTokens
            ? options.modelContextWindowTokens * 3
            : 32000;

          let text: string;
          let truncated = false;

          // Use streaming for host mode, fallback to full read for bridge mode
          if (useBridge) {
            const bridgeResult = await readTextFileBridge(
              options.bridge!,
              inputPath,
              rootDirResolved,
              offset,
              limit,
              maxChars,
              signal,
            );
            text = bridgeResult.content;
            truncated = bridgeResult.truncated;
          } else {
            const streamResult = await readTextFileStreaming(
              inputPath,
              offset,
              limit,
              maxChars,
              signal,
            );
            text = streamResult.content;
            truncated = streamResult.truncated;
          }

          result = {
            toolCallId,
            content: [{ type: "text", text }],
            details: { path: inputPath, size: fileSize, offset, limit, truncated },
          } as AgentToolResult;
        }

        // Apply transport transformation if requested
        if (options?.transformForTransport) {
          result = transformToolResultForTransport(result);
        }

        return result;
      } catch (error) {
        // Re-throw abort errors to maintain cancellation semantics
        if (signal?.aborted || (error as Error).message === "Read operation aborted") {
          throw error;
        }
        
        // Check for abort signal related errors from the bridge or streaming
        const err = error as Error & { code?: string };
        if (err.name === "AbortError" || err.code === "ABORT_ERR") {
          throw error;
        }
        
        // For all other errors, return a friendly error message
        return {
          toolCallId,
          content: [
            { type: "text", text: `Error reading path: ${err.message}` },
          ],
          details: { path: inputPath },
        } as AgentToolResult;
      }
    },
  };
}