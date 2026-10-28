import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectAgentHarnessMessagingMediaUrls } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { normalizeMediaReferenceForComparison } from "openclaw/plugin-sdk/media-store";
import {
  prepareCodexRemoteWorkspaceMessageMedia,
  resolveCodexMediaSourceUrls,
} from "./remote-workspace-media.js";

export type MediaDigest = { bytes: number; sha256: string };
type PreparedMessageMedia = {
  sourcePathsByStagedPath?: ReadonlyMap<string, readonly string[]>;
  digestsBySource?: ReadonlyMap<string, MediaDigest>;
};

export function digestMedia(buffer: Buffer): MediaDigest {
  return { bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

function localMediaPath(value: string): string | undefined {
  if (value.startsWith("file:")) {
    try {
      return fileURLToPath(value);
    } catch {
      return undefined;
    }
  }
  return path.isAbsolute(value) ? value : undefined;
}

/**
 * Hashes the local files a message() call is about to send, before delivery reads
 * them. Only regular files within the generated-image size cap can match a
 * generated image, so larger files, links and non-local references are skipped.
 */
export async function digestLocalMessageMedia(
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, MediaDigest>> {
  const maxBytes = resolveGeneratedMediaMaxBytes(undefined, "image");
  const digests = new Map<string, MediaDigest>();
  for (const value of collectAgentHarnessMessagingMediaUrls(args)) {
    const filePath = localMediaPath(value);
    const key = normalizeMediaReferenceForComparison(value);
    if (!filePath || digests.has(key)) {
      continue;
    }
    signal?.throwIfAborted();
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isFile() && stat.size <= maxBytes) {
        digests.set(key, digestMedia(await fs.readFile(filePath, { signal })));
      }
    } catch {
      // Delivery reports its own read failures; identity stays path-only.
    }
  }
  return digests;
}

/** Prepares message() media and, for local workspaces, records what each source contains. */
export async function prepareCodexMessageMedia(
  params: Parameters<typeof prepareCodexRemoteWorkspaceMessageMedia>[0],
) {
  const prepared = await prepareCodexRemoteWorkspaceMessageMedia(params);
  // Remote sources are staged copies; generated-image matching stays path-only there.
  return params.remoteWorkspaceRoot
    ? prepared
    : { ...prepared, digestsBySource: await digestLocalMessageMedia(prepared.args, params.signal) };
}

/** Immutable content identity, carried in each confirmed delivery's own source URLs. */
export function mediaDigestAlias(digest: MediaDigest): string {
  return `codex-media-sha256:${digest.bytes}:${digest.sha256}`;
}

/**
 * Maps confirmed message() media to its source URLs plus the content alias of the
 * bytes hashed when that send was prepared, so each receipt keeps its own identity.
 */
export function resolveConfirmedCodexMessageMedia(
  mediaUrls: readonly string[],
  prepared: PreparedMessageMedia | undefined,
): string[] {
  const sourceUrls = resolveCodexMediaSourceUrls(mediaUrls, prepared?.sourcePathsByStagedPath);
  const aliases = sourceUrls.flatMap((sourceUrl) => {
    const digest = prepared?.digestsBySource?.get(normalizeMediaReferenceForComparison(sourceUrl));
    return digest ? [mediaDigestAlias(digest)] : [];
  });
  return [...new Set([...sourceUrls, ...aliases])];
}
