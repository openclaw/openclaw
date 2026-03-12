import { isAssistantEnabled, setAssistantEnabled } from "./features/assistant-toggle.js";
import {
  emitHandoffNotification,
  resolveHandoffTicketDelivery,
} from "./features/handoff-notify.js";
import {
  activateHandoffState,
  clearHandoffState,
  getHandoffState,
} from "./features/handoff-state.js";
import { getUsage, isUsageExceeded, recordUsage } from "./features/usage-limit.js";
import { isPairingAllowed } from "./pairing.js";
import { resolvePairedAgent, resolveUnpairedAgent } from "./routing.js";
import type { ResolvedWempAccount } from "./types.js";

export interface MinimalInboundEvent {
  openId: string;
  text: string;
  paired?: boolean;
}

export interface ParsedWechatMessage {
  toUserName: string;
  fromUserName: string;
  msgType: string;
  content?: string;
  msgId?: string;
  picUrl?: string;
  mediaId?: string;
  thumbMediaId?: string;
  format?: string;
  recognition?: string;
  title?: string;
  description?: string;
  url?: string;
  locationX?: string;
  locationY?: string;
  scale?: string;
  label?: string;
  poiName?: string;
  fileName?: string;
  event?: string;
  eventKey?: string;
  createTime?: string;
}

function extractTag(xml: string, tag: string): string {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]><\\/${tag}>`, "s").exec(xml)?.[1];
  if (typeof cdata === "string") return cdata;
  const text = new RegExp(`<${tag}>(.*?)<\\/${tag}>`, "s").exec(xml)?.[1];
  return text?.trim() || "";
}

export function parseWechatMessage(xml: string): ParsedWechatMessage {
  return {
    toUserName: extractTag(xml, "ToUserName"),
    fromUserName: extractTag(xml, "FromUserName"),
    msgType: extractTag(xml, "MsgType"),
    content: extractTag(xml, "Content") || undefined,
    msgId: extractTag(xml, "MsgId") || undefined,
    picUrl: extractTag(xml, "PicUrl") || undefined,
    mediaId: extractTag(xml, "MediaId") || undefined,
    thumbMediaId: extractTag(xml, "ThumbMediaId") || undefined,
    format: extractTag(xml, "Format") || undefined,
    recognition: extractTag(xml, "Recognition") || undefined,
    title: extractTag(xml, "Title") || undefined,
    description: extractTag(xml, "Description") || undefined,
    url: extractTag(xml, "Url") || undefined,
    locationX: extractTag(xml, "Location_X") || undefined,
    locationY: extractTag(xml, "Location_Y") || undefined,
    scale: extractTag(xml, "Scale") || undefined,
    label: extractTag(xml, "Label") || undefined,
    poiName: extractTag(xml, "Poiname") || undefined,
    fileName: extractTag(xml, "FileName") || undefined,
    event: extractTag(xml, "Event") || undefined,
    eventKey: extractTag(xml, "EventKey") || undefined,
    createTime: extractTag(xml, "CreateTime") || undefined,
  };
}

function normalizeDetail(value?: string): string | undefined {
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

function formatNormalizedMessage(
  type: string,
  fields: Array<[string, string | undefined]>,
): string {
  const details = fields.flatMap(([key, value]) => {
    const normalized = normalizeDetail(value);
    return normalized ? [`${key}=${normalized}`] : [];
  });
  return details.length ? `[${type}] ${details.join(" | ")}` : `[${type}]`;
}

export function normalizeInboundText(message: ParsedWechatMessage): string {
  if (message.msgType === "text") return message.content || "";
  if (message.msgType === "image")
    return `[image] ${message.picUrl || message.mediaId || ""}`.trim();
  if (message.msgType === "voice")
    return message.recognition || `[voice] ${message.mediaId || ""}`.trim();
  if (message.msgType === "location") {
    const locationX = normalizeDetail(message.locationX);
    const locationY = normalizeDetail(message.locationY);
    const coords = locationX && locationY ? `${locationX},${locationY}` : undefined;
    return formatNormalizedMessage("location", [
      ["label", message.label],
      ["poi", message.poiName],
      ["coords", coords],
      ["scale", message.scale],
    ]);
  }
  if (message.msgType === "link") {
    return formatNormalizedMessage("link", [
      ["title", message.title],
      ["desc", message.description],
      ["url", message.url],
    ]);
  }
  if (message.msgType === "video" || message.msgType === "shortvideo") {
    return formatNormalizedMessage(message.msgType, [
      ["title", message.title],
      ["desc", message.description],
      ["media", message.mediaId],
      ["thumb", message.thumbMediaId],
      ["url", message.url],
    ]);
  }
  if (message.msgType === "file") {
    return formatNormalizedMessage("file", [
      ["name", message.fileName || message.title],
      ["media", message.mediaId],
      ["url", message.url],
    ]);
  }
  if (message.msgType === "event")
    return `[event] ${(message.event || "unknown").toLowerCase()} ${message.eventKey || ""}`.trim();
  return `[${message.msgType || "unknown"}]`;
}

const CJK_CHAR_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/g;
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const MAX_INBOUND_TEXT_CHARS = 2_000;

export function sanitizeInboundUserText(text: string): string {
  return String(text || "")
    .replace(CONTROL_CHAR_RE, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_INBOUND_TEXT_CHARS);
}

export function estimateUsageTokens(text: string): number {
  const normalized = String(text || "").trim();
  if (!normalized) return 0;
  const byteTokens = Math.ceil(Buffer.byteLength(normalized, "utf8") / 4);
  const cjkCount = (normalized.match(CJK_CHAR_RE) || []).length;
  const cjkBonus = Math.ceil(cjkCount * 0.2);
  return Math.max(1, byteTokens + cjkBonus);
}

export function resolveInboundAgent(
  account: ResolvedWempAccount,
  event: MinimalInboundEvent,
): string {
  if (event.paired) return resolvePairedAgent(account);
  const resolved = resolveUnpairedAgent(account);
  const routeGuardEnabled = account.features.routeGuard?.enabled ?? true;
  if (!routeGuardEnabled) return resolved;

  const allowed = Array.isArray(account.features.routeGuard?.unpairedAllowedAgents)
    ? account.features.routeGuard.unpairedAllowedAgents
        .map((agent) => String(agent || "").trim())
        .filter(Boolean)
    : ["wemp-kf"];
  if (allowed.includes(resolved)) return resolved;
  return allowed[0] || "wemp-kf";
}

export async function handleInboundMessage(
  account: ResolvedWempAccount,
  event: MinimalInboundEvent,
): Promise<{
  agentId: string;
  text: string;
  paired: boolean;
  assistantEnabled: boolean;
  usageExceeded: boolean;
  usage: { messages: number; tokens: number; day: string };
}> {
  const inboundText = sanitizeInboundUserText(event.text);
  const paired =
    event.paired ??
    isPairingAllowed(account.dm.policy, account.dm.allowFrom, account.accountId, event.openId);
  const agentId = resolveInboundAgent(account, { ...event, paired });
  const assistantEnabled = paired ? true : isAssistantEnabled(account.accountId, event.openId);
  recordUsage(account.accountId, event.openId, estimateUsageTokens(inboundText));
  const usage = getUsage(account.accountId, event.openId);
  const usageExceeded =
    !paired || !account.features.usageLimit.exemptPaired
      ? Boolean(account.features.usageLimit.enabled) &&
        isUsageExceeded(account.accountId, event.openId, account.features.usageLimit)
      : false;
  return {
    agentId,
    text: inboundText,
    paired,
    assistantEnabled,
    usageExceeded,
    usage,
  };
}

export function handleSubscribeEvent(
  account: ResolvedWempAccount,
  openId: string,
): { replyText: string } {
  setAssistantEnabled(
    account.accountId,
    openId,
    account.features.assistantToggle.defaultEnabled === true,
  );
  return {
    replyText: account.features.welcome.enabled
      ? account.features.welcome.subscribeText ||
        "欢迎关注，AI 助手已开启。你可以直接发送问题，或先完成配对后接入主助手。"
      : "",
  };
}

export function handleUnsubscribeEvent(accountId: string, openId: string): { replyText: string } {
  setAssistantEnabled(accountId, openId, false);
  return { replyText: "" };
}

export function handleEventAction(
  account: ResolvedWempAccount,
  message: ParsedWechatMessage,
): { replyText?: string; handled: boolean } {
  const event = (message.event || "").toLowerCase();
  const eventKey = message.eventKey || "";
  if (event === "click" && eventKey === "handoff") {
    if (!account.features.handoff.enabled) {
      return { handled: true, replyText: "当前未开启人工接管功能。" };
    }
    const contact = account.features.handoff.contact || "人工客服";
    const text = (account.features.handoff.message || "如需人工支持，请联系：{{contact}}").replace(
      "{{contact}}",
      contact,
    );
    const autoResumeMinutes = Math.max(
      1,
      Math.floor(Number(account.features.handoff.autoResumeMinutes || 30)),
    );
    const now = Date.now();
    const state = activateHandoffState(
      account.accountId,
      message.fromUserName,
      autoResumeMinutes * 60_000,
    );
    const ticketDelivery = resolveHandoffTicketDelivery(
      "activated",
      account.features.handoff.ticketWebhook,
    );
    emitHandoffNotification({
      id: `activated:${account.accountId}:${message.fromUserName}:${now}`,
      type: "activated",
      accountId: account.accountId,
      openId: message.fromUserName,
      at: now,
      contact,
      expireAt: state.expireAt || undefined,
      reason: "click",
      ...(ticketDelivery ? { deliveries: { ticket: ticketDelivery } } : {}),
    });
    const remainMinutes = Math.max(
      1,
      Math.ceil(Math.max(0, (state.expireAt || Date.now()) - Date.now()) / 60_000),
    );
    return {
      handled: true,
      replyText: `${text}\n已进入人工接管模式（约 ${remainMinutes} 分钟后自动恢复 AI，可发送“恢复AI”立即恢复）。`,
    };
  }
  if (event === "click" && eventKey === "handoff_status") {
    const state = getHandoffState(account.accountId, message.fromUserName);
    if (!state.active) {
      return { handled: true, replyText: "当前状态：AI 自动回复中。" };
    }
    const remainMinutes = Math.max(
      1,
      Math.ceil(Math.max(0, (state.expireAt || Date.now()) - Date.now()) / 60_000),
    );
    return {
      handled: true,
      replyText: `当前状态：人工接管中（预计 ${remainMinutes} 分钟后自动恢复 AI）。`,
    };
  }
  if (event === "click" && eventKey === "handoff_resume") {
    const state = getHandoffState(account.accountId, message.fromUserName);
    clearHandoffState(account.accountId, message.fromUserName);
    if (state.active) {
      const now = Date.now();
      const ticketDelivery = resolveHandoffTicketDelivery(
        "resumed",
        account.features.handoff.ticketWebhook,
      );
      emitHandoffNotification({
        id: `resumed:${account.accountId}:${message.fromUserName}:${now}`,
        type: "resumed",
        accountId: account.accountId,
        openId: message.fromUserName,
        at: now,
        reason: "click",
        ...(ticketDelivery ? { deliveries: { ticket: ticketDelivery } } : {}),
      });
    }
    return { handled: true, replyText: "已恢复 AI 助手服务。" };
  }
  if (event === "click" && eventKey === "assistant_on") {
    setAssistantEnabled(account.accountId, message.fromUserName, true);
    return { handled: true, replyText: "AI 助手已开启。" };
  }
  if (event === "click" && eventKey === "assistant_off") {
    setAssistantEnabled(account.accountId, message.fromUserName, false);
    return { handled: true, replyText: "AI 助手已关闭。" };
  }
  if (event === "click" && eventKey === "assistant_status") {
    const enabled = isAssistantEnabled(account.accountId, message.fromUserName);
    return {
      handled: true,
      replyText: enabled ? "AI 助手当前状态：已开启。" : "AI 助手当前状态：已关闭。",
    };
  }
  if (event === "click" && eventKey === "usage_status") {
    const usage = getUsage(account.accountId, message.fromUserName);
    const msgLimit = Number(account.features.usageLimit.dailyMessages || 0);
    const tokenLimit = Number(account.features.usageLimit.dailyTokens || 0);
    const lines = [
      `今日消息数：${usage.messages}${msgLimit > 0 ? ` / ${msgLimit}` : ""}`,
      `今日 token 数：${usage.tokens}${tokenLimit > 0 ? ` / ${tokenLimit}` : ""}`,
    ];
    return { handled: true, replyText: lines.join("\n") };
  }
  return { handled: false };
}
