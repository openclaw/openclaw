import { createHash } from "node:crypto";
import path from "node:path";
import {
  collectAgentHarnessMessagingMediaUrls,
  mapAgentHarnessMessagingMediaValues,
} from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import {
  createBoundedRemoteFileReader,
  isPathStrictlyInside,
  root,
  type RemoteWorkspaceFileReader,
} from "openclaw/plugin-sdk/file-access-runtime";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import {
  normalizeMediaReferenceForComparison,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-store";
import type { CodexCommandExecParams, CodexCommandExecResponse } from "./command-exec-protocol.js";
import {
  isCodexPassThroughMediaSource,
  mapCodexAppServerLocalWorkspacePath,
  mapCodexAppServerRemoteWorkspacePath,
} from "./remote-workspace-path.js";
import type { CodexBindingAuthority } from "./session-binding.js";

const REMOTE_WORKSPACE_MEDIA_TIMEOUT_MS = 60_000;
const REMOTE_WORKSPACE_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const REMOTE_WORKSPACE_MEDIA_MAX_ATTACHMENTS = 16;
/** Adapts the current app-server connection without changing its Windows output cap. */
export function createCodexRemoteWorkspaceFileReader(
  client: {
    request: (
      method: "command/exec",
      params: CodexCommandExecParams,
      options: {
        signal?: AbortSignal;
        timeoutMs?: number;
        assertCurrent?: () => void;
        withCurrent?: (write: () => void) => Promise<void>;
      },
    ) => Promise<CodexCommandExecResponse>;
  },
  authority: Pick<CodexBindingAuthority, "assertCurrent" | "withCurrent">,
): RemoteWorkspaceFileReader {
  const read = createBoundedRemoteFileReader({
    outputBytesCap: 1024 * 1024,
    assertCurrent: authority.assertCurrent,
    execute: async (command, options) => {
      const response = await client
        .request(
          "command/exec",
          {
            command,
            // Prevent inherited Node preload hooks from changing the fixed reader.
            env: { NODE_OPTIONS: null, NODE_PATH: null },
            ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          },
          {
            ...options,
            assertCurrent: authority.assertCurrent,
            withCurrent: authority.withCurrent,
          },
        )
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /failed to spawn|executable.*not found|\bENOENT\b/iu.test(error.message)
          ) {
            throw new Error(
              "Codex remote workspace file transfer requires Node.js on the remote app-server host.",
              { cause: error },
            );
          }
          throw error;
        });
      if (!response || response.exitCode !== 0) {
        throw new Error(
          `Codex remote workspace file read failed: ${response?.stderr ?? "no response"}`,
        );
      }
      return response.stdout;
    },
  });
  return async (params) => {
    const bytes = await read(params);
    // A final native response can arrive after the initiating lineage changes.
    return authority.withCurrent(() => {
      params.signal?.throwIfAborted();
      return bytes;
    });
  };
}

/**
 * Prepares message attachments: stages remote bytes, then records the content
 * of attachments in the agent workspace or Gateway media as they are about to
 * be sent. Paths elsewhere are never read here; the message tool's own media
 * policy decides whether they can be sent.
 */
export async function prepareCodexRemoteWorkspaceMessageMedia(
  params: Parameters<typeof stageCodexRemoteWorkspaceMessageMedia>[0],
) {
  const staged = await stageCodexRemoteWorkspaceMessageMedia(params);
  const contentKeysByPath = await readCodexMediaContentKeys(
    collectAgentHarnessMessagingMediaUrls(staged.args),
    params.maxBytes ?? REMOTE_WORKSPACE_MEDIA_MAX_BYTES,
    [params.localWorkspaceRoot, getMediaDir()],
  );
  return { ...staged, contentKeysByPath };
}

/** Stages authoritative bounded remote bytes into immutable Gateway-owned media. */
async function stageCodexRemoteWorkspaceMessageMedia(params: {
  args: Record<string, unknown>;
  localWorkspaceRoot?: string;
  remoteWorkspaceRoot?: string;
  readRemoteFile?: RemoteWorkspaceFileReader;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<{
  args: Record<string, unknown>;
  sourcePathsByStagedPath: ReadonlyMap<string, readonly string[]>;
}> {
  const { localWorkspaceRoot, remoteWorkspaceRoot } = params;
  const sourcePathsByStagedPath = new Map<string, readonly string[]>();
  if (!localWorkspaceRoot || !remoteWorkspaceRoot) {
    return { args: params.args, sourcePathsByStagedPath };
  }

  const remotePathsByLocalPath = new Map<
    string,
    { remotePath: string; sourcePaths: Set<string> }
  >();
  const gatewayManagedPaths = new Set<string>();
  const gatewayMediaRoot = getMediaDir();
  let attachmentEntries = 0;
  const mappedArgs = mapAgentHarnessMessagingMediaValues(params.args, (value) => {
    if (path.isAbsolute(value) && isPathStrictlyInside(gatewayMediaRoot, value)) {
      attachmentEntries += 1;
      gatewayManagedPaths.add(value);
      return value;
    }
    const mapped = mapCodexAppServerLocalWorkspacePath({
      value,
      localWorkspaceRoot,
      remoteWorkspaceRoot,
    });
    if (value.trim() && !isCodexPassThroughMediaSource(value)) {
      attachmentEntries += 1;
      const remotePath = mapCodexAppServerRemoteWorkspacePath({
        value: mapped,
        localWorkspaceRoot,
        remoteWorkspaceRoot,
      });
      const sourcePaths = remotePathsByLocalPath.get(mapped)?.sourcePaths ?? new Set<string>();
      sourcePaths.add(value);
      sourcePaths.add(remotePath);
      remotePathsByLocalPath.set(mapped, { remotePath, sourcePaths });
    }
    return mapped;
  });

  if (attachmentEntries > REMOTE_WORKSPACE_MEDIA_MAX_ATTACHMENTS) {
    throw new Error(
      `Codex remote workspace upload exceeds the ${REMOTE_WORKSPACE_MEDIA_MAX_ATTACHMENTS}-attachment limit.`,
    );
  }
  for (const managedPath of gatewayManagedPaths) {
    await assertGatewayManagedMediaPath(managedPath, gatewayMediaRoot);
  }
  if (remotePathsByLocalPath.size === 0) {
    return { args: mappedArgs, sourcePathsByStagedPath };
  }
  const readRemoteFile = params.readRemoteFile;
  if (!readRemoteFile) {
    throw new Error("Codex remote workspace file transfer requires an active app-server client.");
  }

  const maxBytes = params.maxBytes ?? REMOTE_WORKSPACE_MEDIA_MAX_BYTES;
  const timeoutMs = params.timeoutMs ?? REMOTE_WORKSPACE_MEDIA_TIMEOUT_MS;
  const deadline = performance.now() + timeoutMs;
  const stagedPaths = new Map<string, string>();
  let totalBytes = 0;
  // Read the authoritative remote descriptor, not an unverified synchronized
  // path. The native command caps allocation and output before bytes travel.
  for (const [localPath, { remotePath, sourcePaths }] of remotePathsByLocalPath) {
    params.signal?.throwIfAborted();
    const remainingBytes = maxBytes - totalBytes;
    const remainingMs = Math.floor(deadline - performance.now());
    if (remainingMs <= 0) {
      throw new Error("Codex remote workspace attachment batch timed out.");
    }
    const remoteBuffer = await readRemoteFile({
      path: remotePath,
      maxBytes: remainingBytes,
      workspaceRoot: remoteWorkspaceRoot,
      signal: params.signal,
      timeoutMs: remainingMs,
    });
    totalBytes += remoteBuffer.byteLength;
    const saved = await saveMediaBuffer(
      remoteBuffer,
      undefined,
      "outbound",
      maxBytes,
      path.basename(remotePath),
    );
    stagedPaths.set(localPath, saved.path);
    sourcePathsByStagedPath.set(normalizeMediaReferenceForComparison(saved.path), [...sourcePaths]);
  }
  return {
    args: mapAgentHarnessMessagingMediaValues(
      mappedArgs,
      (value) => stagedPaths.get(value) ?? value,
    ),
    sourcePathsByStagedPath,
  };
}

/** Every reference a confirmed send may match: its path, staged sources and content. */
export function resolveCodexMediaSourceUrls(
  mediaUrls: readonly string[],
  prepared:
    | {
        sourcePathsByStagedPath: ReadonlyMap<string, readonly string[]>;
        contentKeysByPath: ReadonlyMap<string, string>;
      }
    | undefined,
): string[] {
  return [
    ...new Set(
      mediaUrls.flatMap((url) => {
        const key = normalizeMediaReferenceForComparison(url);
        const contentKey = prepared?.contentKeysByPath.get(key);
        return [
          url,
          ...(prepared?.sourcePathsByStagedPath.get(key) ?? []),
          ...(contentKey ? [contentKey] : []),
        ];
      }),
    ),
  ];
}

/** Content identity, so a confirmed send of a copy still matches the image it copied. */
export function codexMediaContentKey(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Keys files under one of `roots`, opened without following symlinks.
 * Delivery evidence keeps these keys, so later edits to the same path cannot
 * change what a confirmed send is taken to have delivered. Other, unreadable
 * or oversized files keep path-only matching.
 */
export async function readCodexMediaContentKeys(
  mediaUrls: readonly string[],
  maxBytes: number,
  roots: readonly (string | undefined)[],
): Promise<Map<string, string>> {
  const contentKeys = new Map<string, string>();
  for (const url of mediaUrls) {
    const file = normalizeMediaReferenceForComparison(url);
    const rootDir = roots.find((dir) => dir && isPathStrictlyInside(dir, file));
    if (!rootDir || contentKeys.has(file)) {
      continue;
    }
    try {
      const media = await root(rootDir, { symlinks: "reject" });
      const opened = await media.open(path.relative(rootDir, file), { symlinks: "reject" });
      try {
        const stat = await opened.handle.stat();
        if (stat.isFile() && stat.size <= maxBytes) {
          contentKeys.set(file, codexMediaContentKey(await opened.handle.readFile()));
        }
      } finally {
        await opened[Symbol.asyncDispose]();
      }
    } catch {
      // The send itself reports unreadable attachments.
    }
  }
  return contentKeys;
}

async function assertGatewayManagedMediaPath(value: string, mediaRoot: string): Promise<void> {
  const media = await root(mediaRoot, { symlinks: "reject" });
  const opened = await media.open(path.relative(mediaRoot, value), { symlinks: "reject" });
  try {
    if (!(await opened.handle.stat()).isFile()) {
      throw new Error(`Codex Gateway-managed media is not a regular file: ${value}`);
    }
  } finally {
    await opened[Symbol.asyncDispose]();
  }
}
