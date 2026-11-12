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
  onPromoted?: () => void;
  batch?: RequesterFinalAttachmentBatch;
};

type RequesterFinalAttachmentState = {
  byOwner: Map<string, RequesterFinalAttachment[]>;
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

function matchesAttachment(
  attachment: RequesterFinalAttachment,
  params: Partial<RequesterFinalAttachmentBatch> & {
    requesterSessionId?: string;
    requesterTurnRunId?: string;
  },
): boolean {
  return (
    (params.requesterSessionId === undefined ||
      attachment.requesterSessionId === params.requesterSessionId) &&
    (params.requesterTurnRunId === undefined ||
      attachment.requesterTurnRunId === params.requesterTurnRunId) &&
    (params.batchRunIds === undefined ||
      (attachment.batch !== undefined &&
        sameRunIds(attachment.batch.batchRunIds, params.batchRunIds.toSorted()))) &&
    (params.rearmGeneration === undefined ||
      attachment.batch?.rearmGeneration === params.rearmGeneration)
  );
}

function getCurrentAttachment(
  params: RequesterFinalAttachmentOwner &
    Partial<RequesterFinalAttachmentBatch> & {
      requesterSessionId?: string;
      requesterTurnRunId?: string;
    },
): RequesterFinalAttachment | undefined {
  const key = ownerKey(params.requesterAgentId, params.requesterSessionKey);
  const attachments = state.byOwner.get(key);
  if (!attachments) {
    return undefined;
  }
  const current = attachments.filter(
    (attachment) =>
      attachment.expiresAt > Date.now() &&
      attachment.lifecycleGeneration === getAgentEventLifecycleGeneration(),
  );
  if (current.length === 0) {
    state.byOwner.delete(key);
    return undefined;
  }
  if (current.length !== attachments.length) {
    state.byOwner.set(key, current);
  }
  return current.find((attachment) => matchesAttachment(attachment, params));
}

function deleteAttachment(key: string, attachment: RequesterFinalAttachment): void {
  const remaining = state.byOwner.get(key)?.filter((candidate) => candidate !== attachment) ?? [];
  if (remaining.length > 0) {
    state.byOwner.set(key, remaining);
  } else {
    state.byOwner.delete(key);
  }
}

export function registerRequesterFinalAttachment(
  params: RequesterFinalAttachmentOwner & {
    requesterSessionId: string;
    requesterTurnRunId: string;
    lifecycleGeneration: string;
    timeoutMs: number;
    append: (text: string) => boolean;
    onPromoted?: () => void;
  },
): {
  updateSessionId: (requesterSessionId: string) => boolean;
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
    onPromoted: params.onPromoted,
  };
  state.byOwner.set(key, [
    ...(state.byOwner.get(key) ?? []).filter(
      (current) => current.requesterTurnRunId !== params.requesterTurnRunId,
    ),
    attachment,
  ]);
  const deleteIfCurrent = (requireProvisional: boolean) => {
    if (
      state.byOwner.get(key)?.includes(attachment) &&
      (!requireProvisional || !attachment.batch)
    ) {
      deleteAttachment(key, attachment);
    }
  };
  return {
    updateSessionId: (requesterSessionId) => {
      const current = getCurrentAttachment({
        requesterAgentId: params.requesterAgentId,
        requesterSessionKey: params.requesterSessionKey,
        requesterTurnRunId: params.requesterTurnRunId,
      });
      if (current !== attachment) {
        return false;
      }
      attachment.requesterSessionId = requesterSessionId;
      return true;
    },
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
    requesterTurnRunId: params.requesterTurnRunId,
  });
  if (!attachment) {
    return false;
  }
  const wasPromoted = attachment.batch !== undefined;
  attachment.batch = {
    batchRunIds: params.batchRunIds.toSorted(),
    rearmGeneration: params.rearmGeneration,
  };
  if (!wasPromoted) {
    try {
      attachment.onPromoted?.();
    } catch {
      // Promotion remains durable even when an optional host observer has retired.
    }
  }
  return true;
}

export function transferRequesterFinalAttachment(
  params: RequesterFinalAttachmentOwner &
    RequesterFinalAttachmentBatch & {
      requesterSessionId: string;
      requesterTurnRunId: string;
    },
): boolean {
  const attachment = getCurrentAttachment({
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    requesterSessionId: params.requesterSessionId,
    batchRunIds: params.batchRunIds,
    rearmGeneration: params.rearmGeneration,
  });
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
  const current = state.byOwner.get(key) ?? [];
  const remaining = current.filter((attachment) => !matchesAttachment(attachment, params));
  if (remaining.length === 0) {
    state.byOwner.delete(key);
  } else {
    state.byOwner.set(key, remaining);
  }
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
  deleteAttachment(ownerKey(requesterAgentId, params.requesterSessionKey), attachment);
  try {
    attachment.append(text);
  } catch {
    // A failed append still consumes this final attachment.
  }
}

registerAgentEventLifecycleRotationHandler("requester-final-attachments", () => {
  state.byOwner.clear();
});
