import type { BridgeMessage } from "./types.js";

const PROVIDER_PREFIX_RE = /^(wechat-linux|wechat):/i;
const DIRECT_PREFIX_RE = /^(user|dm|direct):/i;
const GROUP_PREFIX_RE = /^(group|room|chat):/i;

export function stripWechatLinuxTargetPrefix(raw: string): string {
  let target = raw.trim();
  if (!target) {
    return "";
  }
  target = target.replace(PROVIDER_PREFIX_RE, "").trim();
  return target;
}

export function parseWechatLinuxMessagingTarget(raw: string): {
  id: string;
  chatType?: "direct" | "group";
} | null {
  let target = stripWechatLinuxTargetPrefix(raw);
  if (!target) {
    return null;
  }

  let chatType: "direct" | "group" | undefined;
  if (GROUP_PREFIX_RE.test(target)) {
    chatType = "group";
    target = target.replace(GROUP_PREFIX_RE, "").trim();
  } else if (DIRECT_PREFIX_RE.test(target)) {
    chatType = "direct";
    target = target.replace(DIRECT_PREFIX_RE, "").trim();
  }

  if (!target) {
    return null;
  }

  if (!chatType) {
    if (target.endsWith("@chatroom")) {
      chatType = "group";
    } else if (/^(wxid_|gh_)/i.test(target)) {
      chatType = "direct";
    }
  }

  return { id: target, chatType };
}

export function normalizeWechatLinuxMessagingTarget(raw: string): string | undefined {
  const parsed = parseWechatLinuxMessagingTarget(raw);
  if (!parsed) {
    return undefined;
  }
  if (parsed.chatType === "group") {
    return `wechat-linux:group:${parsed.id}`;
  }
  if (parsed.chatType === "direct") {
    return `wechat-linux:user:${parsed.id}`;
  }
  return `wechat-linux:${parsed.id}`;
}

export function inferWechatLinuxTargetChatType(raw: string): "direct" | "group" | undefined {
  return parseWechatLinuxMessagingTarget(raw)?.chatType;
}

export function looksLikeWechatLinuxTargetId(raw: string): boolean {
  const parsed = parseWechatLinuxMessagingTarget(raw);
  if (!parsed) {
    return false;
  }
  return /^(wxid_|gh_)/i.test(parsed.id) || parsed.id.endsWith("@chatroom");
}

export function normalizeWechatLinuxAllowEntry(raw: string): string {
  const trimmed = stripWechatLinuxTargetPrefix(raw);
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed.replace(DIRECT_PREFIX_RE, "").trim().toLowerCase();
}

export function normalizeWechatLinuxAllowlist(values?: Array<string | number>): string[] {
  return (values ?? [])
    .map((value) => normalizeWechatLinuxAllowEntry(String(value)))
    .filter(Boolean);
}

export function resolveWechatLinuxAllowlistMatch(params: {
  allowFrom: string[];
  senderId: string;
}): { allowed: boolean; source?: string } {
  const allowFrom = new Set(
    params.allowFrom.map((value) => value.trim().toLowerCase()).filter(Boolean),
  );
  if (allowFrom.has("*")) {
    return { allowed: true, source: "*" };
  }
  const candidate = normalizeWechatLinuxAllowEntry(params.senderId);
  if (candidate && allowFrom.has(candidate)) {
    return { allowed: true, source: candidate };
  }
  return { allowed: false };
}

export function buildWechatLinuxOutboundTarget(raw: string): {
  id: string;
  chatType: "direct" | "group";
  to: string;
} | null {
  const parsed = parseWechatLinuxMessagingTarget(raw);
  if (!parsed) {
    return null;
  }
  const chatType = parsed.chatType ?? (parsed.id.endsWith("@chatroom") ? "group" : "direct");
  return {
    id: parsed.id,
    chatType,
    to: chatType === "group" ? `wechat-linux:group:${parsed.id}` : `wechat-linux:user:${parsed.id}`,
  };
}

export function buildWechatLinuxBodyForAgent(message: BridgeMessage): string {
  const parts = [message.content.trim()];
  const analysisText = message.analysis_text?.trim();
  if (analysisText && analysisText !== message.content.trim()) {
    parts.push(analysisText);
  }
  return parts.filter(Boolean).join("\n\n").trim();
}
