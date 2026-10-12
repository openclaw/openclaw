import { createHash } from "node:crypto";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import type { CodexAppServerClient } from "./client.js";
import type { JsonObject } from "./protocol.js";

export type CodexClientWorkspaceState = {
  closed: boolean;
  sessionMetadata: Map<string, { sessionsRoot: string; rolloutPath: string; metadata: JsonObject }>;
  workspaceReferences: Map<string, { digest?: string; needsReintroduction: boolean }>;
};

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
  if (state.closed || !metadata) {
    throw new Error("Codex native metadata is unavailable on the selected client");
  }
  state.sessionMetadata.delete(threadId);
  state.sessionMetadata.set(threadId, { sessionsRoot, rolloutPath, metadata });
  pruneMapToMaxSize(state.sessionMetadata, maxCachedSessions);
  return structuredClone(metadata);
}
