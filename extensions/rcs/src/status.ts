// Rcs plugin module implements status behavior.
import { latestRcsStatusEvent, listRcsStatusEvents } from "./status-store.js";
import { retrieveTwilioMessagingService, type TwilioMessagingService } from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";

type ChannelCapabilitiesDisplayLine = {
  text: string;
  tone?: "default" | "muted" | "success" | "warn" | "error";
};

type RcsTwilioWebhookProbe =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "unavailable";
      reason: string;
    }
  | {
      status: "messaging-service-missing";
      serviceSid: string;
      expectedUrl: string;
      configuredMethod: string;
    }
  | {
      status: "messaging-service-method-mismatch";
      serviceSid: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "messaging-service-url-mismatch";
      serviceSid: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "messaging-service-matches";
      serviceSid: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    };

export type RcsProbe = {
  ok: boolean;
  error?: string;
  webhook: RcsTwilioWebhookProbe;
  recentStatus?: {
    messageSid: string;
    status: string;
    errorCode?: string;
  };
  hints: string[];
};

type ProbeOptions = {
  fetchImpl?: typeof fetch;
};

function compareTwilioMessagingService(
  account: ResolvedRcsAccount,
  service: TwilioMessagingService,
): RcsTwilioWebhookProbe {
  if (service.useInboundWebhookOnNumber) {
    return {
      status: "unavailable",
      reason:
        "Twilio Messaging Service defers inbound webhooks to sender phone numbers; disable defer-to-sender so RCS inbound reaches the service-level webhook.",
    };
  }
  const configuredMethod = service.inboundMethod.toUpperCase();
  if (!service.inboundRequestUrl) {
    return {
      status: "messaging-service-missing",
      serviceSid: service.sid || account.messagingServiceSid,
      expectedUrl: account.publicWebhookUrl,
      configuredMethod,
    };
  }
  if (configuredMethod && configuredMethod !== "POST") {
    return {
      status: "messaging-service-method-mismatch",
      serviceSid: service.sid || account.messagingServiceSid,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: service.inboundRequestUrl,
      configuredMethod,
    };
  }
  if (service.inboundRequestUrl !== account.publicWebhookUrl) {
    return {
      status: "messaging-service-url-mismatch",
      serviceSid: service.sid || account.messagingServiceSid,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: service.inboundRequestUrl,
      configuredMethod,
    };
  }
  return {
    status: "messaging-service-matches",
    serviceSid: service.sid || account.messagingServiceSid,
    expectedUrl: account.publicWebhookUrl,
    configuredUrl: service.inboundRequestUrl,
    configuredMethod,
  };
}

function webhookError(probe: RcsTwilioWebhookProbe): string | undefined {
  switch (probe.status) {
    case "messaging-service-matches":
    case "skipped":
      return undefined;
    case "unavailable":
      return probe.reason;
    case "messaging-service-missing":
      return `Twilio Messaging Service ${probe.serviceSid} has no inbound request URL configured.`;
    case "messaging-service-method-mismatch":
      return `Twilio Messaging Service ${probe.serviceSid} uses ${probe.configuredMethod || "an unknown method"} for inbound webhooks; use POST.`;
    case "messaging-service-url-mismatch":
      return `Twilio Messaging Service ${probe.serviceSid} points inbound webhooks at ${probe.configuredUrl}; expected ${probe.expectedUrl}.`;
  }
  return undefined;
}

export async function probeRcsAccount(params: {
  account: ResolvedRcsAccount;
  timeoutMs: number;
  options?: ProbeOptions;
}): Promise<RcsProbe> {
  const hints: string[] = [];
  const webhook: RcsTwilioWebhookProbe = params.account.messagingServiceSid
    ? compareTwilioMessagingService(
        params.account,
        await retrieveTwilioMessagingService({
          account: params.account,
          serviceSid: params.account.messagingServiceSid,
          fetchImpl: params.options?.fetchImpl,
          timeoutMs: params.timeoutMs,
        }),
      )
    : params.account.senderId
      ? {
          status: "skipped",
          reason: "Direct RCS sender sends do not use a Messaging Service inbound webhook.",
        }
      : {
          status: "unavailable",
          reason: "Twilio RCS probe requires messagingServiceSid or senderId.",
        };
  const recentEvents = listRcsStatusEvents(params.account.accountId);
  const recentEvent = recentEvents[0];
  if (params.account.transport === "rcs-only") {
    hints.push(
      "RCS-only transport: messages reach RCS-enabled handsets only (approved testers while the sender is in test mode).",
    );
  }
  const error = webhookError(webhook);
  return {
    ok: !error,
    ...(error ? { error } : {}),
    webhook,
    ...(recentEvent
      ? {
          recentStatus: {
            messageSid: recentEvent.messageSid,
            status: recentEvent.status,
            ...(recentEvent.errorCode ? { errorCode: recentEvent.errorCode } : {}),
          },
        }
      : {}),
    hints,
  };
}

type RcsDeliveryReceipt = {
  messageSid: string;
  status: string;
  /** Recipient's device confirmed a read receipt (RCS EventType=READ). */
  read: boolean;
  /** Message reached the recipient (delivered or read). */
  delivered: boolean;
  errorCode?: string;
};

/**
 * Classifies a recorded outbound status event into read/delivered flags so every
 * surface renders receipts the same way. A read receipt implies delivery.
 */
function classifyRcsDeliveryReceipt(event: {
  messageSid: string;
  status: string;
  errorCode?: string;
}): RcsDeliveryReceipt {
  const normalized = event.status.trim().toLowerCase();
  const read = normalized === "read";
  return {
    messageSid: event.messageSid,
    status: event.status,
    read,
    delivered: read || normalized === "delivered",
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
  };
}

function describeRcsDeliveryReceiptLine(
  receipt: RcsDeliveryReceipt,
): ChannelCapabilitiesDisplayLine {
  if (receipt.errorCode) {
    return {
      text: `Latest receipt ${receipt.messageSid} failed (error ${receipt.errorCode})`,
      tone: "warn",
    };
  }
  if (receipt.read) {
    return { text: `Read receipt: recipient read ${receipt.messageSid}`, tone: "success" };
  }
  if (receipt.delivered) {
    return { text: `Delivered: ${receipt.messageSid} reached the recipient`, tone: "muted" };
  }
  return { text: `Latest receipt ${receipt.messageSid}: ${receipt.status}`, tone: "muted" };
}

/**
 * Agent-visible delivery/read status for the account's most recently received
 * callback. Reads persisted status callbacks directly, so read and delivered
 * receipts surface in channel status even when a live Twilio probe is not
 * reachable (for example a test-mode RCS sender). Mirrors how SMS surfaces
 * recent delivery state without claiming callback order equals send order.
 */
export function buildRcsDeliveryStatusLines(accountId: string): ChannelCapabilitiesDisplayLine[] {
  const event = latestRcsStatusEvent(accountId);
  return event ? [describeRcsDeliveryReceiptLine(classifyRcsDeliveryReceipt(event))] : [];
}

export function formatRcsProbeLines(probe: unknown): ChannelCapabilitiesDisplayLine[] {
  if (!probe || typeof probe !== "object") {
    return [];
  }
  const rcsProbe = probe as Partial<RcsProbe>;
  const lines: ChannelCapabilitiesDisplayLine[] = [];
  if (rcsProbe.ok === true) {
    lines.push({ text: "Probe: ok", tone: "success" });
  } else if (rcsProbe.ok === false) {
    lines.push({
      text: `Probe: failed${rcsProbe.error ? ` (${rcsProbe.error})` : ""}`,
      tone: "error",
    });
  }
  if (rcsProbe.webhook?.status === "messaging-service-matches") {
    lines.push({ text: `Twilio RCS webhook: ${rcsProbe.webhook.configuredUrl}` });
  } else if (rcsProbe.webhook?.status && rcsProbe.webhook.status !== "skipped") {
    lines.push({ text: `Twilio RCS webhook: ${rcsProbe.webhook.status}`, tone: "warn" });
  }
  if (rcsProbe.recentStatus?.messageSid) {
    lines.push(
      describeRcsDeliveryReceiptLine(
        classifyRcsDeliveryReceipt({
          messageSid: rcsProbe.recentStatus.messageSid,
          status: rcsProbe.recentStatus.status || "unknown",
          ...(rcsProbe.recentStatus.errorCode
            ? { errorCode: rcsProbe.recentStatus.errorCode }
            : {}),
        }),
      ),
    );
  }
  for (const hint of rcsProbe.hints ?? []) {
    lines.push({ text: hint, tone: "muted" });
  }
  return lines;
}
