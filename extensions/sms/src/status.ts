import {
  listTwilioIncomingPhoneNumbers,
  listTwilioMessages,
  type TwilioIncomingPhoneNumber,
  type TwilioMessageLogEntry,
} from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const TWILIO_ERROR_WEBHOOK_REACHABILITY = "11200";

type ChannelCapabilitiesDisplayLine = {
  text: string;
  tone?: "default" | "muted" | "success" | "warn" | "error";
};

export type SmsTwilioWebhookProbe =
  | {
      status: "skipped";
      reason: string;
    }
  | {
      status: "number-not-found";
      expectedNumber: string;
    }
  | {
      status: "missing";
      phoneNumber: string;
      expectedUrl: string;
      configuredMethod: string;
    }
  | {
      status: "method-mismatch";
      phoneNumber: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "url-mismatch";
      phoneNumber: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
    }
  | {
      status: "matches";
      phoneNumber: string;
      expectedUrl: string;
      configuredUrl: string;
      configuredMethod: string;
      voiceUrl: string;
    };

export type SmsProbe = {
  ok: boolean;
  error?: string;
  webhook: SmsTwilioWebhookProbe;
  recentInbound?: Pick<
    TwilioMessageLogEntry,
    "sid" | "direction" | "status" | "from" | "to" | "errorCode" | "dateCreated" | "dateSent"
  >;
  hints: string[];
};

type ProbeOptions = {
  fetchImpl?: typeof fetch;
};

function addTailscaleHint(account: ResolvedSmsAccount, hints: string[]): void {
  let host = "";
  try {
    host = new URL(account.publicWebhookUrl).hostname;
  } catch {
    return;
  }
  if (!host.endsWith(".ts.net")) {
    return;
  }
  hints.push(
    `Tailscale Funnel must expose the exact SMS path: tailscale funnel --bg --set-path ${account.webhookPath} http://127.0.0.1:<gateway-port>${account.webhookPath}`,
  );
}

function compareTwilioWebhook(
  account: ResolvedSmsAccount,
  phoneNumber: TwilioIncomingPhoneNumber | undefined,
): SmsTwilioWebhookProbe {
  if (!account.fromNumber) {
    return {
      status: "skipped",
      reason: "Messaging Service senders do not have one phone-number SMS webhook to inspect.",
    };
  }
  if (!phoneNumber) {
    return { status: "number-not-found", expectedNumber: account.fromNumber };
  }
  const configuredMethod = phoneNumber.smsMethod.toUpperCase();
  if (!phoneNumber.smsUrl) {
    return {
      status: "missing",
      phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
      expectedUrl: account.publicWebhookUrl,
      configuredMethod,
    };
  }
  if (configuredMethod && configuredMethod !== "POST") {
    return {
      status: "method-mismatch",
      phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: phoneNumber.smsUrl,
      configuredMethod,
    };
  }
  if (phoneNumber.smsUrl !== account.publicWebhookUrl) {
    return {
      status: "url-mismatch",
      phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
      expectedUrl: account.publicWebhookUrl,
      configuredUrl: phoneNumber.smsUrl,
      configuredMethod,
    };
  }
  return {
    status: "matches",
    phoneNumber: phoneNumber.phoneNumber || account.fromNumber,
    expectedUrl: account.publicWebhookUrl,
    configuredUrl: phoneNumber.smsUrl,
    configuredMethod,
    voiceUrl: phoneNumber.voiceUrl,
  };
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
    from: message.from,
    to: message.to,
    errorCode: message.errorCode,
    dateCreated: message.dateCreated,
    dateSent: message.dateSent,
  };
}

function webhookError(probe: SmsTwilioWebhookProbe): string | undefined {
  switch (probe.status) {
    case "matches":
    case "skipped":
      return undefined;
    case "number-not-found":
      return `Twilio account does not list ${probe.expectedNumber} as an incoming phone number.`;
    case "missing":
      return `Twilio number ${probe.phoneNumber} has no SMS webhook URL configured.`;
    case "method-mismatch":
      return `Twilio number ${probe.phoneNumber} uses ${probe.configuredMethod || "an unknown method"} for SMS webhooks; use POST.`;
    case "url-mismatch":
      return `Twilio number ${probe.phoneNumber} points SMS webhooks at ${probe.configuredUrl}; expected ${probe.expectedUrl}.`;
  }
}

export async function probeSmsAccount(params: {
  account: ResolvedSmsAccount;
  timeoutMs: number;
  options?: ProbeOptions;
}): Promise<SmsProbe> {
  const hints: string[] = [];
  addTailscaleHint(params.account, hints);
  const phoneNumbers = params.account.fromNumber
    ? await listTwilioIncomingPhoneNumbers({
        account: params.account,
        phoneNumber: params.account.fromNumber,
        fetchImpl: params.options?.fetchImpl,
        timeoutMs: params.timeoutMs,
      })
    : [];
  const webhook = compareTwilioWebhook(params.account, phoneNumbers[0]);
  const messages = params.account.fromNumber
    ? await listTwilioMessages({
        account: params.account,
        to: params.account.fromNumber,
        pageSize: 3,
        fetchImpl: params.options?.fetchImpl,
        timeoutMs: params.timeoutMs,
      })
    : [];
  const recentInbound = recentInboundSummary(messages);
  if (recentInbound?.errorCode === TWILIO_ERROR_WEBHOOK_REACHABILITY) {
    hints.push(
      "Twilio error 11200 means Twilio could not reach the SMS webhook. Check the public URL, tunnel/Funnel route, and Twilio Messaging webhook method.",
    );
  }
  const error =
    webhookError(webhook) ??
    (recentInbound?.errorCode === TWILIO_ERROR_WEBHOOK_REACHABILITY
      ? `Recent inbound SMS ${recentInbound.sid} has Twilio error 11200.`
      : undefined);
  return {
    ok: !error,
    ...(error ? { error } : {}),
    webhook,
    ...(recentInbound ? { recentInbound } : {}),
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
    lines.push({ text: "Probe: ok", tone: "success" });
  } else if (smsProbe.ok === false) {
    lines.push({
      text: `Probe: failed${smsProbe.error ? ` (${smsProbe.error})` : ""}`,
      tone: "error",
    });
  }
  if (smsProbe.webhook?.status === "matches") {
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
  for (const hint of smsProbe.hints ?? []) {
    lines.push({ text: hint, tone: "warn" });
  }
  return lines;
}
