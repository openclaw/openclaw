import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function neutralizeDiscordApprovalMentions(value: string): string {
  return value
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@/g, "<@\u200b")
    .replace(/<#/g, "<#\u200b");
}

export function normalizeDiscordApprovalPayload<
  T extends {
    text?: string;
    channelData?: unknown;
  },
>(payload: T): T {
  if (!asOptionalRecord(payload.channelData)?.execApproval || !payload.text) {
    return payload;
  }
  return { ...payload, text: neutralizeDiscordApprovalMentions(payload.text) };
}
