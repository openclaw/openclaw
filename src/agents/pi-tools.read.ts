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
import { detectMime } from "../media/mime.js";
import { kindFromMime } from "../media/mime.js";
import { readLocalFileSafely } from "../infra/fs-safe.js";

export {
  REQUIRED_PARAM_GROUPS,
  assertRequiredParams,
  getToolParamsRecord,
  wrapToolParamValidation,
} from "./pi-tools.params.js";

// Define types for better type safety
interface BridgeWithReaddir extends SandboxFsBridge {
  readdir?: (params: { filePath: string; cwd: string }) => Promise<unknown>;
}

interface ContentBlock {
  type: string;
  source?: {
    type: string;
    media_type?: string;
    data?: string;
  };
  url?: string;
  filename?: string;
  mimeType?: string;
  text?: string;
}

interface ImageSanitizationLimits {
  maxBytes?: number;
  maxDimensionPx?: number;
}

interface ResizeImageOptions {
  maxBytes: number;
  maxDimensionPx: number;
  initialQuality?: number;
  minQuality?: number;
  maxAttempts?: number;
}

interface ResizeImageResult {
  buffer: Buffer;
  mimeType: string;
  success: boolean;
  error?: string;
  attempts: number;
  finalQuality: number;
}

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
  imageSanitization?: ImageSanitizationLimits;
  root?: string;
  containerWorkdir?: string;
  bridge?: SandboxFsBridge;
  getBaseUrl?: () => string;
  transformForTransport?: boolean;
};

// Helper function to resolve absolute paths within workspace
function resolveWorkspacePath(relativePath: string, root: string): string {
  if (path.isAbsolute(relativePath)) {
    if (relativePath.startsWith(root)) {
      return relativePath;
    }
    return path.join(root, relativePath);
  }
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
      
      const isInRange = currentLineNumber >= startLine && (endLine === undefined || currentLineNumber < endLine);
      
      if (isInRange) {
        const lineWithNewline = line + "\n";
        const lineChars = lineWithNewline.length;
        
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
      
      if (endLine !== undefined && currentLineNumber >= endLine) {
        rl.close();
        readStream.destroy();
        return;
      }
      
      if (isTruncated) {
        rl.close();
        readStream.destroy();
      }
    });
    
    rl.on("close", () => {
      let content = lines.join("");
      
      if (content.endsWith("\n")) {
        content = content.slice(0, -1);
      }
      
      if (content.length > maxChars) {
        content = content.slice(0, maxChars);
        isTruncated = true;
      }
      
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

// Helper function for bridge mode - reads entire file but respects maxChars after
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
  
  // Apply character limit after reading
  let truncatedText = text;
  let truncated = false;
  if (text.length > maxChars) {
    truncatedText = text.slice(0, maxChars);
    truncated = true;
  }
  
  const lines = truncatedText.split("\n");
  const totalLines = lines.length;
  
  const start = Math.max(0, Math.min(offset - 1, totalLines));
  const end = limit !== undefined ? Math.min(start + limit, totalLines) : totalLines;
  let content = lines.slice(start, end).join("\n");
  
  if (truncated && content.length === maxChars) {
    content += `\n\n... [Content truncated to ${maxChars} chars]`;
  }
  
  return { content, truncated, totalLines };
}

// Helper function to read limited bytes from bridge by reading and slicing
async function readFileBytesWithLimit(
  bridge: SandboxFsBridge,
  filePath: string,
  cwd: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Buffer> {
  const result = await bridge.readFile({
    filePath,
    cwd,
    signal,
  });
  const buffer = Buffer.isBuffer(result) ? result : Buffer.from(result);
  return buffer.slice(0, maxBytes);
}

// Helper function to detect if a WebM file is audio-only using bridge-aware reads
async function isWebmAudioOnly(filePath: string, bridge?: SandboxFsBridge, cwd?: string): Promise<boolean> {
  try {
    let buffer: Buffer;
    
    if (bridge && cwd) {
      // Read only first 8KB for MIME detection
      buffer = await readFileBytesWithLimit(bridge, filePath, cwd, 8192);
    } else {
      // Use local filesystem with byte limit
      const { buffer: localBuffer } = await readLocalFileSafely({ filePath, maxBytes: 8192 });
      buffer = localBuffer;
    }
    
    const detectedMime = await detectMime({ buffer, filePath });
    const mimeType = detectedMime ?? "video/webm"; // Default to video if detection fails
    const kind = kindFromMime(mimeType);
    return kind === 'audio';
  } catch (error) {
    console.warn(`Failed to detect WebM type for ${filePath}, treating as video:`, error);
    return false;
  }
}

/**
 * Iteratively resizes an image until it meets byte size limits or quality minimum is reached
 * Uses progressive quality reduction and dimension constraints
 */
async function resizeImageToSizeLimit(
  fileBuffer: Buffer,
  fileName: string,
  options: ResizeImageOptions
): Promise<ResizeImageResult> {
  const {
    maxBytes,
    maxDimensionPx,
    initialQuality = 85,
    minQuality = 30,
    maxAttempts = 5
  } = options;
  
  let currentBuffer = fileBuffer;
  let currentMimeType = "image/jpeg";
  let currentQuality = initialQuality;
  let attempts = 0;
  
  // Check dimension constraints first, even if under byte limit
  let needsDimensionResize = false;
  try {
    const meta = await getImageMetadata(currentBuffer);
    if (meta?.width && meta?.height) {
      needsDimensionResize = meta.width > maxDimensionPx || meta.height > maxDimensionPx;
    }
  } catch (metaError) {
    console.warn(`Image metadata extraction failed for ${fileName}:`, metaError);
  }
  
  // If under byte limit but needs dimension resize, still resize
  if (!needsDimensionResize && currentBuffer.length <= maxBytes) {
    return {
      buffer: currentBuffer,
      mimeType: currentMimeType,
      success: true,
      attempts: 0,
      finalQuality: initialQuality
    };
  }
  
  console.log(`Resizing image ${fileName}: initial=${Math.round(currentBuffer.length / 1024)}KB, limit=${Math.round(maxBytes / 1024)}KB, needsDimensionResize=${needsDimensionResize}`);
  
  while (attempts < maxAttempts && (currentBuffer.length > maxBytes || (needsDimensionResize && attempts === 0)) && currentQuality >= minQuality) {
    try {
      // Log current state for debugging
      let dimensions = "";
      try {
        const meta = await getImageMetadata(currentBuffer);
        if (meta?.width && meta?.height) {
          dimensions = `, dimensions=${meta.width}x${meta.height}`;
        }
      } catch {
        // Metadata extraction failure is non-critical
      }
      
      console.log(`Resize attempt ${attempts + 1}/${maxAttempts}: quality=${currentQuality}${dimensions}`);
      
      const resized = await resizeToJpeg({
        buffer: currentBuffer,
        maxSide: maxDimensionPx,
        quality: currentQuality,
        withoutEnlargement: true,
      });
      
      currentBuffer = Buffer.from(resized);
      currentMimeType = "image/jpeg";
      
      // Reduce quality for next iteration if still too large
      if (currentBuffer.length > maxBytes) {
        currentQuality = Math.max(minQuality, currentQuality - 15);
      }
      
      attempts++;
      needsDimensionResize = false; // After first resize, dimensions are handled
    } catch (error) {
      console.error(`Resize attempt ${attempts + 1} failed for ${fileName}:`, error);
      return {
        buffer: currentBuffer,
        mimeType: currentMimeType,
        success: false,
        error: `Resize failed: ${error instanceof Error ? error.message : String(error)}`,
        attempts: attempts + 1,
        finalQuality: currentQuality
      };
    }
  }
  
  const success = currentBuffer.length <= maxBytes;
  
  if (!success) {
    console.warn(`Image ${fileName} still exceeds limit after ${attempts} attempts: ${Math.round(currentBuffer.length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB`);
  }
  
  return {
    buffer: currentBuffer,
    mimeType: currentMimeType,
    success,
    attempts,
    finalQuality: currentQuality
  };
}

// --- OPERATIONS HELPERS ---

function createSandboxReadOperations(params: SandboxToolParams) {
  return {
    readFile: (filePath: string) => params.bridge.readFile({ filePath, cwd: params.root }),
    stat: (filePath: string) => params.bridge.stat({ filePath, cwd: params.root }),
    readdir: async (filePath: string) => {
      const bridgeWithReaddir = params.bridge as BridgeWithReaddir;
      if (typeof bridgeWithReaddir.readdir === 'function') {
        return await bridgeWithReaddir.readdir({ filePath, cwd: params.root });
      }
      throw new Error(
        `Directory listing not supported in sandbox mode for ${filePath}. ` +
        `The current bridge implementation does not support readdir operations.`
      );
    },
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
    return {
      mkdir: async (dir: string) => {
        const resolved = path.resolve(expandTildeToOsHome(dir));
        await fs.mkdir(resolved, { recursive: true });
      },
      writeFile: writeHostFile,
    } as const;
  }

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
  const normalized = filePath.replace(/\\/g, "/");
  
  if (/^[a-zA-Z]:\//.test(normalized) || /^[a-zA-Z]:$/.test(normalized)) {
    return `/${normalized}`;
  }
  
  if (!normalized.startsWith("/") && path.isAbsolute(filePath)) {
    return `/${normalized}`;
  }
  
  return normalized;
}

function getMediaUrl(filePath: string, workspaceRoot: string, getBaseUrl?: () => string): string {
  // 1. Cross-Platform Normalization
  // path.resolve() handles the OS-specific absolute path logic.
  // .replace ensures that even on Windows, we are working with '/' for string manipulation.
  const normalizedFile = path.resolve(filePath).replace(/\\/g, '/');
  const normalizedRoot = path.resolve(workspaceRoot).replace(/\\/g, '/');

  let finalRelativePath = "";

  // 2. The "Workspace Anchor" Logic (Case-Insensitive)
  // This works on Linux (/home/user/workspace/...) and Windows (C:/workspace/...)
  const workspaceMarker = "/workspace/";
  const lowerFile = normalizedFile.toLowerCase();
  const workspaceIndex = lowerFile.indexOf(workspaceMarker);

  if (workspaceIndex !== -1) {
    // Preserve the actual folder casing from the original path
    finalRelativePath = normalizedFile.slice(workspaceIndex + workspaceMarker.length);
  } else {
    // Fallback if the folder isn't named 'workspace'
    const rootDir = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/';
    
    if (normalizedFile.startsWith(rootDir)) {
      finalRelativePath = normalizedFile.slice(rootDir.length);
    } else {
      finalRelativePath = path.basename(normalizedFile);
    }
  }

  // 3. URL Construction
  // We split by '/' (which we guaranteed in step 1) and encode each part.
  const urlPath = finalRelativePath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');

  const baseUrl = getBaseUrl ? getBaseUrl().replace(/\/+$/, '') : 'http://localhost:18791';
  
  return `${baseUrl}/${urlPath}`;
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
    root: params.root,
    modelContextWindowTokens: params.modelContextWindowTokens,
    imageSanitization: params.imageSanitization,
    bridge: params.bridge,
    transformForTransport: false,
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
      if (
        normalizedPathname === normalizedWorkdir ||
        normalizedPathname.startsWith(`${normalizedWorkdir}/`)
      ) {
        candidate = normalizedPathname;
      } else {
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
      // Limit to 10MB for memory flush reads
      const limitedBuffer = Buffer.isBuffer(buffer) ? buffer.slice(0, 10 * 1024 * 1024) : Buffer.from(buffer).slice(0, 10 * 1024 * 1024);
      return limitedBuffer.toString("utf-8");
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

// Supported media file extensions
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac", "opus", "wma"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "m4v", "mpg", "mpeg"]);
const WEBM_EXTENSION = "webm";

// Transform function for transports
export function transformToolResultForTransport(result: AgentToolResult): AgentToolResult {
  if (!result.content || !Array.isArray(result.content)) {
    return result;
  }

  const transformedContent = result.content.map((block: ContentBlock) => {
    if (block.type === 'image' && block.source && block.source.type === 'base64') {
      return {
        type: 'text' as const,
        text: block.filename ?? 'image',
      };
    }
    
    if (block.type === 'audio') {
      // Preserve audio blocks that contain base64 data
      if (block.source && block.source.type === 'base64') {
        return block;
      }
      return {
        type: 'text' as const,
        text: block.filename ?? 'audio',
      };
    }
    
    if (block.type === 'video') {
      return {
        type: 'text' as const,
        text: block.filename ?? 'video',
      };
    }
    
    return block;
  });

  // Added 'audio' to the filter to allow base64 audio blocks to pass through
  const filteredContent = transformedContent.filter(
    (block) => block.type === 'text' || block.type === 'image' || block.type === 'audio'
  );
  
  return {
    ...result,
    content: filteredContent as AgentToolResult['content'],
  };
}

// Helper function to get fallback MIME type from extension
function getFallbackMimeTypeFromExtension(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  return getFallbackMimeType(ext);
}

function getFallbackMimeType(ext: string): string {
  if (IMAGE_EXTENSIONS.has(ext)) {
    return getImageMimeType(ext);
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return getAudioMimeType(ext);
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return getVideoMimeType(ext);
  }
  if (ext === WEBM_EXTENSION) {
    return "video/webm";
  }
  return "text/plain";
}

function getKindFromExtension(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext) || ext === WEBM_EXTENSION) {
    return "video";
  }
  return "text";
}

// Helper function to detect media type from file bytes with proper byte limits
async function detectMediaTypeFromBytes(
  filePath: string,
  useBridge: boolean,
  bridge: SandboxFsBridge | undefined,
  cwd: string,
  signal?: AbortSignal,
  maxBytesForSniffing: number = 8192 // Default to 8KB for MIME sniffing
): Promise<{ mimeType: string; kind: string; extension: string }> {
  try {
    let buffer: Buffer;
    
    if (useBridge && bridge) {
      // FIXED: Use helper that reads only first maxBytesForSniffing bytes
      buffer = await readFileBytesWithLimit(bridge, filePath, cwd, maxBytesForSniffing, signal);
    } else {
      const { buffer: localBuffer } = await readLocalFileSafely({ filePath, maxBytes: maxBytesForSniffing });
      buffer = localBuffer;
    }
    
    const detectedMime = await detectMime({ buffer, filePath });
    const mimeType = detectedMime ?? getFallbackMimeTypeFromExtension(filePath);
    const detectedKind = kindFromMime(mimeType);
    const kind = detectedKind ?? getKindFromExtension(filePath);
    const ext = filePath.toLowerCase().split(".").pop() ?? "";
    
    return { mimeType, kind, extension: ext };
  } catch (error) {
    console.warn(`Failed to detect MIME type for ${filePath}, falling back to extension:`, error);
    const ext = filePath.toLowerCase().split(".").pop() ?? "";
    const mimeType = getFallbackMimeType(ext);
    const kind = getKindFromExtension(filePath);
    return { mimeType, kind, extension: ext };
  }
}

// Helper function to create text fallback for media results
function createMediaResultWithFallback(
  toolCallId: string,
  mediaType: string,
  fileName: string,
  mediaUrl: string,
  mimeType: string,
  filePath: string,
  fileSize: number,
  details: Record<string, unknown>,
  fileBuffer?: Buffer // Added optional buffer parameter
): AgentToolResult {
  const mediaContent: ContentBlock = {
    type: mediaType as "audio" | "video",
    url: mediaUrl,
    filename: fileName,
    mimeType: mimeType,
  };

  // Add base64 source if a buffer is provided (for small audio files)
  if (fileBuffer) {
    mediaContent.source = {
      type: "base64",
      media_type: mimeType,
      data: fileBuffer.toString("base64"),
    };
  }
  
  const textFallback = `[${mediaType.toUpperCase()}] ${fileName}\nURL: ${mediaUrl}\nType: ${mimeType}\nSize: ${fileSize} bytes`;
  
  return {
    toolCallId,
    content: [mediaContent, { type: "text", text: textFallback }],
    details: { path: filePath, size: fileSize, ...details },
  } as AgentToolResult;
}

export function createOpenClawReadTool(
  base: AnyAgentTool,
  options?: OpenClawReadToolOptions,
): AnyAgentTool {
  const useBridge = !!options?.bridge;
  const MAX_IMAGE_BYTES_BEFORE_SANITIZATION = 50 * 1024 * 1024; 
  const MAX_AUDIO_BASE64_BYTES = 100 * 1024 * 1024; // 100MB limit for base64 audio

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
          isDirectory = bridgeStats.type === "directory";
          fileSize = bridgeStats.size;
        } else {
          const stats = await fs.stat(inputPath);
          isDirectory = stats.isDirectory();
          fileSize = stats.size;
        }

        if (isDirectory) {
          const result = await base.execute(toolCallId, params, signal);
          
          if (options?.transformForTransport) {
            return transformToolResultForTransport(result);
          }
          
          return result;
        }

        const { mimeType, kind, extension: detectedExt } = await detectMediaTypeFromBytes(
          inputPath,
          useBridge,
          options?.bridge,
          rootDirResolved,
          signal,
          8192,
        );
        
        const fileName = path.basename(inputPath);
        const mediaUrl = getMediaUrl(inputPath, rootDirResolved, options?.getBaseUrl);

        let result: AgentToolResult;

        if (kind === "audio") {
          let fileBuffer: Buffer | undefined;
          // Read full file if it's within the 100MB limit
          if (fileSize <= MAX_AUDIO_BASE64_BYTES) {
            if (useBridge && options?.bridge) {
              const buffer = await options.bridge.readFile({ filePath: inputPath, cwd: rootDirResolved, signal });
              fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
            } else {
              fileBuffer = await fs.readFile(inputPath);
            }
          }

          result = createMediaResultWithFallback(
            toolCallId,
            "audio",
            fileName,
            mediaUrl,
            mimeType,
            inputPath,
            fileSize,
            { detectedVia: "mime-sniff" },
            fileBuffer
          );
        } 
        else if (kind === "video") {
          if (detectedExt === WEBM_EXTENSION && mimeType === "video/webm") {
            const isAudioOnly = await isWebmAudioOnly(inputPath, options?.bridge, rootDirResolved);
            if (isAudioOnly) {
              let fileBuffer: Buffer | undefined;
              if (fileSize <= MAX_AUDIO_BASE64_BYTES) {
                if (useBridge && options?.bridge) {
                  const buffer = await options.bridge.readFile({ filePath: inputPath, cwd: rootDirResolved, signal });
                  fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
                } else {
                  fileBuffer = await fs.readFile(inputPath);
                }
              }

              result = createMediaResultWithFallback(
                toolCallId,
                "audio",
                fileName,
                mediaUrl,
                "audio/webm",
                inputPath,
                fileSize,
                { detectedVia: "mime-sniff", webmDetectedAs: "audio-only" },
                fileBuffer
              );
            } else {
              result = createMediaResultWithFallback(
                toolCallId,
                "video",
                fileName,
                mediaUrl,
                mimeType,
                inputPath,
                fileSize,
                { detectedVia: "mime-sniff" },
              );
            }
          } else {
            result = createMediaResultWithFallback(
              toolCallId,
              "video",
              fileName,
              mediaUrl,
              mimeType,
              inputPath,
              fileSize,
              { detectedVia: "mime-sniff" },
            );
          }
        }
        else if (kind === "image") {
          if (signal?.aborted) {
            throw new Error("Read operation aborted");
          }

          let fileBuffer: Buffer;
          if (useBridge) {
            const buffer = await options.bridge!.readFile({
              filePath: inputPath,
              cwd: rootDirResolved,
              signal,
            });
            fileBuffer = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
          } else {
            if (fileSize > MAX_IMAGE_BYTES_BEFORE_SANITIZATION) {
              const errorResult = {
                toolCallId,
                content: [
                  {
                    type: "text" as const,
                    text: `Error: Image file '${fileName}' is too large (${Math.round(fileSize / 1024 / 1024)}MB). Maximum allowed size before processing is ${Math.round(MAX_IMAGE_BYTES_BEFORE_SANITIZATION / 1024 / 1024)}MB.`,
                  },
                ],
                details: { 
                  path: inputPath, 
                  error: "Image exceeds maximum read size",
                  fileSize,
                  maxAllowed: MAX_IMAGE_BYTES_BEFORE_SANITIZATION,
                },
              } as AgentToolResult;
              
              if (options?.transformForTransport) {
                return transformToolResultForTransport(errorResult);
              }
              return errorResult;
            }
            
            fileBuffer = await fs.readFile(inputPath);
          }

          let finalMimeType = mimeType;
          
          if (options?.imageSanitization) {
            const maxBytes = options.imageSanitization.maxBytes ?? 5 * 1024 * 1024;
            const maxDimensionPx = options.imageSanitization.maxDimensionPx ?? 1200;
            
            let needsSanitization = fileBuffer.length > maxBytes;
            
            if (!needsSanitization) {
              try {
                const meta = await getImageMetadata(fileBuffer);
                if (meta?.width && meta?.height) {
                  needsSanitization = meta.width > maxDimensionPx || meta.height > maxDimensionPx;
                }
              } catch (metaError) {
                console.warn(`Image metadata extraction failed for ${fileName}:`, metaError);
              }
            }
            
            if (needsSanitization) {
              const resizeResult = await resizeImageToSizeLimit(fileBuffer, fileName, {
                maxBytes,
                maxDimensionPx,
                initialQuality: 85,
                minQuality: 30,
                maxAttempts: 5,
              });
              
              if (!resizeResult.success) {
                const errorResult = {
                  toolCallId,
                  content: [
                    {
                      type: "text" as const,
                      text: `Error: Unable to process image '${fileName}'. ${resizeResult.error || `Could not resize to meet ${Math.round(maxBytes / 1024)}KB limit after ${resizeResult.attempts} attempts.`}`,
                    },
                  ],
                  details: { 
                    path: inputPath, 
                    error: "Image sanitization failed",
                    originalSize: fileBuffer.length,
                    resizeAttempts: resizeResult.attempts,
                  },
                } as AgentToolResult;
                
                if (options?.transformForTransport) {
                  return transformToolResultForTransport(errorResult);
                }
                return errorResult;
              }
              
              fileBuffer = resizeResult.buffer;
              finalMimeType = resizeResult.mimeType;
              
              console.log(`Image ${fileName} resized successfully: ${Math.round(fileBuffer.length / 1024)}KB (quality: ${resizeResult.finalQuality}, attempts: ${resizeResult.attempts})`);
            }
          }
          
          const imageContent: ContentBlock = {
            type: "image",
            source: {
              type: "base64",
              media_type: finalMimeType,
              data: fileBuffer.toString("base64"),
            },
          };
          result = {
            toolCallId,
            content: [imageContent, { type: "text", text: fileName }],
            details: { path: inputPath, size: fileBuffer.length, detectedVia: "mime-sniff" },
          } as AgentToolResult;
        } 
        else {
          if (signal?.aborted) {
            throw new Error("Read operation aborted");
          }

          const maxChars = options?.modelContextWindowTokens
            ? options.modelContextWindowTokens * 3
            : 32000;

          let text: string;
          let truncated = false;

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
            details: { path: inputPath, size: fileSize, offset, limit, truncated, detectedVia: "mime-sniff" },
          } as AgentToolResult;
        }

        if (options?.transformForTransport) {
          result = transformToolResultForTransport(result);
        }

        return result;
      } catch (error) {
        if (signal?.aborted || (error as Error).message === "Read operation aborted") {
          throw error;
        }
        
        const err = error as Error & { code?: string };
        if (err.name === "AbortError" || err.code === "ABORT_ERR") {
          throw error;
        }
        
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