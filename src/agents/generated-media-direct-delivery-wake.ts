/**
 * Wake for generated-media direct-delivery fallbacks.
 *
 * When a background media generation completion cannot wake the requester's
 * agent turn (for example after an inbound message steered or aborted the
 * original run), delivery falls back to sending the media straight to the
 * channel. Without a follow-up wake the owning session never gets an agent
 * turn for the completion, so the attachment lands as an orphaned message.
 * Mirror the background-exec completion pattern: enqueue a system event and
 * request a heartbeat wake so the agent can continue in its own voice.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../infra/event-session-routing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import type { DeliveryContext } from "../utils/delivery-context.js";

const log = createSubsystemLogger("agents/generated-media-direct-delivery-wake");

type GeneratedMediaDirectDeliveryWakeDeps = {
  enqueueSystemEvent: typeof enqueueSystemEvent;
  requestHeartbeat: typeof requestHeartbeat;
};

const defaultDeps: GeneratedMediaDirectDeliveryWakeDeps = {
  enqueueSystemEvent,
  requestHeartbeat,
};

let deps: GeneratedMediaDirectDeliveryWakeDeps = defaultDeps;

function buildDirectDeliveryWakeText(params: {
  mediaLabel: string;
  status: "ok" | "error";
}): string {
  if (params.status === "ok") {
    return [
      `A background ${params.mediaLabel} generation task completed while no agent turn could be woken, so the generated ${params.mediaLabel} was already delivered directly to the chat.`,
      "Do not resend the attachment. Continue the conversation and follow up in your own voice if a reply is still owed.",
    ].join(" ");
  }
  return [
    `A background ${params.mediaLabel} generation task failed while no agent turn could be woken, and the failure notice was already delivered directly to the chat.`,
    "Do not resend the failure notice. Continue the conversation and follow up in your own voice if a reply is still owed.",
  ].join(" ");
}

/**
 * Queues a system event and heartbeat wake for the session that owns a
 * generated-media completion after its media was delivered directly to the
 * channel. Best-effort: the direct delivery already guaranteed the media is
 * not lost, so wake failures only log.
 */
export function wakeSessionForGeneratedMediaDirectDelivery(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  mediaLabel?: string;
  status?: "ok" | "error";
  deliveryContext?: DeliveryContext;
  contextKey?: string;
}): void {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return;
  }
  try {
    const eventRouting = resolveEventSessionRoutingPolicy({
      cfg: params.cfg,
      sessionKey,
      channel: params.deliveryContext?.channel,
      accountId: params.deliveryContext?.accountId,
    });
    deps.enqueueSystemEvent(
      buildDirectDeliveryWakeText({
        mediaLabel: params.mediaLabel?.trim() || "media",
        status: params.status ?? "ok",
      }),
      {
        sessionKey: resolveEventSessionKeyForPolicy(sessionKey, eventRouting),
        contextKey: params.contextKey,
        deliveryContext: params.deliveryContext,
      },
    );
    // Subagent sessions receive completion results via the announce flow; a
    // heartbeat would fall back to the main session and cause spurious wakes.
    if (isSubagentSessionKey(sessionKey)) {
      return;
    }
    deps.requestHeartbeat(
      scopedHeartbeatWakeOptionsForPolicy(
        sessionKey,
        {
          source: "background-task",
          intent: "event",
          reason: "generated-media:direct-delivery",
          coalesceMs: 0,
        },
        eventRouting,
      ),
    );
  } catch (error) {
    log.warn("Failed to wake session after generated media direct delivery", {
      sessionKey,
      error,
    });
  }
}

export const testing = {
  setDepsForTest(overrides?: Partial<GeneratedMediaDirectDeliveryWakeDeps>) {
    deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
  },
};
