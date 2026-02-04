import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import type {
  DailyflowsOutboundPayload,
  DailyflowsOutboundResult,
} from "./types.js";
import { resolveDailyflowsAccount } from "./config.js";

type SendResult = {
  messageId?: string;
};

async function parseSendResult(res: Response): Promise<SendResult> {
  const text = await res.text();
  if (!text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text) as SendResult;
  } catch {
    return {};
  }
}

export async function sendDailyflowsMessage(params: {
  cfg: OpenClawConfig;
  payload: DailyflowsOutboundPayload;
}): Promise<DailyflowsOutboundResult> {
  const { cfg, payload } = params;
  const account = resolveDailyflowsAccount(cfg, payload.accountId);
  const messageId = payload.messageId ?? `oc_${randomUUID()}`;
  const resolvedPayload = { ...payload, messageId };
  if (!account.outboundUrl?.trim()) {
    throw new Error(
      `Dailyflows outboundUrl missing for account "${payload.accountId}". ` +
        "Set channels.dailyflows.accounts.<id>.outboundUrl",
    );
  }

  const res = await fetch(account.outboundUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(account.outboundToken
        ? { authorization: `Bearer ${account.outboundToken}` }
        : {}),
    },
    body: JSON.stringify(resolvedPayload),
  });

  if (!res.ok) {
    throw new Error(`Dailyflows outbound failed: ${res.status} ${res.statusText}`);
  }

  const result = await parseSendResult(res);

  return {
    channel: "dailyflows",
    messageId: result.messageId ?? "unknown",
    conversationId: payload.conversationId,
  };
}
