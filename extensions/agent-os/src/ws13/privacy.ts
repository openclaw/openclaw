// Agent OS WS13 — L1 proof: privacy / redaction layer.
//
// Every simulated hook payload passes through here before any correlation or
// evidence logic. Content-bearing fields are dropped defensively even though
// the fixtures never include them. Errors are reduced to a closed set of
// coarse categories WITHOUT inspecting raw error text (raw error text may
// contain content and is itself a prohibited field). Revised from the Forge
// residual privacy.ts: same intent, hardened mapping and threadId coercion.

import type {
  Ws13CoarseErrorCategory,
  Ws13DeliveryObservation,
  Ws13DispatchObservation,
  Ws13HookEnvelope,
  Ws13MessageSendingObservation,
  Ws13OriginMetadata,
} from "./types.js";

// Keys that may carry task text, prompts, transcripts, assistant output,
// reply bodies, conversation context, images, attachments, human labels, or
// raw error strings. Dropped recursively before persistence/evidence.
const PROHIBITED_KEYS = new Set<string>([
  "content",
  "text",
  "prompt",
  "task",
  "taskText",
  "messages",
  "message",
  "transcript",
  "assistantOutput",
  "assistantMessage",
  "lastAssistantMessage",
  "replyBody",
  "body",
  "ctx",
  "images",
  "attachments",
  "label",
  "rawError",
  "errorText",
  "reason",
]);


function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

// threadId / replyToId are `string | number` in real OpenClaw events. Coerce
// numbers to opaque strings; they are routing metadata, never content.
function idField(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? value : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function dropContentBearingFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (PROHIBITED_KEYS.has(key)) {
      continue;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = dropContentBearingFields(
        value as Record<string, unknown>,
      );
      continue;
    }

    if (Array.isArray(value)) {
      // Arrays cannot carry structured content into evidence: keep only
      // primitive non-string scalars; map any string to an opaque marker.
      sanitized[key] = value
        .filter((entry) => !entry || typeof entry !== "object")
        .map((entry) =>
          typeof entry === "string" ? "opaque_array_value" : entry,
        );
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

// Sanitize an entire simulated hook envelope (defense in depth at ingest).
export function redactEnvelope(envelope: Ws13HookEnvelope): Ws13HookEnvelope {
  return {
    scenario: envelope.scenario,
    hookName: envelope.hookName,
    timestamp: envelope.timestamp,
    payload: dropContentBearingFields(envelope.payload),
  };
}

const KNOWN_CATEGORIES = new Set<Ws13CoarseErrorCategory>([
  "adapter_error",
  "missing_destination",
  "suppressed_delivery",
  "required_hook_missing",
  "store_unavailable",
  "correlation_insufficient",
  "plugin_inactive",
  "unknown_error",
]);

// Reduce an error signal to a coarse category. Raw error text is NEVER
// inspected for substrings (it is a prohibited content-bearing field). The
// only accepted typed input is an already-coarse category string emitted by
// our own handlers; anything else collapses to "unknown_error".
export function coarseErrorCategory(
  error: unknown,
): Ws13CoarseErrorCategory | undefined {
  if (error === undefined || error === null || error === false) {
    return undefined;
  }
  if (
    typeof error === "string" &&
    KNOWN_CATEGORIES.has(error as Ws13CoarseErrorCategory)
  ) {
    return error as Ws13CoarseErrorCategory;
  }
  return "unknown_error";
}

export function originFromPayload(
  payload: Record<string, unknown>,
): Ws13OriginMetadata {
  const requester =
    payload.requester && typeof payload.requester === "object"
      ? (payload.requester as Record<string, unknown>)
      : undefined;
  const requesterOrigin =
    payload.requesterOrigin && typeof payload.requesterOrigin === "object"
      ? (payload.requesterOrigin as Record<string, unknown>)
      : undefined;
  const origin = requesterOrigin ?? requester ?? payload;

  return {
    channel: stringField(origin.channel),
    accountId: stringField(origin.accountId),
    to: stringField(origin.to),
    threadId: idField(origin.threadId),
  };
}

export function dispatchObservationFromPayload(
  observationId: string,
  payload: Record<string, unknown>,
  observedAt: string,
): Ws13DispatchObservation {
  return {
    observationId,
    sessionKey: stringField(payload.sessionKey),
    runId: stringField(payload.runId),
    originatingChannel: stringField(payload.originatingChannel),
    originatingTo: stringField(payload.originatingTo),
    sendPolicy: stringField(payload.sendPolicy),
    suppressUserDelivery: booleanField(payload.suppressUserDelivery),
    suppressReplyLifecycle: booleanField(payload.suppressReplyLifecycle),
    isTailDispatch: booleanField(payload.isTailDispatch),
    shouldRouteToOriginating: booleanField(payload.shouldRouteToOriginating),
    observedAt,
  };
}

export function deliveryObservationFromPayload(
  observationId: string,
  payload: Record<string, unknown>,
  observedAt: string,
): Ws13DeliveryObservation {
  return {
    observationId,
    channel: stringField(payload.channel) ?? stringField(payload.channelId),
    accountId: stringField(payload.accountId),
    conversationId: stringField(payload.conversationId),
    to: stringField(payload.to),
    messageId: stringField(payload.messageId),
    success: payload.success === true,
    errorCategoryOnly: coarseErrorCategory(payload.error),
    observedAt,
    threadId: idField(payload.threadId),
    replyToId: idField(payload.replyToId),
  };
}

export function messageSendingObservationFromPayload(
  observationId: string,
  payload: Record<string, unknown>,
  observedAt: string,
): Ws13MessageSendingObservation {
  return {
    observationId,
    channel: stringField(payload.channel) ?? stringField(payload.channelId),
    accountId: stringField(payload.accountId),
    to: stringField(payload.to),
    threadId: idField(payload.threadId),
    replyToId: idField(payload.replyToId),
    observedAt,
  };
}

// Structural metadata-only invariant: walk the value and fail if ANY object
// key is a prohibited content-bearing key. This is robust where a serialized
// substring scan is not: legitimate enum values (e.g.
// "metadata_only_content_dropped") and prose are not flagged, while a leaked
// `content` / `ctx` / `label` key anywhere in the structure is caught.
export function hasNoContentBearingEvidence(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every((entry) => hasNoContentBearingEvidence(entry));
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (PROHIBITED_KEYS.has(key)) {
        return false;
      }
      if (!hasNoContentBearingEvidence(child)) {
        return false;
      }
    }
  }
  return true;
}
