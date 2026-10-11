import { getRuntimeConfig } from "../../../config/config.js";
import { applySessionEntryExactReplacements } from "../../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import { captureSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current-runtime.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { listAgentRunsForSession } from "../../../infra/agent-run-registry.js";
import {
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
} from "../../../sessions/session-lifecycle-admission.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import {
  isRetiredSubagentExecution,
  isRetiredSubagentSessionOwner,
} from "./subagent-registry-restart-recovery-helpers.js";
import type { RestartRecoveryResult } from "./subagent-registry-restart-recovery-types.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

// Capture only identity, never the session's saved prompts or the recovery stack.
function retainSessionOwner(storePath: string, sessionKey: string, sessionId: string | undefined) {
  const isCurrent = () =>
    listAgentRunsForSession({ sessionKey, sessionId }).length > 0 ||
    isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId]);
  return isCurrent()
    ? {
        isCurrent,
        released: getSessionWorkAdmissionRelease({
          scope: storePath,
          identities: [sessionKey, sessionId],
        }),
      }
    : undefined;
}

export async function loadSubagentRecoverySession(params: {
  entry: SubagentRunRecord;
  isOwnerCurrent: () => boolean;
}): Promise<{
  agentId: string;
  storePath: string;
  sessionEntry: InternalSessionEntry | undefined;
  currentRead: ReturnType<typeof captureSessionEntryCurrentRead>;
  retained?: Extract<RestartRecoveryResult, { status: "handled" }>["retained"];
} | null> {
  const sessionKey = params.entry.childSessionKey.trim();
  if (resolveSubagentChildAuthority(params.entry).status === "mismatch") {
    return null;
  }
  const { agentId, storePath } = resolveSubagentChildSessionOwner(params.entry, getRuntimeConfig());
  const scope = { agentId, storePath, sessionKey, projection: "list" as const };
  const { sessionEntry, currentRead } = await withSessionEntryReadOnlyInWorker(
    scope,
    () => {
      if (!params.isOwnerCurrent()) {
        throw new Error("subagent recovery owner changed during session read");
      }
    },
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      return {
        sessionEntry: read.value,
        currentRead: captureSessionEntryCurrentRead(scope, owner),
      };
    },
  );
  const authority = resolveSubagentChildAuthority(params.entry, sessionEntry);
  if (authority.status === "mismatch") {
    throw new Error(authority.error);
  }
  const retained = retainSessionOwner(storePath, sessionKey, sessionEntry?.sessionId);
  if (
    authority.status === "legacy-unverified" ||
    retained ||
    params.entry.execution.restartRecovery ||
    sessionEntry?.abortedLastRun === true ||
    !isRetiredSubagentSessionOwner(params.entry, sessionEntry)
  ) {
    return { agentId, storePath, sessionEntry, currentRead, retained };
  }
  const { sessionId, lifecycleRevision, updatedAt } = sessionEntry;
  const target = { sessionKey, sessionId };
  const isCurrent = () =>
    params.isOwnerCurrent() &&
    isRetiredSubagentExecution(params.entry) &&
    listAgentRunsForSession(target).length === 0 &&
    !isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId]);
  const interrupted = await applySessionEntryExactReplacements<InternalSessionEntry | null>({
    agentId,
    storePath,
    sessionKeys: [sessionKey],
    update: (entries) => {
      const current = entries[0]?.entry;
      if (
        !isCurrent() ||
        !current ||
        current.sessionId !== sessionId ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.updatedAt !== updatedAt ||
        !isRetiredSubagentSessionOwner(params.entry, current)
      ) {
        return { result: null };
      }
      // Keep the last observed timestamp: restart must not make an old orphan fresh.
      const interruptedEntry = { ...current, abortedLastRun: true };
      return { result: interruptedEntry, replacements: [{ sessionKey, entry: interruptedEntry }] };
    },
    assertCommitAllowed: () => {
      currentRead.assertSourceCurrent();
      if (!isCurrent()) {
        throw new Error("subagent orphan ownership changed before interruption commit");
      }
    },
    skipMaintenance: true,
  });
  return interrupted ? { agentId, storePath, sessionEntry: interrupted, currentRead } : null;
}
