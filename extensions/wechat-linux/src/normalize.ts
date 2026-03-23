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

type WechatLinuxUpstreamMediaUnderstanding = {
  kind: "audio.transcription" | "image.description" | "video.description";
  attachmentIndex: number;
  text: string;
  provider: string;
};

const GENERIC_MEDIA_CONTENT_RE =
  /^(图片|视频|语音|文件|链接|image|video|voice|file|link)(?:\s+\d+\s*s)?$/iu;
const UPSTREAM_PROVIDER = "wechat-linux";

function trimText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeTextList(values?: readonly string[]): string[] {
  return Array.from(new Set((values ?? []).map((value) => value.trim()).filter(Boolean)));
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

function resolveWechatLinuxTypeLabel(message: BridgeMessage): string {
  return (
    trimText(message.type_label) ||
    (message.normalized_kind && message.normalized_kind !== "skip" ? message.normalized_kind : "")
  );
}

function hasVisibleWechatLinuxTypeLabel(typeLabel: string): boolean {
  return Boolean(typeLabel && typeLabel !== "text" && typeLabel !== "普通文本");
}

function isWechatLinuxDocumentReady(document: Record<string, unknown>): boolean {
  const status = trimText(document.status);
  if (status !== "ok") {
    return false;
  }
  return Boolean(
    trimText(document.summary) || trimText(document.title) || trimText(document.doc_path),
  );
}

function resolveWechatLinuxFallbackContent(message: BridgeMessage): string {
  const details = (message.details ?? {}) as Record<string, unknown>;
  return (
    trimText(details.preview) ||
    trimText(details.description) ||
    trimText(details.summary) ||
    trimText(message.raw_xml)
  );
}

function isMeaningfulWechatLinuxContent(params: {
  content: string;
  typeLabel: string;
  analysisText: string;
  transcript: string;
  documentTitle: string;
  documentSummary: string;
}): boolean {
  const content = params.content;
  if (!content) {
    return false;
  }
  if (GENERIC_MEDIA_CONTENT_RE.test(content)) {
    return false;
  }
  if (params.typeLabel && content === params.typeLabel) {
    return false;
  }
  if (params.analysisText && content === params.analysisText) {
    return false;
  }
  if (params.transcript && content === params.transcript) {
    return false;
  }
  if (params.documentTitle && content === params.documentTitle) {
    return false;
  }
  if (params.documentSummary && content === params.documentSummary) {
    return false;
  }
  return true;
}

function resolveWechatLinuxAttachmentIndex(
  message: BridgeMessage,
  mimePrefix: "audio/" | "image/" | "video/",
): number {
  const mediaTypes = message.media_types ?? [];
  for (const [index, value] of mediaTypes.entries()) {
    if (value.trim().toLowerCase().startsWith(mimePrefix)) {
      return index;
    }
  }
  return 0;
}

function resolveWechatLinuxAnalysisKind(
  message: BridgeMessage,
): "image.description" | "video.description" | undefined {
  const mediaTypes = (message.media_types ?? []).map((value) => value.trim().toLowerCase());
  if (message.base_type === 43 || message.normalized_kind === "video") {
    return "video.description";
  }
  if (message.base_type === 3 || message.normalized_kind === "image") {
    return "image.description";
  }
  if (mediaTypes.some((value) => value.startsWith("video/"))) {
    return "video.description";
  }
  if (mediaTypes.some((value) => value.startsWith("image/"))) {
    return "image.description";
  }
  return undefined;
}

export function buildWechatLinuxMediaUnderstanding(
  message: BridgeMessage,
): WechatLinuxUpstreamMediaUnderstanding[] {
  const outputs: WechatLinuxUpstreamMediaUnderstanding[] = [];
  const details = (message.details ?? {}) as Record<string, unknown>;
  const transcript = trimText(details.wechat_transcript);
  if (transcript) {
    outputs.push({
      kind: "audio.transcription",
      attachmentIndex: resolveWechatLinuxAttachmentIndex(message, "audio/"),
      text: transcript,
      provider: UPSTREAM_PROVIDER,
    });
  }

  const analysisText = trimText(message.analysis_text);
  const analysisKind = analysisText ? resolveWechatLinuxAnalysisKind(message) : undefined;
  if (analysisText && analysisKind) {
    outputs.push({
      kind: analysisKind,
      attachmentIndex: resolveWechatLinuxAttachmentIndex(
        message,
        analysisKind === "video.description" ? "video/" : "image/",
      ),
      text: analysisText,
      provider: UPSTREAM_PROVIDER,
    });
  }

  return outputs;
}

export function buildWechatLinuxLinkUnderstanding(message: BridgeMessage): string[] {
  const document = (message.document ?? {}) as Record<string, unknown>;
  if (!isWechatLinuxDocumentReady(document)) {
    return [];
  }

  const lines = ["[Link Document]"];
  const title = trimText(document.title);
  const summary = trimText(document.summary);
  if (title) {
    lines.push(`Title:\n${title}`);
  }
  if (summary) {
    lines.push(`Summary:\n${summary}`);
  }
  return [lines.join("\n")];
}

function buildWechatLinuxDetailedBody(
  message: BridgeMessage,
  opts: {
    includeDocumentPath: boolean;
    includeMediaPaths: boolean;
    includeRawUrls: boolean;
  },
): string {
  const content = trimText(message.content);
  const analysisText = trimText(message.analysis_text);
  const details = (message.details ?? {}) as Record<string, unknown>;
  const document = (message.document ?? {}) as Record<string, unknown>;
  const parts = [content];
  const contextBlocks: string[] = [];

  const typeLabel = resolveWechatLinuxTypeLabel(message);
  if (hasVisibleWechatLinuxTypeLabel(typeLabel)) {
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
  if (opts.includeRawUrls) {
    pushUniqueLine(contextBlocks, "链接", details.url);
  }

  const urlList = normalizeTextList(message.url_list ?? []);
  if (
    opts.includeRawUrls &&
    (urlList.length > 1 || (urlList.length === 1 && urlList[0] !== trimText(details.url)))
  ) {
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
  if (opts.includeDocumentPath && documentPath) {
    pushUniqueLine(contextBlocks, "文档路径", documentPath);
  }

  const mediaPaths = normalizeTextList(message.media_paths ?? []);
  if (opts.includeMediaPaths && mediaPaths.length > 0) {
    pushUniqueBlock(contextBlocks, "附件路径", mediaPaths);
  }

  const fallbackContent = resolveWechatLinuxFallbackContent(message);
  if (!parts[0] && fallbackContent) {
    parts[0] = fallbackContent;
  }

  return [...parts.filter(Boolean), ...contextBlocks].join("\n\n").trim();
}

export function buildWechatLinuxBodyForSearch(message: BridgeMessage): string {
  return buildWechatLinuxDetailedBody(message, {
    includeDocumentPath: true,
    includeMediaPaths: true,
    includeRawUrls: true,
  });
}

export function buildWechatLinuxBodyForAgent(message: BridgeMessage): string {
  const content = trimText(message.content);
  const analysisText = trimText(message.analysis_text);
  const details = (message.details ?? {}) as Record<string, unknown>;
  const document = (message.document ?? {}) as Record<string, unknown>;
  const typeLabel = resolveWechatLinuxTypeLabel(message);
  const transcript = trimText(details.wechat_transcript);
  const detailTitle = trimText(details.title);
  const documentReady = isWechatLinuxDocumentReady(document);
  const documentTitle = trimText(document.title);
  const documentSummary = trimText(document.summary);
  const documentStatus = trimText(document.status);
  const meaningfulContent =
    content &&
    (content === analysisText ||
      content === transcript ||
      content === documentTitle ||
      content === documentSummary)
      ? content
      : isMeaningfulWechatLinuxContent({
            content,
            typeLabel,
            analysisText,
            transcript,
            documentTitle,
            documentSummary,
          })
        ? content
        : "";
  const parts = meaningfulContent ? [meaningfulContent] : [];
  const contextBlocks: string[] = [];

  if (hasVisibleWechatLinuxTypeLabel(typeLabel)) {
    pushUniqueLine(contextBlocks, "消息类型", typeLabel);
  }
  if (analysisText && analysisText !== meaningfulContent) {
    pushUniqueLine(contextBlocks, "分析", analysisText);
  }
  if (transcript && transcript !== meaningfulContent && transcript !== analysisText) {
    pushUniqueLine(contextBlocks, "语音转写", transcript);
  }
  pushUniqueLine(contextBlocks, "转写来源", details.transcript_source);
  pushUniqueLine(contextBlocks, "转写错误", details.asr_error);

  if (documentStatus && documentStatus !== "skip" && documentStatus !== "ok") {
    pushUniqueLine(contextBlocks, "文档状态", documentStatus);
  }
  if (documentReady) {
    if (documentTitle && documentTitle !== detailTitle && documentTitle !== meaningfulContent) {
      pushUniqueLine(contextBlocks, "文档标题", documentTitle);
    }
    if (
      documentSummary &&
      documentSummary !== meaningfulContent &&
      documentSummary !== analysisText &&
      documentSummary !== transcript
    ) {
      pushUniqueLine(contextBlocks, "文档摘要", documentSummary);
    }
  } else {
    if (detailTitle && detailTitle !== meaningfulContent) {
      pushUniqueLine(contextBlocks, "标题", detailTitle);
    }
    pushUniqueLine(contextBlocks, "来源", details.source_display_name);
    pushUniqueLine(contextBlocks, "文件名", details.file_name);
    pushUniqueLine(contextBlocks, "文件大小", details.size_human);
    pushUniqueLine(contextBlocks, "链接", details.url);
    const urlList = normalizeTextList(message.url_list ?? []);
    if (urlList.length > 1 || (urlList.length === 1 && urlList[0] !== trimText(details.url))) {
      pushUniqueBlock(contextBlocks, "链接列表", urlList);
    }
  }

  const hasSuccessfulPreprocess = Boolean(analysisText || transcript || documentReady);
  if (!hasSuccessfulPreprocess) {
    const mediaPaths = normalizeTextList(message.media_paths ?? []);
    if (mediaPaths.length > 0) {
      pushUniqueBlock(contextBlocks, "附件路径", mediaPaths);
    }
  }

  const fallbackContent = resolveWechatLinuxFallbackContent(message);
  if (parts.length === 0 && fallbackContent) {
    parts.push(fallbackContent);
  }

  return [...parts, ...contextBlocks].filter(Boolean).join("\n\n").trim();
}
