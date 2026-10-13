import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { withSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { normalizeOptionalAgentId } from "../../routing/session-key.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { acpSessionRowMatchesEntry } from "./session-meta-keys.js";
import { captureAcpSessionReadContext } from "./session-meta-read-context.js";
import type { AcpSessionReadContextInput } from "./session-meta-read.types.js";

/** Resolve only indexed resume candidates; canonical entries still own requester authorization. */
export async function readAcpResumeSessionOwner(
  params: AcpSessionReadContextInput & {
    agentId: string;
    backendId?: string;
    resumeSessionId: string;
    runtimeAgentId: string;
    onCandidate?: (sessionKey: string) => void;
  },
) {
  const { agentId, backendId, resumeSessionId } = params;
  const runtimeAgentId = normalizeOptionalAgentId(params.runtimeAgentId);
  const { cfg, env, databasePath, assertCurrent } = await captureAcpSessionReadContext(params);
  if (!runtimeAgentId) {
    return undefined;
  }
  const lookup = async (sessionKey?: string) => {
    const result = await executeExistingOpenClawStateRead(
      { env, path: databasePath },
      { type: "acpSessions.resume", agentId, backendId, resumeSessionId, sessionKey },
      { current: true },
    );
    assertCurrent();
    if (!result) {
      return [];
    }
    if (!result.ok || result.type !== "acpSessions.resume") {
      throw new Error("Unexpected ACP resume lookup result");
    }
    return result.rows;
  };
  const rows = await lookup();
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId,
    env,
  });
  for (const row of rows) {
    if (normalizeOptionalAgentId(row.agent) !== runtimeAgentId) {
      continue;
    }
    params.onCandidate?.(row.sessionKey);
    const owner = await withSessionEntryReadOnlyInWorker(
      { agentId, storePath, sessionKey: row.sessionKey, env, clone: false },
      assertCurrent,
      async (read) => {
        if (!read.ok) {
          throw read.error;
        }
        if (!read.value || !acpSessionRowMatchesEntry(row, read.value)) {
          return undefined;
        }
        // Recheck ID, lifecycle, and indexed runtime identity before consuming ownership.
        const [current] = await lookup(row.sessionKey);
        return current &&
          acpSessionRowMatchesEntry(current, read.value) &&
          normalizeOptionalAgentId(current.agent) === runtimeAgentId
          ? { sessionKey: row.sessionKey, entry: read.value }
          : undefined;
      },
    );
    if (owner) {
      return owner;
    }
  }
  return undefined;
}
