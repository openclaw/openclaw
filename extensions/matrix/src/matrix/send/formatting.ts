import { getMatrixRuntime } from "../../runtime.js";
import { markdownToMatrixHtml } from "../format.js";
import {
  MsgType,
  RelationType,
  type MatrixFormattedContent,
  type MatrixMediaMsgType,
  type MatrixRelation,
  type MatrixReplyRelation,
  type MatrixTextContent,
  type MatrixThreadRelation,
} from "./types.js";

const getCore = () => getMatrixRuntime();

export function buildTextContent(body: string, relation?: MatrixRelation): MatrixTextContent {
  const content: MatrixTextContent = relation
    ? {
        msgtype: MsgType.Text,
        body,
        "m.relates_to": relation,
      }
    : {
        msgtype: MsgType.Text,
        body,
      };
  applyMatrixFormatting(content, body);
  return content;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function extractMath(markdown: string): { text: string; blocks: string[]; inlines: string[] } {
  const blocks: string[] = [];
  const inlines: string[] = [];
  let text = markdown;

  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, latex) => {
    const id = blocks.length;
    blocks.push(String(latex));
    return `OC_MATH_BLOCK_${id}`;
  });

  text = text.replace(/(?<!\w)\$([^\n$]+?)\$(?!\w)/g, (_m, latex) => {
    const id = inlines.length;
    inlines.push(String(latex));
    return `OC_MATH_INLINE_${id}`;
  });

  return { text, blocks, inlines };
}

function injectMath(html: string, blocks: string[], inlines: string[]): string {
  let out = html;

  blocks.forEach((raw, i) => {
    const latex = raw.trim().replace(/\s+/g, " ");
    const attr = escapeHtml(latex);
    const code = escapeHtml(latex);

    out = out.replace(
      new RegExp(`<p>\\s*OC_MATH_BLOCK_${i}\\s*<\\/p>`, "g"),
      `<div data-mx-maths="${attr}"><code>${code}</code></div>`,
    );

    out = out.replaceAll(
      `OC_MATH_BLOCK_${i}`,
      `<span data-mx-maths="${attr}"><code>${code}</code></span>`,
    );
  });

  inlines.forEach((raw, i) => {
    const latex = raw.trim().replace(/\s+/g, " ");
    const attr = escapeHtml(latex);
    const code = escapeHtml(latex);

    out = out.replaceAll(
      `OC_MATH_INLINE_${i}`,
      `<span data-mx-maths="${attr}"><code>${code}</code></span>`,
    );
  });

  return out;
}

export function applyMatrixFormatting(content: MatrixFormattedContent, body: string): void {
  const { text, blocks, inlines } = extractMath(body ?? "");
  let formatted = markdownToMatrixHtml(text);
  if (!formatted) {
    return;
  }
  formatted = injectMath(formatted, blocks, inlines);
  content.format = "org.matrix.custom.html";
  content.formatted_body = formatted;
}

export function buildReplyRelation(replyToId?: string): MatrixReplyRelation | undefined {
  const trimmed = replyToId?.trim();
  if (!trimmed) {
    return undefined;
  }
  return { "m.in_reply_to": { event_id: trimmed } };
}

export function buildThreadRelation(threadId: string, replyToId?: string): MatrixThreadRelation {
  const trimmed = threadId.trim();
  return {
    rel_type: RelationType.Thread,
    event_id: trimmed,
    is_falling_back: true,
    "m.in_reply_to": { event_id: replyToId?.trim() || trimmed },
  };
}

export function resolveMatrixMsgType(contentType?: string, _fileName?: string): MatrixMediaMsgType {
  const kind = getCore().media.mediaKindFromMime(contentType ?? "");
  switch (kind) {
    case "image":
      return MsgType.Image;
    case "audio":
      return MsgType.Audio;
    case "video":
      return MsgType.Video;
    default:
      return MsgType.File;
  }
}

export function resolveMatrixVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string;
  fileName?: string;
}): { useVoice: boolean } {
  if (!opts.wantsVoice) {
    return { useVoice: false };
  }
  if (isMatrixVoiceCompatibleAudio(opts)) {
    return { useVoice: true };
  }
  return { useVoice: false };
}

function isMatrixVoiceCompatibleAudio(opts: { contentType?: string; fileName?: string }): boolean {
  // Matrix currently shares the core voice compatibility policy.
  // Keep this wrapper as the seam if Matrix policy diverges later.
  return getCore().media.isVoiceCompatibleAudio({
    contentType: opts.contentType,
    fileName: opts.fileName,
  });
}
