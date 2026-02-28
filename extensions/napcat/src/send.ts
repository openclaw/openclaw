import type { OneBotApiResponse, ResolvedNapCatAccount } from "./types.js";
import { parseNapCatTarget, type ParsedNapCatTarget } from "./targets.js";

function normalizeApiPath(base: string, action: string): string {
  return `${base.replace(/\/+$/g, "")}/${action.replace(/^\/+/g, "")}`;
}

function toOneBotId(value: string): number | string {
  if (!/^\d+$/.test(value)) {
    return value;
  }
  const asNumber = Number(value);
  if (Number.isSafeInteger(asNumber)) {
    return asNumber;
  }
  return value;
}

function parseMessageId(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

async function callNapCatAction<T = Record<string, unknown>>(params: {
  account: ResolvedNapCatAccount;
  action: string;
  payload: Record<string, unknown>;
}): Promise<OneBotApiResponse<T>> {
  if (!params.account.apiBaseUrl) {
    throw new Error("NapCat apiBaseUrl is not configured");
  }
  if (!params.account.token) {
    throw new Error("NapCat token is not configured");
  }

  const response = await fetch(normalizeApiPath(params.account.apiBaseUrl, params.action), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.account.token}`,
      "x-access-token": params.account.token,
    },
    body: JSON.stringify(params.payload),
  });

  const body = (await response.json().catch(() => ({}))) as OneBotApiResponse<T>;
  const retcode = typeof body.retcode === "number" ? body.retcode : undefined;
  const status = typeof body.status === "string" ? body.status.toLowerCase() : "";

  if (!response.ok || status === "failed" || (retcode !== undefined && retcode !== 0)) {
    const detail = body.wording || body.msg || response.statusText || "unknown error";
    throw new Error(`NapCat action ${params.action} failed (${response.status}): ${detail}`);
  }

  return body;
}

function buildMessagePayload(params: {
  text?: string;
  mediaUrl?: string;
  replyToId?: string | null;
}): string | Array<{ type: string; data: Record<string, string> }> {
  const text = params.text?.trim() ?? "";
  const mediaUrl = params.mediaUrl?.trim();
  const replyToId = params.replyToId?.trim();

  if (!mediaUrl && !replyToId) {
    return text;
  }

  const message: Array<{ type: string; data: Record<string, string> }> = [];
  if (replyToId) {
    message.push({ type: "reply", data: { id: replyToId } });
  }
  if (text) {
    message.push({ type: "text", data: { text } });
  }
  if (mediaUrl) {
    message.push({ type: "image", data: { file: mediaUrl } });
  }
  return message;
}

async function sendWithTarget(params: {
  account: ResolvedNapCatAccount;
  target: ParsedNapCatTarget;
  text?: string;
  mediaUrl?: string;
  replyToId?: string | null;
}): Promise<{ messageId: string }> {
  const action = params.target.kind === "group" ? "send_group_msg" : "send_private_msg";
  const targetKey = params.target.kind === "group" ? "group_id" : "user_id";
  const payload = {
    [targetKey]: toOneBotId(params.target.id),
    message: buildMessagePayload({
      text: params.text,
      mediaUrl: params.mediaUrl,
      replyToId: params.replyToId,
    }),
  };
  const result = await callNapCatAction<{ message_id?: string | number }>({
    account: params.account,
    action,
    payload,
  });
  return { messageId: parseMessageId(result.data?.message_id) };
}

export async function sendNapCatText(params: {
  account: ResolvedNapCatAccount;
  to: string;
  text: string;
  replyToId?: string | null;
}): Promise<{ messageId: string; target: ParsedNapCatTarget }> {
  const target = parseNapCatTarget(params.to);
  if (!target) {
    throw new Error(`Invalid NapCat target: ${params.to}`);
  }
  const sent = await sendWithTarget({
    account: params.account,
    target,
    text: params.text,
    replyToId: params.replyToId,
  });
  return { messageId: sent.messageId, target };
}

export async function sendNapCatMedia(params: {
  account: ResolvedNapCatAccount;
  to: string;
  mediaUrl: string;
  caption?: string;
  replyToId?: string | null;
}): Promise<{ messageId: string; target: ParsedNapCatTarget }> {
  const target = parseNapCatTarget(params.to);
  if (!target) {
    throw new Error(`Invalid NapCat target: ${params.to}`);
  }
  const sent = await sendWithTarget({
    account: params.account,
    target,
    text: params.caption,
    mediaUrl: params.mediaUrl,
    replyToId: params.replyToId,
  });
  return { messageId: sent.messageId, target };
}
