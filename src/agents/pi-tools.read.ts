// src/agents/pi-tools.read.ts
// No top-level import needed - using dynamic import above to avoid circular deps
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createEditTool, createReadTool, createWriteTool } from "@mariozechner/pi-coding-agent";
import {
  appendFileWithinRoot,
  readFileWithinRoot,
  writeFileWithinRoot,
  mkdirPathWithinRoot,
} from "../infra/fs-safe.js";
import { trySafeFileURLToPath } from "../infra/local-file-access.js";
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
  bridge?: SandboxFsBridge;
};

// --- OPERATIONS HELPERS ---

function createSandboxReadOperations(params: SandboxToolParams) {
  return {
    readFile: (filePath: string) => params.bridge.readFile({ filePath, cwd: params.root }),
    stat: (filePath: string) => params.bridge.stat({ filePath, cwd: params.root }),
    readdir: (filePath: string) => params.bridge.stat({ filePath, cwd: params.root }).then(() => []),
    access: (filePath: string) => params.bridge.stat({ filePath, cwd: params.root }).then(s => { if (!s) { throw new Error("ENOENT"); } })
  };
}

function createSandboxWriteOperations(params: SandboxToolParams) {
  return {
    writeFile: (filePath: string, data: string) =>
      params.bridge.writeFile({ filePath, data, cwd: params.root, mkdir: true }),
    mkdir: (filePath: string) => params.bridge.mkdirp({ filePath, cwd: params.root })
  };
}

function createSandboxEditOperations(params: SandboxToolParams) {
  return {
    readFile: (filePath: string) =>
      params.bridge.readFile({ filePath, cwd: params.root }), 
    writeFile: (filePath: string, data: string) =>
      params.bridge.writeFile({ filePath, data, cwd: params.root }),
    access: (filePath: string) => params.bridge.stat({ filePath, cwd: params.root }).then(s => { if (!s) { throw new Error("ENOENT"); } })
  };
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
      writeFile: (filePath: string, data: string) => fs.writeFile(path.resolve(filePath), data, "utf-8"),
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
      }).then(() => {})
  };
}

function createHostEditOperations(root: string, _options?: { workspaceOnly?: boolean }) {
  return {
    readFile: (absolutePath: string) => {
      // Convert absolute path to relative path from root
      const relativePath = path.relative(root, absolutePath);
      return readFileWithinRoot({ rootDir: root, relativePath }).then(res => res.buffer);
    },
    writeFile: (absolutePath: string, data: string) => {
      // Convert absolute path to relative path from root
      const relativePath = path.relative(root, absolutePath);
      return writeFileWithinRoot({
        rootDir: root,
        relativePath,
        data,
      });
    },
    access: (absolutePath: string) => {
      // For access, we can use the absolute path directly since it's not going through fs-safe
      return fs.access(absolutePath);
    }
  };
}

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
    bridge: params.bridge,
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

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "ogg", "m4a", "flac", "aac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "avi", "mkv"]);
const MAX_DIR_ENTRIES = 200;

// Helper function to read text file with streaming for offset/limit
async function readTextFileWithStreaming(
  filePath: string,
  offset: number,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    let currentLine = 0;
    const startLine = Math.max(0, offset - 1);
    const endLine = limit !== undefined ? startLine + limit : Infinity;
    let lineCount = 0;
    
    const readStream = createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: readStream,
      crlfDelay: Infinity
    });
    
    const abortHandler = () => {
      rl.close();
      readStream.destroy();
      reject(new Error("Read operation aborted"));
    };
    
    if (signal) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    
    rl.on('line', (line) => {
      lineCount++;
      
      // Check abort signal periodically
      if (signal?.aborted) {
        rl.close();
        readStream.destroy();
        reject(new Error("Read operation aborted"));
        return;
      }
      
      if (lineCount > endLine) {
        rl.close();
        readStream.destroy();
        return;
      }
      
      if (lineCount >= startLine) {
        lines.push(line);
      }
    });
    
    rl.on('close', () => {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      resolve(lines.join('\n'));
    });
    
    rl.on('error', (error) => {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      reject(error);
    });
    
    readStream.on('error', (error) => {
      if (signal) {
        signal.removeEventListener('abort', abortHandler);
      }
      reject(error);
    });
  });
}

// Helper function to read text file from sandbox bridge with streaming-like behavior
async function readTextFileFromSandbox(
  bridge: SandboxFsBridge,
  filePath: string,
  cwd: string,
  offset: number,
  limit: number | undefined,
  signal?: AbortSignal
): Promise<string> {
  // For sandbox bridge, we have to read the entire file since the bridge API doesn't support streaming
  // But we can still optimize by reading once and then slicing
  const buffer = await bridge.readFile({ 
    filePath, 
    cwd,
    signal 
  });
  
  if (signal?.aborted) {
    throw new Error("Read operation aborted");
  }
  
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf-8") : String(buffer);
  
  if (offset > 0 || limit !== undefined) {
    const lines = text.split('\n');
    const start = Math.max(0, Math.min(offset - 1, lines.length));
    const end = limit !== undefined ? Math.min(start + limit, lines.length) : lines.length;
    return lines.slice(start, end).join('\n');
  }
  
  return text;
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
      const record = normalized ?? (params && typeof params === "object" ? (params as Record<string, unknown>) : undefined);
      assertRequiredParams(record, CLAUDE_PARAM_GROUPS.read, base.name);

      const rawPath = typeof record?.path === "string" ? record.path : ".";
      const offset = typeof record?.offset === 'number' ? record.offset : 0;
      const limit = typeof record?.limit === 'number' ? record.limit : undefined;

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
            signal 
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
          if (signal?.aborted) { throw new Error("Read operation aborted"); }

          // For sandboxed mode, we cannot list directory contents through the bridge
          // because SandboxFsBridge doesn't have a readdir method. Return a message
          // indicating that directory listing is not supported in sandboxed mode.
          if (useBridge) {
            return {
              toolCallId,
              content: [{ type: "text", text: `Cannot list directory ${inputPath} in sandboxed mode. Please specify a specific file path.` }],
              details: { path: inputPath },
            } as AgentToolResult;
          }

          // Host mode - can list directories
          const files = await fs.readdir(inputPath);
          
          let truncated = false;
          let fileList = files;
          if (fileList.length > MAX_DIR_ENTRIES) {
            truncated = true;
            fileList = fileList.slice(0, MAX_DIR_ENTRIES);
          }

          const listingText = `Listing for ${inputPath}:\n${fileList.join("\n")}${
            truncated ? `\n\n... and ${files.length - MAX_DIR_ENTRIES} more entries not shown (limit: ${MAX_DIR_ENTRIES})` : ""
          }`;

          return {
            toolCallId,
            content: [{ type: "text", text: listingText }],
            details: { path: inputPath },
          } as AgentToolResult;
        }

        const ext = inputPath.toLowerCase().split(".").pop() ?? "";
        const fileName = path.basename(inputPath);
        const mediaUrl = `http://localhost:18791${inputPath.split('/').map(encodeURIComponent).join('/')}`;

        if (IMAGE_EXTENSIONS.has(ext)) {
          if (signal?.aborted) { throw new Error("Read operation aborted"); }

          // Use bridge for file reading if available
          let fileBuffer: Buffer;
          if (useBridge) {
            const buffer = await options.bridge!.readFile({ 
              filePath: inputPath, 
              cwd: rootDirResolved,
              signal 
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
                if (meta.width > maxDimensionPx || meta.height > maxDimensionPx || fileBuffer.length > maxBytes) {
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
              { type: "text", text: `📷 [${fileName}](${mediaUrl})` },
            ],
            details: { path: inputPath, size: fileBuffer.length },
          } as AgentToolResult;
        }

        if (AUDIO_EXTENSIONS.has(ext)) {
          const mimeType = ext === "mp3" ? "audio/mpeg" : 
                           ext === "wav" ? "audio/wav" :
                           ext === "ogg" ? "audio/ogg" :
                           ext === "m4a" ? "audio/mp4" :
                           ext === "flac" ? "audio/flac" :
                           ext === "aac" ? "audio/aac" : "audio/mpeg";
          
          return {
            toolCallId,
            content: [
              {
                type: "audio",
                url: mediaUrl,
                filename: fileName,
                mimeType: mimeType,
              } as const,
              { type: "text", text: `🎵 [${fileName}](${mediaUrl})` }
            ],
            details: { path: inputPath, size: fileSize },
          } as AgentToolResult;
        }

        if (VIDEO_EXTENSIONS.has(ext)) {
          const mimeType = ext === "mp4" ? "video/mp4" :
                           ext === "webm" ? "video/webm" :
                           ext === "mov" ? "video/quicktime" :
                           ext === "avi" ? "video/x-msvideo" :
                           ext === "mkv" ? "video/x-matroska" : "video/mp4";
          
          return {
            toolCallId,
            content: [
              {
                type: "video",
                url: mediaUrl,
                filename: fileName,
                mimeType: mimeType,
              } as const,
              { type: "text", text: `🎬 [${fileName}](${mediaUrl})` }
            ],
            details: { path: inputPath, size: fileSize },
          } as AgentToolResult;
        }

        if (signal?.aborted) { throw new Error("Read operation aborted"); }
        
        // Handle text files with streaming for host mode, fallback for sandbox mode
        let text: string;
        if (useBridge) {
          // Sandbox bridge doesn't support streaming, but we still optimize by reading once
          text = await readTextFileFromSandbox(
            options.bridge!,
            inputPath,
            rootDirResolved,
            offset,
            limit,
            signal
          );
        } else {
          // Host mode - use streaming for efficient memory usage
          if (offset > 0 || limit !== undefined) {
            text = await readTextFileWithStreaming(inputPath, offset, limit, signal);
          } else {
            // No offset/limit, read entire file (but still check for abort)
            text = await fs.readFile(inputPath, "utf-8");
          }
        }

        // Apply character limit truncation if needed
        const maxChars = options?.modelContextWindowTokens ? options.modelContextWindowTokens * 3 : 32000;
        if (text.length > maxChars) {
          text = text.slice(0, maxChars) + `\n\n... [Content truncated to ${maxChars} chars]`;
        }

        return {
          toolCallId,
          content: [{ type: "text", text }],
          details: { path: inputPath, size: fileSize, offset, limit },
        } as AgentToolResult;

      } catch (error) {
        return {
          toolCallId,
          content: [{ type: "text", text: `Error reading path: ${(error as Error).message}` }],
          details: { path: inputPath },
        } as AgentToolResult;
      }
    },
  };
}