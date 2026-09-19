import { getRuntimeConfig } from "../../../config/config.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../../config/sessions.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../../config/sessions/types.js";
import type { GatewayRecoveryRuntime } from "../../../gateway/server-instance-runtime.types.js";
import { listAgentRunsForSession } from "../../../infra/agent-run-registry.js";
import { isSessionWorkAdmissionActive } from "../../../sessions/session-lifecycle-admission.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../../../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../../../utils/message-channel-core.js";
import {
  isRetiredSubagentExecution,
  isRetiredSubagentSessionOwner,
} from "./subagent-registry-restart-recovery-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const RECOVERY_RESUMED_NOTICE = "Resumed your interrupted task after the Gateway restart.";

export function shouldConfirmAcceptedRecoveryResumption(owner: SubagentRunRecord): boolean {
  const origin = owner.requesterOrigin;
  const channel = normalizeMessageChannel(origin?.channel);
  // Native sessions observe recovery through session events; they have no outbound transport.
  return (
    owner.expectsCompletionMessage !== false &&
    Boolean(
      channel &&
      channel !== INTERNAL_MESSAGE_CHANNEL &&
      !isInternalNonDeliveryChannel(channel) &&
      origin?.to,
    )
  );
}

export async function loadSubagentRecoverySession(params: {
  entry: SubagentRunRecord;
  isOwnerCurrent: () => boolean;
}): Promise<{
  agentId: string;
  storePath: string;
  sessionEntry: InternalSessionEntry | undefined;
} | null> {
  const sessionKey = params.entry.childSessionKey.trim();
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId });
  const sessionEntry = loadSessionEntry({ storePath, sessionKey, clone: false });
  if (
    params.entry.execution.restartRecovery ||
    sessionEntry?.abortedLastRun === true ||
    !isRetiredSubagentSessionOwner(params.entry, sessionEntry)
  ) {
    return { agentId, storePath, sessionEntry };
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

export async function confirmAcceptedRecoveryResumption(params: {
  childSessionKey: string;
  gatewayRuntime: GatewayRecoveryRuntime | undefined;
  idempotencyKey: string;
  isOwnerCurrent: () => boolean;
  owner: SubagentRunRecord;
  warn: (message: string, meta: Record<string, unknown>) => void;
}): Promise<boolean> {
  const origin = params.owner.requesterOrigin;
  if (!shouldConfirmAcceptedRecoveryResumption(params.owner) || !origin?.channel || !origin.to) {
    return true;
  }
  if (!params.gatewayRuntime) {
    return false;
  }
  try {
    const result = await params.gatewayRuntime.sendRecoveryNotice({
      channel: origin.channel,
      to: origin.to,
      accountId: origin.accountId,
      threadId: origin.threadId,
      text: RECOVERY_RESUMED_NOTICE,
      idempotencyKey: `main-session-restart-recovery:subagent:${params.idempotencyKey}:resumed-notice`,
      isCurrent: params.isOwnerCurrent,
    });
    return !result.suppressed;
  } catch (error) {
    params.warn("accepted subagent restart recovery could not confirm resumption", {
      runId: params.owner.runId,
      childSessionKey: params.childSessionKey,
      error,
    });
    return false;
  }
}

export async function settleAcceptedRecoverySession(params: {
  attempts: number;
  childSessionKey: string;
  isOwnerCurrent: () => boolean;
  sessionId: string;
  sessionLifecycleRevision?: string;
  sessionLifecycleRunId?: string;
  now: number;
  runId: string;
  storePath: string;
}): Promise<boolean> {
  let settled = false;
  await patchSessionEntryCore(
    { storePath: params.storePath, sessionKey: params.childSessionKey },
    (current) => {
      if (
        !params.isOwnerCurrent() ||
        current.sessionId !== params.sessionId ||
        (params.sessionLifecycleRevision !== undefined &&
          current.lifecycleRevision !== params.sessionLifecycleRevision) ||
        (params.sessionLifecycleRunId !== undefined &&
          current.lifecycleRunId !== params.sessionLifecycleRunId)
      ) {
        return current;
      }
      if (current.abortedLastRun !== true) {
        settled = true;
        return current;
      }
      current.abortedLastRun = false;
      current.subagentRecovery = {
        automaticAttempts: Math.max(
          current.subagentRecovery?.automaticAttempts ?? 0,
          params.attempts + 1,
        ),
        lastAttemptAt: params.now,
        lastRunId: params.runId,
        sessionLifecycleRunId: params.sessionLifecycleRunId,
      };
      current.updatedAt = params.now;
      settled = true;
      return current;
    },
    {
      assertCommitAllowed: () => {
        if (!params.isOwnerCurrent()) {
          throw new Error("subagent restart recovery lifecycle retired before session commit");
        }
      },
      replaceEntry: true,
      skipMaintenance: true,
    },
  );
  return settled;
}
