import { createHash } from "node:crypto";
import path from "node:path";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { root as openSafeFilesystemRoot } from "openclaw/plugin-sdk/file-access-runtime";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

/** Codex's model-visible AGENTS.md section; null text means Codex shows none. */
export type CodexAgentsMdSnapshot = { directory: string | null; text: string | null };

/** Model context Codex recorded in its own rollout, which app-server requests do not expose. */
export type CodexNativeModelContext = {
  baseInstructions?: string;
  /** The base text comes from current configuration, not what the loaded thread used. */
  baseInstructionsEstimated?: true;
  /** Absent until Codex has persisted a world-state baseline for the current window. */
  agentsMd?: CodexAgentsMdSnapshot;
};

type CodexModelContextScan = {
  sessionsRoot: string;
  rolloutPath: string;
  /** Byte offset after the last complete rollout line already applied. */
  offset: number;
  baseline: boolean;
  agentsMd?: CodexAgentsMdSnapshot;
};

export type CodexClientWorkspaceState = {
  closed: boolean;
  sessionMetadata: Map<string, { sessionsRoot: string; rolloutPath: string; metadata: JsonObject }>;
  modelContextScans: Map<string, CodexModelContextScan>;
  workspaceReferences: Map<string, { digest?: string; needsReintroduction: boolean }>;
};

const MODEL_CONTEXT_READ_CHUNK_BYTES = 1024 * 1024;

export function prepareCodexWorkspaceReferenceState(
  state: CodexClientWorkspaceState | undefined,
  threadId: string,
  reference: string | undefined,
) {
  const digest = createHash("sha256")
    .update(reference ?? "")
    .digest("hex");
  const previous = state?.workspaceReferences.get(threadId) ?? { needsReintroduction: true };
  if (state && !state.closed) {
    state.workspaceReferences.set(threadId, previous);
  }
  return {
    include: previous.needsReintroduction || previous.digest !== digest,
    accepted: () => {
      if (!state || state.closed || state.workspaceReferences.get(threadId) !== previous) {
        return;
      }
      state.workspaceReferences.set(threadId, { digest, needsReintroduction: false });
    },
  };
}

export async function readCodexWorkspaceSessionMeta(
  client: CodexAppServerClient,
  state: CodexClientWorkspaceState | undefined,
  sessionsRoot: string,
  boundRolloutPath: string | undefined,
  threadId: string,
  maxCachedSessions: number,
): Promise<JsonObject> {
  let rolloutPath = boundRolloutPath;
  if (!state || state.closed) {
    throw new Error("Codex native metadata requires a live selected client");
  }
  const cached = state.sessionMetadata.get(threadId);
  if (
    cached &&
    cached.sessionsRoot === sessionsRoot &&
    (!rolloutPath || cached.rolloutPath === rolloutPath)
  ) {
    return cached.metadata;
  }
  if (!rolloutPath) {
    // The original imported-target materializer may bind before native storage
    // assigns its path. Discover it once from the selected thread, not from disk scans.
    const { thread } = await client.request("thread/read", { threadId, includeTurns: false });
    if (thread.id !== threadId || !thread.path) {
      throw new Error("Codex native metadata has no verified thread path");
    }
    rolloutPath = thread.path;
  }
  const metadata = await readCodexSessionMeta(sessionsRoot, rolloutPath, threadId);
  if (state.closed || !metadata) {
    throw new Error("Codex native metadata is unavailable on the selected client");
  }
  state.sessionMetadata.delete(threadId);
  state.sessionMetadata.set(threadId, { sessionsRoot, rolloutPath, metadata });
  pruneMapToMaxSize(state.sessionMetadata, maxCachedSessions);
  return metadata;
}

function readAgentsMdSnapshot(value: JsonValue | undefined): CodexAgentsMdSnapshot | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  return {
    directory: typeof value.directory === "string" ? value.directory : null,
    text: typeof value.text === "string" ? value.text : null,
  };
}

/**
 * Follows Codex's rollout reconstruction (codex-rs/core/src/session/rollout_reconstruction.rs):
 * a compaction drops the baseline, full world-state items replace it, and patches are
 * JSON merge patches over the current baseline. A thread rollback makes Codex replay
 * without the dropped turns' patches; rather than mirror that turn-segment replay, the
 * scan drops its baseline, so AGENTS.md reads as unverified until the next full snapshot.
 */
function applyModelContextRolloutLine(scan: CodexModelContextScan, line: string): void {
  if (!/"type":"(?:world_state|compacted|thread_rolled_back)"/u.test(line)) {
    return;
  }
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (!isJsonObject(record)) {
    return;
  }
  if (
    record.type === "compacted" ||
    (record.type === "event_msg" &&
      isJsonObject(record.payload) &&
      record.payload.type === "thread_rolled_back")
  ) {
    scan.baseline = false;
    scan.agentsMd = undefined;
    return;
  }
  const payload = record.payload;
  if (record.type !== "world_state" || !isJsonObject(payload) || !isJsonObject(payload.state)) {
    return;
  }
  if (payload.full === true) {
    scan.baseline = true;
    scan.agentsMd = readAgentsMdSnapshot(payload.state.agents_md);
    return;
  }
  if (!scan.baseline || !("agents_md" in payload.state)) {
    return;
  }
  const patch = payload.state.agents_md;
  scan.agentsMd = isJsonObject(patch)
    ? readAgentsMdSnapshot({
        directory: scan.agentsMd?.directory ?? null,
        text: scan.agentsMd?.text ?? null,
        ...patch,
      })
    : undefined;
}

/** Applies rollout lines appended since the previous scan; a shrunken file restarts the scan. */
async function scanCodexModelContextRollout(
  scan: CodexModelContextScan,
  signal: AbortSignal | undefined,
): Promise<void> {
  const safeRoot = await openSafeFilesystemRoot(scan.sessionsRoot, {
    hardlinks: "reject",
    maxBytes: Number.MAX_SAFE_INTEGER,
    symlinks: "reject",
  });
  const opened = await safeRoot.open(path.relative(scan.sessionsRoot, scan.rolloutPath));
  try {
    const size = opened.stat.size;
    if (size < scan.offset) {
      scan.offset = 0;
      scan.baseline = false;
      scan.agentsMd = undefined;
    }
    let carry = Buffer.alloc(0);
    let position = scan.offset;
    while (position < size) {
      // Each completed chunk is kept, so an abandoned first scan resumes on the next turn.
      signal?.throwIfAborted();
      const chunk = Buffer.alloc(Math.min(MODEL_CONTEXT_READ_CHUNK_BYTES, size - position));
      const { bytesRead } = await opened.handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      const bytes = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      let start = 0;
      for (let end; (end = bytes.indexOf(0x0a, start)) !== -1; start = end + 1) {
        applyModelContextRolloutLine(scan, bytes.toString("utf8", start, end));
        scan.offset += end + 1 - start;
      }
      // Codex may still be appending the final line; it is applied on a later scan.
      carry = bytes.subarray(start);
    }
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

/** Reads what Codex itself recorded as the thread's base instructions and AGENTS.md context. */
export async function readCodexWorkspaceModelContext(
  client: CodexAppServerClient,
  state: CodexClientWorkspaceState | undefined,
  sessionsRoot: string,
  boundRolloutPath: string | undefined,
  threadId: string,
  maxCachedSessions: number,
  signal?: AbortSignal,
): Promise<CodexNativeModelContext> {
  const metadata = await readCodexWorkspaceSessionMeta(
    client,
    state,
    sessionsRoot,
    boundRolloutPath,
    threadId,
    maxCachedSessions,
  );
  const rolloutPath = state?.sessionMetadata.get(threadId)?.rolloutPath;
  if (!state || state.closed || !rolloutPath) {
    throw new Error("Codex native model context is unavailable on the selected client");
  }
  const previous = state.modelContextScans.get(threadId);
  // Scan a copy so overlapping readers never advance one offset twice.
  const scan: CodexModelContextScan =
    previous?.sessionsRoot === sessionsRoot && previous.rolloutPath === rolloutPath
      ? { ...previous }
      : { sessionsRoot, rolloutPath, offset: 0, baseline: false };
  try {
    await scanCodexModelContextRollout(scan, signal);
  } finally {
    // The offset only covers applied lines, so partial progress is always consistent.
    if (!state.closed && state.modelContextScans.get(threadId) === previous) {
      state.modelContextScans.delete(threadId);
      state.modelContextScans.set(threadId, scan);
      pruneMapToMaxSize(state.modelContextScans, maxCachedSessions);
    }
  }
  const baseInstructions = isJsonObject(metadata.base_instructions)
    ? metadata.base_instructions.text
    : undefined;
  return {
    ...(typeof baseInstructions === "string" ? { baseInstructions } : {}),
    ...(scan.agentsMd ? { agentsMd: { ...scan.agentsMd } } : {}),
  };
}
