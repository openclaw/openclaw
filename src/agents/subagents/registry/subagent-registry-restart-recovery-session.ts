import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import { listAgentRunsForSession } from "../../../infra/agent-run-registry.js";
import {
  getSessionWorkAdmissionRelease,
  isSessionWorkAdmissionActive,
} from "../../../sessions/session-lifecycle-admission.js";
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
  retained?: Extract<RestartRecoveryResult, { status: "handled" }>["retained"];
} | null> {
  const sessionKey = params.entry.childSessionKey.trim();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId });
  const sessionEntry = await withSessionEntryReadOnlyInWorker(
    { storePath, sessionKey, projection: "list" },
    () => {
      if (!params.isOwnerCurrent()) {
        throw new Error("subagent recovery owner changed during session read");
      }
    },
    async (read) => {
      if (!read.ok) {
        throw read.error;
      }
      return read.value;
    },
  );
  const retained = retainSessionOwner(storePath, sessionKey, sessionEntry?.sessionId);
  if (
    retained ||
    params.entry.execution.restartRecovery ||
    sessionEntry?.abortedLastRun === true ||
    !isRetiredSubagentSessionOwner(params.entry, sessionEntry)
  ) {
    return { agentId, storePath, sessionEntry, retained };
  }
  const { sessionId, lifecycleRevision, updatedAt } = sessionEntry;
  const target = { sessionKey, sessionId };
  const isCurrent = () =>
    params.isOwnerCurrent() &&
    isRetiredSubagentExecution(params.entry) &&
    listAgentRunsForSession(target).length === 0 &&
    !isSessionWorkAdmissionActive(storePath, [sessionKey, sessionId]);
  const interrupted = await patchSessionEntryCore(
    { storePath, sessionKey },
    (current) => {
      if (
        !isCurrent() ||
        current.sessionId !== sessionId ||
        current.lifecycleRevision !== lifecycleRevision ||
        current.updatedAt !== updatedAt ||
        !isRetiredSubagentSessionOwner(params.entry, current)
      ) {
        return null;
      }
      // Keep the last observed timestamp: restart must not make an old orphan fresh.
      return { ...current, abortedLastRun: true };
    },
    {
      assertCommitAllowed: () => {
        if (!isCurrent()) {
          throw new Error("subagent orphan ownership changed before interruption commit");
        }
      },
      replaceEntry: true,
      skipMaintenance: true,
    },
  );
  return interrupted ? { agentId, storePath, sessionEntry: interrupted } : null;
}
