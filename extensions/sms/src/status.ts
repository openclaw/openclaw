import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { SmsDeliveryRecord } from "./delivery-observations.js";
import {
  listTwilioIncomingPhoneNumbers,
  listTwilioMessages,
  retrieveTwilioMessagingService,
  type TwilioIncomingPhoneNumber,
  type TwilioMessagingService,
  type TwilioMessageLogEntry,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const TWILIO_ERROR_WEBHOOK_REACHABILITY = "11200";

type ChannelCapabilitiesDisplayLine = {
  text: string;
  tone?: "default" | "muted" | "success" | "warn" | "error";
};

type WidenProbeStrings<T extends { status: string }> = T extends unknown
  ? { [K in keyof T]: K extends "status" ? T[K] : T[K] extends string ? string : T[K] }
  : never;

type SmsTwilioWebhookProbe = WidenProbeStrings<
  | ReturnType<typeof compareTwilioWebhook>
  | ReturnType<typeof compareTwilioMessagingService>
  | { status: "unavailable"; reason: string }
>;

export type SmsProbe = {
  ok: boolean;
  error?: string;
  webhook: SmsTwilioWebhookProbe;
  recentInbound?: Pick<
    TwilioMessageLogEntry,
    "sid" | "direction" | "status" | "errorCode" | "dateCreated" | "dateSent"
  >;
  recentOutbound?: Pick<
    SmsDeliveryRecord,
    "messageSid" | "status" | "lastObservedAt" | "errorCode" | "conflict"
  >;
  hints: string[];
};

type ProbeOptions = {
  deliveryRecords?: readonly SmsDeliveryRecord[];
};

function resolveRemoteProbeTimeoutMs(timeoutMs: number): number {
  const normalized = Math.max(1, Math.floor(timeoutMs));
  const settleMarginMs = Math.min(100, Math.max(1, Math.floor(normalized / 10)));
  return Math.max(0, normalized - settleMarginMs);
}

function formatRemoteProbeFailure(label: string, error: unknown, timeoutMs: number): string {
  const message =
    error instanceof Error && error.name === "TimeoutError"
      ? `timed out after ${timeoutMs}ms`
      : formatErrorMessage(error);
  return `${label} failed: ${message}`;
}

function addTailscaleHint(account: ResolvedSmsAccount, hints: string[]): void {
  const host = URL.parse(account.publicWebhookUrl)?.hostname;
  if (!host?.endsWith(".ts.net")) {
    return;
  }
  hints.push(
    `Tailscale Funnel must expose the exact SMS path: tailscale funnel --bg --set-path ${account.webhookPath} http://127.0.0.1:<gateway-port>${account.webhookPath}`,
  );
}

function compareWebhook<
  Summary extends { expectedUrl: string; configuredMethod: string },
  Prefix extends "" | "messaging-service-",
>(summary: Summary, url: string, prefix: Prefix) {
  if (!url) {
    return { status: `${prefix}missing`, ...summary } as const;
  }
  const configured = { ...summary, configuredUrl: url };
  if (summary.configuredMethod && summary.configuredMethod !== "POST") {
    return { status: `${prefix}method-mismatch`, ...configured } as const;
  }
  if (url !== summary.expectedUrl) {
    return { status: `${prefix}url-mismatch`, ...configured } as const;
  }
  return { status: `${prefix}matches`, ...configured } as const;
}

function compareTwilioWebhook(
  account: ResolvedSmsAccount,
  phoneNumber: TwilioIncomingPhoneNumber | undefined,
) {
  if (!account.fromNumber) {
    return {
      status: "skipped",
      reason: "Messaging Service senders do not have one phone-number SMS webhook to inspect.",
    } as const;
  }
  if (!phoneNumber) {
    return { status: "number-not-found", expectedNumber: account.fromNumber } as const;
  }
  const summary = {
    phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
    expectedUrl: account.publicWebhookUrl,
    configuredMethod: phoneNumber.smsMethod.toUpperCase(),
  };
  const probe = compareWebhook(summary, phoneNumber.smsUrl, "");
  return probe.status === "matches" ? { ...probe, voiceUrl: phoneNumber.voiceUrl } : probe;
}

function compareTwilioMessagingService(
  account: ResolvedSmsAccount,
  service: TwilioMessagingService,
) {
  if (service.useInboundWebhookOnNumber) {
    return {
      status: "unavailable",
      reason:
        "Twilio Messaging Service defers inbound webhooks to sender phone numbers; configure fromNumber or disable defer-to-sender before checking.",
    } as const;
  }
  const summary = {
    serviceSid: service.sid || account.messagingServiceSid,
    expectedUrl: account.publicWebhookUrl,
    configuredMethod: service.inboundMethod.toUpperCase(),
  };
  return compareWebhook(summary, service.inboundRequestUrl, "messaging-service-");
}

function recentInboundSummary(
  messages: TwilioMessageLogEntry[],
): SmsProbe["recentInbound"] | undefined {
  const message = messages[0];
  if (!message) {
    return undefined;
  }
  return {
    sid: message.sid,
    direction: message.direction,
    status: message.status,
    errorCode: message.errorCode,
    dateCreated: message.dateCreated,
    dateSent: message.dateSent,
  };
}

function recentOutboundSummary(
  records: readonly SmsDeliveryRecord[],
): SmsProbe["recentOutbound"] | undefined {
  const record = records[0];
  if (!record) {
    return undefined;
  }
  return {
    messageSid: record.messageSid,
    status: record.status,
    lastObservedAt: record.lastObservedAt,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.conflict ? { conflict: true } : {}),
  };
}

function webhookError(probe: SmsTwilioWebhookProbe): string | undefined {
  switch (probe.status) {
    case "matches":
    case "skipped":
      return undefined;
    case "unavailable":
      return probe.reason;
    case "number-not-found":
      return `Twilio account does not list ${probe.expectedNumber} as an incoming phone number.`;
    case "missing":
      return `Twilio number ${probe.phoneNumber} has no SMS webhook URL configured.`;
    case "method-mismatch":
      return `Twilio number ${probe.phoneNumber} uses ${probe.configuredMethod || "an unknown method"} for SMS webhooks; use POST.`;
    case "url-mismatch":
      return `Twilio number ${probe.phoneNumber} points SMS webhooks at ${probe.configuredUrl}; expected ${probe.expectedUrl}.`;
    case "messaging-service-missing":
      return `Twilio Messaging Service ${probe.serviceSid} has no inbound request URL configured.`;
    case "messaging-service-method-mismatch":
      return `Twilio Messaging Service ${probe.serviceSid} uses ${probe.configuredMethod || "an unknown method"} for inbound webhooks; use POST.`;
    case "messaging-service-url-mismatch":
      return `Twilio Messaging Service ${probe.serviceSid} points inbound webhooks at ${probe.configuredUrl}; expected ${probe.expectedUrl}.`;
    case "messaging-service-matches":
      return undefined;
  }
  return undefined;
}

export async function probeSmsAccount(params: {
  account: ResolvedSmsAccount;
  timeoutMs: number;
  options?: ProbeOptions;
}): Promise<SmsProbe> {
  const hints: string[] = [];
  addTailscaleHint(params.account, hints);
  const recentOutbound = recentOutboundSummary(params.options?.deliveryRecords ?? []);
  const remoteTimeoutMs = resolveRemoteProbeTimeoutMs(params.timeoutMs);
  let webhook: SmsTwilioWebhookProbe;
  let messageHistoryError: string | undefined;
  let messages: TwilioMessageLogEntry[] = [];
  if (remoteTimeoutMs === 0) {
    webhook = {
      status: "unavailable",
      reason: "Twilio webhook check skipped because the check timeout is too short.",
    };
  } else {
    const requestOptions = () => ({
      account: params.account,
      timeoutMs: remoteTimeoutMs,
    });
    const webhookTask: Promise<SmsTwilioWebhookProbe> = params.account.fromNumber
      ? listTwilioIncomingPhoneNumbers({
          ...requestOptions(),
          phoneNumber: params.account.fromNumber,
        }).then(([number]) => compareTwilioWebhook(params.account, number))
      : params.account.messagingServiceSid
        ? retrieveTwilioMessagingService({
            ...requestOptions(),
            serviceSid: params.account.messagingServiceSid,
          }).then((service) => compareTwilioMessagingService(params.account, service))
        : Promise.resolve({
            status: "unavailable",
            reason: "Twilio SMS check requires fromNumber or messagingServiceSid.",
          });
    const messageTask = params.account.fromNumber
      ? listTwilioMessages({
          ...requestOptions(),
          to: params.account.fromNumber,
        })
      : Promise.resolve([]);
    const [webhookOutcome, messageOutcome] = await Promise.allSettled([webhookTask, messageTask]);
    webhook =
      webhookOutcome.status === "fulfilled"
        ? webhookOutcome.value
        : {
            status: "unavailable",
            reason: formatRemoteProbeFailure(
              "Twilio webhook check",
              webhookOutcome.reason,
              remoteTimeoutMs,
            ),
          };
    if (messageOutcome.status === "fulfilled") {
      messages = messageOutcome.value;
    } else {
      messageHistoryError = formatRemoteProbeFailure(
        "Twilio message history check",
        messageOutcome.reason,
        remoteTimeoutMs,
      );
    }
  }
  const recentInbound = recentInboundSummary(messages);
  if (recentInbound?.errorCode === TWILIO_ERROR_WEBHOOK_REACHABILITY) {
    hints.push(
      "Twilio error 11200 means Twilio could not reach the SMS webhook. Check the public URL, tunnel/Funnel route, and Twilio Messaging webhook method.",
    );
  }
  const error = [
    webhookError(webhook),
    messageHistoryError,
    recentInbound?.errorCode === TWILIO_ERROR_WEBHOOK_REACHABILITY
      ? `Recent inbound SMS ${recentInbound.sid} has Twilio error 11200.`
      : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ");
  return {
    ok: !error,
    ...(error ? { error } : {}),
    webhook,
    ...(recentInbound ? { recentInbound } : {}),
    ...(recentOutbound ? { recentOutbound } : {}),
    hints,
  };
}

export function formatSmsProbeLines(probe: unknown): ChannelCapabilitiesDisplayLine[] {
  if (!probe || typeof probe !== "object") {
    return [];
  }
  const smsProbe = probe as Partial<SmsProbe>;
  const lines: ChannelCapabilitiesDisplayLine[] = [];
  if (smsProbe.ok === true) {
    lines.push({ text: "Check: ok", tone: "success" });
  } else if (smsProbe.ok === false) {
    lines.push({
      text: `Check: failed${smsProbe.error ? ` (${smsProbe.error})` : ""}`,
      tone: "error",
    });
  }
  if (
    smsProbe.webhook?.status === "matches" ||
    smsProbe.webhook?.status === "messaging-service-matches"
  ) {
    lines.push({ text: `Twilio SMS webhook: ${smsProbe.webhook.configuredUrl}` });
  } else if (smsProbe.webhook?.status && smsProbe.webhook.status !== "skipped") {
    lines.push({ text: `Twilio SMS webhook: ${smsProbe.webhook.status}`, tone: "warn" });
  }
  if (smsProbe.recentInbound?.sid) {
    const error = smsProbe.recentInbound.errorCode
      ? ` error=${smsProbe.recentInbound.errorCode}`
      : "";
    lines.push({
      text: `Recent inbound: ${smsProbe.recentInbound.status || "unknown"}${error}`,
      tone: smsProbe.recentInbound.errorCode ? "warn" : "muted",
    });
  }
  if (smsProbe.recentOutbound?.messageSid) {
    const error = smsProbe.recentOutbound.errorCode
      ? ` error=${smsProbe.recentOutbound.errorCode}`
      : "";
    const status = smsProbe.recentOutbound.status || "unknown";
    const tone =
      status === "delivered"
        ? "success"
        : status === "failed" ||
            status === "undelivered" ||
            status === "canceled" ||
            status === "conflicted"
          ? "error"
          : "muted";
    lines.push({
      text: `Recent outbound: ${status}${error}`,
      tone,
    });
  }
  for (const hint of smsProbe.hints ?? []) {
    lines.push({ text: hint, tone: "warn" });
  }
  return lines;
}
