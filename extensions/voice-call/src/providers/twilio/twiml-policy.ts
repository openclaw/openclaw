import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WebhookContext } from "../../types.js";

type TwimlRequestView = {
  callStatus: string | null;
  direction: string | null;
  isStatusCallback: boolean;
  callSid?: string;
  callIdFromQuery?: string;
};

type TwimlPolicyInput = TwimlRequestView & {
  hasStoredTwiml: boolean;
  isNotifyCall: boolean;
  hasActiveStreams: boolean;
  canStream: boolean;
};

type TwimlDecision =
  | {
      kind: "empty" | "pause" | "queue";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stored";
      consumeStoredTwimlCallId: string;
      activateStreamCallSid?: string;
    }
  | {
      kind: "stream";
      consumeStoredTwimlCallId?: string;
      activateStreamCallSid?: string;
    };

function isOutboundDirection(direction: string | null): boolean {
  return direction?.startsWith("outbound") ?? false;
}

/**
 * Extracts the Twilio webhook fields needed for TwiML response routing.
 * The raw body carries Twilio form fields; the query string distinguishes
 * OpenClaw status callbacks and one-shot TwiML requests.
 */
export function readTwimlRequestView(ctx: WebhookContext): TwimlRequestView {
  const params = new URLSearchParams(ctx.rawBody);
  const type = normalizeOptionalString(ctx.query?.type);
  const callIdFromQuery = normalizeOptionalString(ctx.query?.callId);

  return {
    callStatus: params.get("CallStatus"),
    direction: params.get("Direction"),
    isStatusCallback: type === "status",
    callSid: params.get("CallSid") || undefined,
    callIdFromQuery,
  };
}

/**
 * Chooses stored, streaming, pause, queue, or empty TwiML for a Twilio webhook.
 * Stored notify/pre-connect TwiML wins once, status callbacks never control
 * media, and inbound streams are serialized until the WebSocket path accepts.
 */
export function decideTwimlResponse(input: TwimlPolicyInput): TwimlDecision {
  if (input.callIdFromQuery && !input.isStatusCallback) {
    if (input.hasStoredTwiml) {
      // Initial notify/pre-connect TwiML wins before any streaming decision.
      return { kind: "stored", consumeStoredTwimlCallId: input.callIdFromQuery };
    }
    if (input.isNotifyCall) {
      // Notify-mode calls should not fall through into streaming after their
      // one spoken message has already been served.
      return { kind: "empty" };
    }

    if (isOutboundDirection(input.direction)) {
      // Outbound conversation calls can stream even before Twilio reports
      // in-progress; waiting would miss the first media setup callback.
      return input.canStream ? { kind: "stream" } : { kind: "pause" };
    }
  }

  if (input.isStatusCallback) {
    // Status callbacks are event notifications, not instructions for call media.
    return { kind: "empty" };
  }

  if (input.direction === "inbound") {
    if (input.hasActiveStreams) {
      // Only one inbound stream can be active until the WebSocket layer accepts
      // or releases the current call; queue extras at the carrier.
      return { kind: "queue" };
    }
    if (input.canStream && input.callSid) {
      return { kind: "stream", activateStreamCallSid: input.callSid };
    }
    return { kind: "pause" };
  }

  if (input.callStatus !== "in-progress") {
    return { kind: "empty" };
  }

  return input.canStream ? { kind: "stream" } : { kind: "pause" };
}
