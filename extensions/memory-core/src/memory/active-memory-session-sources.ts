import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  loadArchivedSessionsAsync,
  loadMemorySessionMetadataBatchAsync,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-paths";
import { extractTranscriptIdentityFromSessionsMemoryHit } from "openclaw/plugin-sdk/session-transcript-hit";
import { isActiveMemoryRecallSession } from "../active-memory-recall-session.js";
import type { MemorySourceFileStateRow } from "./manager-source-state.js";

/** Classify indexed identities, without rendering transcripts or querying an embedding provider. */
export async function resolveActiveMemoryRecallSources(params: {
  rows: readonly MemorySourceFileStateRow[];
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<MemorySourceFileStateRow[]> {
  const excluded = new Set<string>();
  const scopes = new Map<
    string,
    { live: Map<string, string[]>; archives: Map<string, string[]> }
  >();
  for (const row of params.rows) {
    const normalized = row.path.replace(/\\/g, "/");
    // Older SQLite indexes used sessions/<agent>/<id> before adopting .jsonl references.
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(
      /^sessions\/[^/]+\/[^/.]+$/.test(normalized) ? `${normalized}.jsonl` : normalized,
    );
    if (!identity) {
      continue;
    }
    if (isActiveMemoryRecallSession({ sessionId: identity.stem })) {
      excluded.add(row.path);
      continue;
    }
    const agentId = identity.ownerAgentId ?? params.agentId;
    const scope = scopes.get(agentId) ?? { live: new Map(), archives: new Map() };
    scopes.set(agentId, scope);
    const identities = identity.archived ? scope.archives : scope.live;
    const key = identity.archived ? path.posix.basename(normalized) : identity.stem;
    const paths = identities.get(key) ?? [];
    paths.push(row.path);
    identities.set(key, paths);
  }
  for (const [agentId, scope] of scopes) {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    // Missing historical metadata is allowed. Read failures deliberately propagate:
    // an unavailable identity owner cannot establish that a source is eligible.
    const [sessions, archives] = await Promise.all([
      scope.live.size
        ? loadMemorySessionMetadataBatchAsync({
            agentId,
            storePath,
            sessions: [...scope.live.keys()].map((sessionId) => ({ sessionId })),
          })
        : [],
      scope.archives.size
        ? loadArchivedSessionsAsync({
            agentId,
            storePath,
            archiveNames: [...scope.archives.keys()],
          })
        : [],
    ]);
    for (const session of sessions) {
      if (isActiveMemoryRecallSession(session)) {
        for (const pathname of scope.live.get(session.sessionId) ?? []) {
          excluded.add(pathname);
        }
      }
    }
    // Archive names identify generations. The same UUID can later belong to a
    // different live transcript, so archive ownership never classifies a live-shaped hit.
    for (const archive of archives) {
      if (isActiveMemoryRecallSession(archive)) {
        for (const pathname of scope.archives.get(archive.archiveName) ?? []) {
          excluded.add(pathname);
        }
      }
    }
  }
  return params.rows.filter((row) => excluded.has(row.path));
}
