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

function trimText(value: unknown): string {
  return String(value ?? "").trim();
}

function pushUniqueLine(target: string[], label: string, value: unknown) {
  const text = trimText(value);
  if (!text) {
    return;
  }
  const line = `${label}: ${text}`;
  if (!target.includes(line)) {
    target.push(line);
  }
}

function pushUniqueBlock(target: string[], label: string, values: string[]) {
  const normalized = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  if (normalized.length === 0) {
    return;
  }
  const block = `${label}:\n${normalized.map((value) => `- ${value}`).join("\n")}`;
  if (!target.includes(block)) {
    target.push(block);
  }
}

export function buildWechatLinuxBodyForAgent(message: BridgeMessage): string {
  const content = trimText(message.content);
  const analysisText = trimText(message.analysis_text);
  const details = (message.details ?? {}) as Record<string, unknown>;
  const document = (message.document ?? {}) as Record<string, unknown>;
  const parts = [content];
  const contextBlocks: string[] = [];

  const typeLabel =
    trimText(message.type_label) ||
    (message.normalized_kind && message.normalized_kind !== "skip" ? message.normalized_kind : "");
  if (typeLabel && typeLabel !== "text" && typeLabel !== "普通文本") {
    pushUniqueLine(contextBlocks, "消息类型", typeLabel);
  }

  if (analysisText && analysisText !== content) {
    pushUniqueLine(contextBlocks, "分析", analysisText);
  }

  const wechatTranscript = trimText(details.wechat_transcript);
  if (wechatTranscript && wechatTranscript !== content && wechatTranscript !== analysisText) {
    pushUniqueLine(contextBlocks, "语音转写", wechatTranscript);
  }
  pushUniqueLine(contextBlocks, "转写来源", details.transcript_source);
  pushUniqueLine(contextBlocks, "转写错误", details.asr_error);

  const detailTitle = trimText(details.title);
  if (detailTitle && detailTitle !== content) {
    pushUniqueLine(contextBlocks, "标题", detailTitle);
  }
  pushUniqueLine(contextBlocks, "来源", details.source_display_name);
  pushUniqueLine(contextBlocks, "文件名", details.file_name);
  pushUniqueLine(contextBlocks, "文件大小", details.size_human);
  pushUniqueLine(contextBlocks, "链接", details.url);

  const urlList = Array.from(
    new Set((message.url_list ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  if (urlList.length > 1 || (urlList.length === 1 && urlList[0] !== trimText(details.url))) {
    pushUniqueBlock(contextBlocks, "链接列表", urlList);
  }

  const documentTitle = trimText(document.title);
  const documentSummary = trimText(document.summary);
  const documentPath = trimText(document.doc_path);
  const documentStatus = trimText(document.status);
  if (documentStatus && documentStatus !== "skip") {
    pushUniqueLine(contextBlocks, "文档状态", documentStatus);
  }
  if (documentTitle && documentTitle !== detailTitle) {
    pushUniqueLine(contextBlocks, "文档标题", documentTitle);
  }
  if (documentSummary && documentSummary !== content && documentSummary !== analysisText) {
    pushUniqueLine(contextBlocks, "文档摘要", documentSummary);
  }
  if (documentPath) {
    pushUniqueLine(contextBlocks, "文档路径", documentPath);
  }

  const mediaPaths = Array.from(
    new Set((message.media_paths ?? []).map((value) => value.trim()).filter(Boolean)),
  );
  if (mediaPaths.length > 0) {
    pushUniqueBlock(contextBlocks, "附件路径", mediaPaths);
  }

  const fallbackContent =
    trimText(details.preview) ||
    trimText(details.description) ||
    trimText(details.summary) ||
    trimText(message.raw_xml);
  if (!parts[0] && fallbackContent) {
    parts[0] = fallbackContent;
  }

  return [...parts.filter(Boolean), ...contextBlocks].join("\n\n").trim();
}
