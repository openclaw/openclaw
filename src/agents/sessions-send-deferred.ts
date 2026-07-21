/** Origin-bound deferred completion for opt-in sessions_send calls. */
import crypto from "node:crypto";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  type DeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isInternalNonDeliveryChannel,
} from "../utils/message-channel.js";
import { extractAgentCommandReply } from "./agent-command-reply.js";
import type { AgentRunTerminalOutcome } from "./agent-run-terminal-outcome.js";
import { resolveNestedAgentLaneForSession } from "./lanes.js";
import {
  cancelSessionsSendDeferredCompletion,
  claimSessionsSendDeferredCompletion,
  finishSessionsSendDeferredCompletion,
  listPendingSessionsSendDeferredRunIds,
  registerSessionsSendDeferredCompletion,
  type SessionsSendDeferredRegistration,
} from "./sessions-send-deferred-store.js";

export const SESSIONS_SEND_DEFERRED_TTL_MS = 24 * 60 * 60_000;

const pendingRunIds = new Set<string>();
let pendingRunIdsLoaded = false;

type DeferredCompletionDispatch = (params: Record<string, unknown>) => Promise<unknown>;

async function dispatchContinuation(params: Record<string, unknown>): Promise<unknown> {
  const { callGateway } = await import("../gateway/call.js");
  return await callGateway({ method: "agent", params, timeoutMs: 10_000 });
}

function resolveExplicitOrigin(origin?: DeliveryContext): DeliveryContext | undefined {
  const normalized = normalizeDeliveryContext(origin);
  if (!normalized?.channel || !normalized.to || isInternalNonDeliveryChannel(normalized.channel)) {
    return undefined;
  }
  return normalized;
}

/** Persist and index a one-shot deferred completion before target dispatch. */
export function armSessionsSendDeferredCompletion(
  params: {
    targetRunId: string;
    targetSessionKey: string;
    requesterSessionKey: string;
    requesterSessionId: string;
    requesterOrigin: DeliveryContext;
    requestMessage: string;
    now?: number;
    ttlMs?: number;
  },
  options: OpenClawStateDatabaseOptions = {},
): { expiresAt: number } {
  const requesterOrigin = resolveExplicitOrigin(params.requesterOrigin);
  if (!requesterOrigin) {
    throw new Error("wakeOnReply requires an explicit external requester delivery context");
  }
  const createdAt = params.now ?? Date.now();
  const expiresAt = createdAt + (params.ttlMs ?? SESSIONS_SEND_DEFERRED_TTL_MS);
  const registration: SessionsSendDeferredRegistration = {
    targetRunId: params.targetRunId,
    targetSessionKey: params.targetSessionKey,
    requesterSessionKey: params.requesterSessionKey,
    requesterSessionId: params.requesterSessionId,
    requesterOrigin,
    requestMessage: params.requestMessage,
    continuationRunId: crypto.randomUUID(),
    createdAt,
    expiresAt,
  };
  registerSessionsSendDeferredCompletion(registration, options);
  pendingRunIds.add(params.targetRunId);
  return { expiresAt };
}

/** Cancel a registration when its target run was not accepted. */
export function disarmSessionsSendDeferredCompletion(
  params: { targetRunId: string; error?: string },
  options: OpenClawStateDatabaseOptions = {},
): void {
  pendingRunIds.delete(params.targetRunId);
  cancelSessionsSendDeferredCompletion(params, options);
}

function buildDeferredCompletionPrompt(params: {
  registration: SessionsSendDeferredRegistration;
  terminalOutcome: AgentRunTerminalOutcome;
  result: unknown;
}): string {
  const reply = extractAgentCommandReply(params.result);
  const outcome =
    params.terminalOutcome.status === "ok"
      ? reply || "(The target run completed without final assistant text.)"
      : [
          `The target run ended with ${params.terminalOutcome.reason}.`,
          params.terminalOutcome.error,
        ]
          .filter(Boolean)
          .join(" ");
  return [
    "[Deferred sessions_send completion]",
    `Target session: ${params.registration.targetSessionKey}`,
    `Target run: ${params.registration.targetRunId}`,
    `Original request: ${params.registration.requestMessage}`,
    "",
    "The user is waiting in this conversation for the result. Continue this conversation now and give the user the result or failure status.",
    "",
    "Target result:",
    outcome,
  ].join("\n");
}

function buildContinuationParams(params: {
  registration: SessionsSendDeferredRegistration;
  terminalOutcome: AgentRunTerminalOutcome;
  result: unknown;
}): Record<string, unknown> {
  const { registration } = params;
  const origin = registration.requesterOrigin;
  return {
    message: buildDeferredCompletionPrompt(params),
    sessionKey: registration.requesterSessionKey,
    expectedExistingSessionId: registration.requesterSessionId,
    idempotencyKey: registration.continuationRunId,
    deliver: true,
    bestEffortDeliver: false,
    sourceReplyDeliveryMode: "automatic",
    channel: origin.channel,
    to: origin.to,
    ...(origin.accountId ? { accountId: origin.accountId } : {}),
    ...(origin.threadId != null ? { threadId: String(origin.threadId) } : {}),
    lane: resolveNestedAgentLaneForSession(registration.requesterSessionKey),
    inputProvenance: {
      kind: "inter_session",
      sourceSessionKey: registration.targetSessionKey,
      sourceChannel: INTERNAL_MESSAGE_CHANNEL,
      sourceTool: "sessions_send",
    },
  };
}

function ensurePendingRunIdsLoaded(options: OpenClawStateDatabaseOptions): void {
  if (pendingRunIdsLoaded) {
    return;
  }
  for (const runId of listPendingSessionsSendDeferredRunIds(options)) {
    pendingRunIds.add(runId);
  }
  pendingRunIdsLoaded = true;
}

/** Consume a correlated target settlement and start one exact-origin continuation. */
export async function maybeCompleteSessionsSendDeferred(
  params: {
    targetRunId: string;
    targetSessionKey: string;
    terminalOutcome: AgentRunTerminalOutcome;
    result?: unknown;
    dispatch?: DeferredCompletionDispatch;
  },
  options: OpenClawStateDatabaseOptions = {},
): Promise<boolean> {
  ensurePendingRunIdsLoaded(options);
  if (!pendingRunIds.has(params.targetRunId)) {
    return false;
  }
  const registration = claimSessionsSendDeferredCompletion(
    {
      targetRunId: params.targetRunId,
      targetSessionKey: params.targetSessionKey,
      terminalOutcome: params.terminalOutcome,
    },
    options,
  );
  if (!registration) {
    return false;
  }
  pendingRunIds.delete(params.targetRunId);
  try {
    await (params.dispatch ?? dispatchContinuation)(
      buildContinuationParams({
        registration,
        terminalOutcome: params.terminalOutcome,
        result: params.result,
      }),
    );
    finishSessionsSendDeferredCompletion(
      { targetRunId: params.targetRunId, delivered: true },
      options,
    );
    return true;
  } catch (error) {
    finishSessionsSendDeferredCompletion(
      {
        targetRunId: params.targetRunId,
        delivered: false,
        error: error instanceof Error ? error.message : String(error),
      },
      options,
    );
    return false;
  }
}

export const testing = {
  resetPendingRunIds() {
    pendingRunIds.clear();
    pendingRunIdsLoaded = false;
  },
};
