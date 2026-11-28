import { isAllowlistedCaller, normalizePhoneNumber } from "../allowlist.js";
import type { VoiceCallConfig } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import { isProviderStatusTerminal } from "../providers/shared/call-status.js";
import type { NormalizedEvent, WebhookContext } from "../types.js";

// Only initial TwiML fetches without gathered input enter realtime handling.
export function getRealtimeTwimlParams(ctx: WebhookContext): URLSearchParams | null {
  const form = new URLSearchParams(ctx.rawBody);
  const direction = form.get("Direction");
  const callStatus = form.get("CallStatus");
  return (!direction || direction === "inbound" || direction.startsWith("outbound")) &&
    ctx.query?.type !== "status" &&
    ctx.query?.type !== "amd" &&
    (!callStatus || !isProviderStatusTerminal(callStatus)) &&
    !form.get("SpeechResult") &&
    !form.get("Digits")
    ? form
    : null;
}

export async function acceptRealtimeInboundRequest(params: {
  request: WebhookContext;
  form: URLSearchParams;
  verifiedRequestKey: string | undefined;
  config: VoiceCallConfig;
  manager: { getCallByProviderCallId: (providerCallId: string) => unknown };
  provider: Pick<VoiceCallProvider, "parseWebhookEvent">;
  processEvents: (events: NormalizedEvent[]) => Promise<unknown>;
}): Promise<boolean> {
  if (params.config.inboundPolicy === "open") {
    return true;
  }
  if (
    (params.config.inboundPolicy === "allowlist" || params.config.inboundPolicy === "pairing") &&
    isAllowlistedCaller(
      normalizePhoneNumber(params.form.get("From") ?? undefined),
      params.config.allowFrom,
    )
  ) {
    return true;
  }
  if (!params.config.callbacks.enabled) {
    return false;
  }

  const parsed = params.provider.parseWebhookEvent(params.request, {
    verifiedRequestKey: params.verifiedRequestKey,
  });
  await params.processEvents(parsed.events);
  const providerCallId = params.form.get("CallSid");
  return Boolean(providerCallId && params.manager.getCallByProviderCallId(providerCallId));
}
