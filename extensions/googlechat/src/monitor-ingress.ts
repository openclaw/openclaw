// Googlechat plugin module owns durable webhook admission and replay.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import type { GoogleChatRuntimeEnv } from "./monitor-types.js";
import { getGoogleChatRuntime } from "./runtime.js";
import type { GoogleChatEvent } from "./types.js";

const GOOGLECHAT_INGRESS_PAYLOAD_VERSION = 1;
// Completed tombstones only guard duplicate admission (Google Chat does not
// retry webhooks); failed rows keep longer diagnostics. Mirrors sms #109866.
const GOOGLECHAT_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;
const GOOGLECHAT_COMPLETED_MAX_ENTRIES = 20_000;
const GOOGLECHAT_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GOOGLECHAT_FAILED_MAX_ENTRIES = 1_000;

export type GoogleChatIngressPayload = {
  version: typeof GOOGLECHAT_INGRESS_PAYLOAD_VERSION;
  rawEvent: string;
};

export type GoogleChatIngressLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

class GoogleChatIngressPermanentError extends Error {}

function resolveGoogleChatIngressEventId(event: GoogleChatEvent): string {
  // Google Chat message resource names (spaces/<space>/messages/<message>) are
  // the platform uniqueness contract, so the raw name is the redelivery key.
  const eventId = typeof event.message?.name === "string" ? event.message.name.trim() : "";
  if (!eventId) {
    throw new GoogleChatIngressPermanentError("Google Chat MESSAGE event is missing message.name.");
  }
  return eventId;
}

function resolveGoogleChatIngressLaneKey(event: GoogleChatEvent, eventId: string): string {
  const spaceName = typeof event.space?.name === "string" ? event.space.name.trim() : "";
  return spaceName ? `space:${spaceName}` : `event:${eventId}`;
}

function readGoogleChatIngressEventType(event: GoogleChatEvent): string | undefined {
  return event.type ?? (event as { eventType?: string }).eventType;
}

function parseGoogleChatIngressPayload(
  payload: GoogleChatIngressPayload,
  claimedId: string,
): GoogleChatEvent {
  if (
    payload.version !== GOOGLECHAT_INGRESS_PAYLOAD_VERSION ||
    typeof payload.rawEvent !== "string"
  ) {
    throw new GoogleChatIngressPermanentError("Google Chat ingress payload is invalid.");
  }
  let event: unknown;
  try {
    event = JSON.parse(payload.rawEvent);
  } catch (error) {
    throw new GoogleChatIngressPermanentError("Google Chat ingress event JSON is invalid.", {
      cause: error,
    });
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new GoogleChatIngressPermanentError("Google Chat ingress event must be an object.");
  }
  const parsed = event as GoogleChatEvent;
  if (readGoogleChatIngressEventType(parsed) !== "MESSAGE") {
    throw new GoogleChatIngressPermanentError("Google Chat ingress row is not a MESSAGE event.");
  }
  if (resolveGoogleChatIngressEventId(parsed) !== claimedId) {
    throw new GoogleChatIngressPermanentError(
      "Google Chat message name changed after durable admission.",
    );
  }
  return parsed;
}

export function createGoogleChatIngressSpool(params: {
  accountId: string;
  runtime: GoogleChatRuntimeEnv;
  deliver: (event: GoogleChatEvent, lifecycle: GoogleChatIngressLifecycle) => Promise<void>;
  queue?: ChannelIngressQueue<GoogleChatIngressPayload>;
  abortSignal?: AbortSignal;
}) {
  const queue =
    params.queue ??
    getGoogleChatRuntime().state.openChannelIngressQueue<GoogleChatIngressPayload>({
      accountId: params.accountId,
    });
  const drain = createChannelIngressDrain<GoogleChatIngressPayload>({
    queue,
    orderBy: "received",
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    onLog: (message) => params.runtime.error?.(`googlechat: ${message}`),
    resolveNonRetryableFailure: (error) =>
      error instanceof GoogleChatIngressPermanentError
        ? { reason: "invalid-payload", message: error.message }
        : null,
    dispatchClaimedEvent: async (claimed, lifecycle) => {
      await params.deliver(
        parseGoogleChatIngressPayload(claimed.payload, claimed.id),
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
      );
    },
  });
  return {
    enqueue: async (event: GoogleChatEvent) => {
      const eventId = resolveGoogleChatIngressEventId(event);
      await queue.prune({
        completedTtlMs: GOOGLECHAT_COMPLETED_TTL_MS,
        completedMaxEntries: GOOGLECHAT_COMPLETED_MAX_ENTRIES,
        failedTtlMs: GOOGLECHAT_FAILED_TTL_MS,
        failedMaxEntries: GOOGLECHAT_FAILED_MAX_ENTRIES,
      });
      const result = await queue.enqueue(
        eventId,
        { version: GOOGLECHAT_INGRESS_PAYLOAD_VERSION, rawEvent: JSON.stringify(event) },
        {
          receivedAt: Date.now(),
          laneKey: resolveGoogleChatIngressLaneKey(event, eventId),
        },
      );
      return { kind: result.kind, duplicate: result.duplicate };
    },
    drainOnce: async () => {
      await drain.drainOnce();
    },
    waitForIdle: drain.waitForIdle,
    dispose: () => drain.dispose(),
  };
}

export type GoogleChatIngressSpool = ReturnType<typeof createGoogleChatIngressSpool>;
