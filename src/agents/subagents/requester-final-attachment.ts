import {
  getAgentEventLifecycleGeneration,
  registerAgentEventLifecycleRotationHandler,
} from "../../infra/agent-events.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";

const REQUESTER_FINAL_ATTACHMENT_KEY = Symbol.for("openclaw.subagents.requesterFinalAttachment");
const REQUESTER_FINAL_ATTACHMENT_MAX_TTL_MS = 2 * 60 * 60 * 1_000;

type RequesterFinalAttachmentOwner = {
  requesterAgentId: string;
  requesterSessionKey: string;
};

type RequesterFinalAttachmentBatch = {
  batchRunIds: readonly string[];
  rearmGeneration: number;
};

type RequesterFinalAttachment = {
  requesterSessionId: string;
  requesterTurnRunId: string;
  lifecycleGeneration: string;
  expiresAt: number;
  append: (text: string) => boolean;
  batch?: RequesterFinalAttachmentBatch;
};

type RequesterFinalAttachmentState = {
  byOwner: Map<string, RequesterFinalAttachment>;
};

const state = resolveGlobalSingleton<RequesterFinalAttachmentState>(
  REQUESTER_FINAL_ATTACHMENT_KEY,
  () => ({ byOwner: new Map() }),
  (value) => value.byOwner.clear(),
);

function ownerKey(requesterAgentId: string, requesterSessionKey: string): string {
  return `${requesterAgentId}\u0000${requesterSessionKey}`;
}

function sameRunIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((runId, index) => runId === right[index]);
}

function getCurrentAttachment(
  params: RequesterFinalAttachmentOwner &
    Partial<RequesterFinalAttachmentBatch> & {
      requesterSessionId?: string;
    },
): RequesterFinalAttachment | undefined {
  const key = ownerKey(params.requesterAgentId, params.requesterSessionKey);
  const attachment = state.byOwner.get(key);
  if (!attachment) {
    return undefined;
  }
  if (
    attachment.expiresAt <= Date.now() ||
    attachment.lifecycleGeneration !== getAgentEventLifecycleGeneration()
  ) {
    state.byOwner.delete(key);
    return undefined;
  }
  if (
    (params.requesterSessionId !== undefined &&
      attachment.requesterSessionId !== params.requesterSessionId) ||
    (params.batchRunIds !== undefined &&
      (!attachment.batch ||
        !sameRunIds(attachment.batch.batchRunIds, params.batchRunIds.toSorted()))) ||
    (params.rearmGeneration !== undefined &&
      attachment.batch?.rearmGeneration !== params.rearmGeneration)
  ) {
    return undefined;
  }
  return attachment;
}

export function registerRequesterFinalAttachment(
  params: RequesterFinalAttachmentOwner & {
    requesterSessionId: string;
    requesterTurnRunId: string;
    lifecycleGeneration: string;
    timeoutMs: number;
    append: (text: string) => boolean;
  },
): {
  releaseProvisional: () => void;
  revoke: () => void;
} {
  const key = ownerKey(params.requesterAgentId, params.requesterSessionKey);
  const attachment: RequesterFinalAttachment = {
    requesterSessionId: params.requesterSessionId,
    requesterTurnRunId: params.requesterTurnRunId,
    lifecycleGeneration: params.lifecycleGeneration,
    expiresAt: Date.now() + Math.min(params.timeoutMs, REQUESTER_FINAL_ATTACHMENT_MAX_TTL_MS),
    append: params.append,
  };
  state.byOwner.set(key, attachment);
  const deleteIfCurrent = (requireProvisional: boolean) => {
    const current = state.byOwner.get(key);
    if (current === attachment && (!requireProvisional || !current.batch)) {
      state.byOwner.delete(key);
    }
  };
  return {
    releaseProvisional: () => deleteIfCurrent(true),
    revoke: () => deleteIfCurrent(false),
  };
}

export function promoteRequesterFinalAttachment(
  params: RequesterFinalAttachmentOwner &
    RequesterFinalAttachmentBatch & {
      requesterTurnRunId: string;
    },
): boolean {
  const attachment = getCurrentAttachment({
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
  });
  if (!attachment || attachment.requesterTurnRunId !== params.requesterTurnRunId) {
    return false;
  }
  attachment.batch = {
    batchRunIds: params.batchRunIds.toSorted(),
    rearmGeneration: params.rearmGeneration,
  };
  return true;
}

export function transferRequesterFinalAttachment(
  params: RequesterFinalAttachmentOwner &
    RequesterFinalAttachmentBatch & {
      requesterSessionId: string;
      requesterTurnRunId: string;
    },
): boolean {
  const attachment = getCurrentAttachment(params);
  if (!attachment) {
    return false;
  }
  // Keep this batch until its successor either finishes or durably promotes the next one.
  attachment.requesterTurnRunId = params.requesterTurnRunId;
  return true;
}

export function revokeRequesterFinalAttachment(
  params: RequesterFinalAttachmentOwner &
    Partial<RequesterFinalAttachmentBatch> & {
      requesterSessionId?: string;
    },
): boolean {
  const key = ownerKey(params.requesterAgentId, params.requesterSessionKey);
  if (!getCurrentAttachment(params)) {
    return false;
  }
  state.byOwner.delete(key);
  return true;
}

/** A settled yield batch either attaches its visible final or releases the attachment. */
export function finalizeRequesterFinalAttachment(params: {
  requesterAgentId?: string;
  requesterSessionKey: string;
  requesterSessionId?: string;
  batchRunIds: readonly string[];
  rearmGeneration?: number;
  requesterYieldBatch?: boolean;
  pause: boolean;
  delivered?: boolean;
  finalAssistantVisibleText?: string;
}): void {
  const { requesterAgentId, rearmGeneration } = params;
  if (
    params.pause ||
    !requesterAgentId ||
    params.requesterYieldBatch !== true ||
    rearmGeneration === undefined
  ) {
    return;
  }
  const owner = {
    requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    batchRunIds: params.batchRunIds,
    rearmGeneration,
  };
  const text = params.finalAssistantVisibleText?.trim();
  if (!params.delivered || !params.requesterSessionId || !text) {
    revokeRequesterFinalAttachment(owner);
    return;
  }
  const attachment = getCurrentAttachment({
    ...owner,
    requesterSessionId: params.requesterSessionId,
  });
  if (!attachment) {
    return;
  }
  // Claim before invoking provider code so replay and callback failure cannot double-append.
  state.byOwner.delete(ownerKey(requesterAgentId, params.requesterSessionKey));
  try {
    attachment.append(text);
  } catch {
    // A failed append still consumes this final attachment.
  }
}

registerAgentEventLifecycleRotationHandler("requester-final-attachments", () => {
  state.byOwner.clear();
});
