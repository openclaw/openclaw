import { detectMime } from "@openclaw/media-core/mime";
import { decodeWindowsTextFileBuffer } from "../infra/windows-encoding.js";
import {
  classifyMediaReferenceSource,
  normalizeMediaReferenceSource,
  resolveMediaReferenceSandboxPath,
} from "../media/media-reference.js";
import {
  type MemoryWriteProvenanceObserver,
  withMemoryWriteProvenance,
} from "./memory-write-provenance.js";
import { resolveContainerPathCandidate } from "./path-policy.js";
import { resolveSandboxFileMutationQueueKey } from "./sandbox/file-mutation-identity.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

type SandboxFileOperationsParams = {
  abortSignal?: AbortSignal;
  root: string;
  bridge: SandboxFsBridge;
  memoryWriteProvenance?: MemoryWriteProvenanceObserver;
};

export function createSandboxReadOperations(params: SandboxFileOperationsParams) {
  return {
    resolveQueueKey: (absolutePath: string, signal?: AbortSignal) =>
      resolveSandboxFileQueueKey(params, absolutePath, signal),
    resolvePath: (filePath: string) => {
      const normalizedMediaSource = normalizeMediaReferenceSource(filePath);
      if (classifyMediaReferenceSource(normalizedMediaSource).isMediaStoreUrl) {
        return resolveMediaReferenceSandboxPath(normalizedMediaSource, "media/inbound").resolved;
      }
      return resolveContainerPathCandidate(filePath);
    },
    decodeText: ({ buffer, absolutePath }: { buffer: Buffer; absolutePath: string }) =>
      params.bridge.resolvePath({ filePath: absolutePath, cwd: params.root }).hostPath
        ? decodeWindowsTextFileBuffer({ buffer })
        : decodeWindowsTextFileBuffer({ buffer, platform: "linux" }),
    readFile: (absolutePath: string, signal?: AbortSignal) =>
      params.bridge.readFile({
        filePath: absolutePath,
        cwd: params.root,
        signal: signal ?? params.abortSignal,
      }),
    access: (absolutePath: string, signal?: AbortSignal) =>
      assertSandboxFileExists(params, absolutePath, signal),
    detectImageMimeType: async (absolutePath: string, buffer: Buffer) => {
      const mime = await detectMime({ buffer, filePath: absolutePath });
      return mime?.startsWith("image/") ? mime : undefined;
    },
  } as const;
}

export function createSandboxMutationOperations(params: SandboxFileOperationsParams) {
  return withMemoryWriteProvenance(
    {
      resolveQueueKey: (absolutePath: string, signal?: AbortSignal) =>
        resolveSandboxFileQueueKey(params, absolutePath, signal),
      writeFile: async (absolutePath: string, content: string, signal?: AbortSignal) => {
        await params.bridge.writeFile({
          filePath: absolutePath,
          cwd: params.root,
          data: content,
          mkdir: true,
          signal: signal ?? params.abortSignal,
        });
      },
      readFile: (absolutePath: string, signal?: AbortSignal) =>
        params.bridge.readFile({
          filePath: absolutePath,
          cwd: params.root,
          signal: signal ?? params.abortSignal,
        }),
      statFile: (absolutePath: string, signal?: AbortSignal) =>
        params.bridge.stat({
          filePath: absolutePath,
          cwd: params.root,
          signal: signal ?? params.abortSignal,
        }),
      access: (absolutePath: string, signal?: AbortSignal) =>
        assertSandboxFileExists(params, absolutePath, signal),
    } as const,
    params.memoryWriteProvenance,
  );
}

async function resolveSandboxFileQueueKey(
  params: SandboxFileOperationsParams,
  absolutePath: string,
  signal?: AbortSignal,
) {
  return await resolveSandboxFileMutationQueueKey({
    bridge: params.bridge,
    root: params.root,
    filePath: absolutePath,
    cwd: params.root,
    signal,
  });
}

async function assertSandboxFileExists(
  params: SandboxFileOperationsParams,
  absolutePath: string,
  signal?: AbortSignal,
) {
  const stat = await params.bridge.stat({
    filePath: absolutePath,
    cwd: params.root,
    signal: signal ?? params.abortSignal,
  });
  if (!stat) {
    throw createFsAccessError("ENOENT", absolutePath);
  }
  if (stat.type === "directory") {
    throw createFsAccessError("EISDIR", absolutePath);
  }
}

export function createFsAccessError(code: string, filePath: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`Sandbox FS error (${code}): ${filePath}`);
  error.code = code;
  return error;
}
