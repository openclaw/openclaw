import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { WebhookContext } from "../../types.js";

// Twilio webhook policy for deciding whether to stream, pause, queue, or serve stored TwiML.

/** Normalized Twilio webhook request fields used by TwiML policy. */
type TwimlRequestView = {
  callStatus: string | null;
  direction: string | null;
  isStatusCallback: boolean;
  callSid?: string;
  callIdFromQuery?: string;
};

/** Full TwiML policy input including manager/runtime state. */
type TwimlPolicyInput = TwimlRequestView & {
  hasStoredTwiml: boolean;
  hasActiveStreams: boolean;
  canStream: boolean;
};

type TwimlDecision = "empty" | "pause" | "queue" | "stored" | "stream";

/** Read the Twilio request fields needed by TwiML decision logic. */
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

/** Decide the TwiML response kind for a Twilio webhook request. */
export function decideTwimlResponse(input: TwimlPolicyInput): TwimlDecision {
  if (input.callIdFromQuery && !input.isStatusCallback) {
    if (input.hasStoredTwiml) {
      return "stored";
    }
    if (input.direction?.startsWith("outbound")) {
      return input.canStream ? "stream" : "pause";
    }
  }

  if (input.isStatusCallback) {
    return "empty";
  }

  if (input.direction === "inbound") {
    if (input.hasActiveStreams) {
      return "queue";
    }
    if (input.canStream && input.callSid) {
      return "stream";
    }
    return "pause";
  }

  if (input.callStatus !== "in-progress") {
    return "empty";
  }

  return input.canStream ? "stream" : "pause";
}
