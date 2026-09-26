/** Native metadata is cached only within its physical client lifetime. */
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject } from "./protocol.js";

type CodexClientSessionMetadataState = {
  closed: boolean;
  sessionMetadata: Map<string, { sessionsRoot: string; rolloutPath: string; metadata: JsonObject }>;
};

/** Immutable declarations are data owned by this physical client, never retained executors. */
export async function readCodexClientSessionMetadata(
  runtime: CodexClientSessionMetadataState | undefined,
  client: CodexAppServerClient,
  sessionsRoot: string,
  boundRolloutPath: string | undefined,
  threadId: string,
  maxEntries: number,
): Promise<JsonObject> {
  let rolloutPath = boundRolloutPath;
  if (!runtime || runtime.closed) {
    throw new Error("Codex native metadata requires a live selected client");
  }
  const cached = runtime.sessionMetadata.get(threadId);
  if (
    cached &&
    cached.sessionsRoot === sessionsRoot &&
    (!rolloutPath || cached.rolloutPath === rolloutPath)
  ) {
    return structuredClone(cached.metadata);
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
  if (runtime.closed || !metadata) {
    throw new Error("Codex native metadata is unavailable on the selected client");
  }
  runtime.sessionMetadata.delete(threadId);
  runtime.sessionMetadata.set(threadId, { sessionsRoot, rolloutPath, metadata });
  pruneMapToMaxSize(runtime.sessionMetadata, maxEntries);
  return structuredClone(metadata);
}
