// Telegram progress-draft formatting and HTML preview rendering.
import type { ChannelProgressDraftCompositorLine } from "openclaw/plugin-sdk/channel-outbound";
import type { TelegramDraftPreview } from "./draft-stream.js";
import { renderTelegramHtmlText } from "./format.js";
import { buildTelegramRichHtml } from "./rich-message.js";
import { clipTelegramProgressText } from "./truncate.js";

function sanitizeProgressMarkdownText(text: string): string {
  return text.replaceAll("`", "'");
}

function formatProgressAsMarkdownCode(text: string): string {
  const clipped = clipTelegramProgressText(text);
  return `\`${sanitizeProgressMarkdownText(clipped)}\``;
}

export function formatTelegramProgressLine(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith("_") && trimmed.endsWith("_")
    ? trimmed
    : formatProgressAsMarkdownCode(text);
}

function escapeTelegramProgressHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderTelegramProgressStringLine(text: string): string {
  // Reasoning/commentary lanes carry model-authored markdown (e.g. `**bold**`,
  // inline `` `code` ``, `_italic_` reasoning behind a 🧠/💬 marker). Render it
  // through renderTelegramHtmlText — the parse_mode=HTML-safe converter — NOT
  // markdownToTelegramRichHtml, whose rich-only block output (<h2> from a
  // setext heading, <hr>, lists) makes Telegram reject the edit and drops the
  // whole preview to unformatted plain text. Callers convert ONE line at a
  // time, which also keeps block markdown from forming (`---` under a
  // paragraph is a setext heading only when they share a document).
  const trimmed = text.trim();
  // Clip INSIDE a whole-line `_…_` wrapper (the reasoning-lane contract, marker
  // optional): clipping the assembled line chops the closing underscore, which
  // silently degrades every long reasoning line from italic to plain text.
  const italic = trimmed.match(/^(\S+ )?_(.*)_$/u);
  const clipped = italic
    ? `${italic[1] ?? ""}_${clipTelegramProgressText(italic[2] ?? "")}_`
    : clipTelegramProgressText(trimmed);
  return renderTelegramHtmlText(clipped);
}

function renderTelegramProgressLine(line: ChannelProgressDraftCompositorLine): string {
  if (typeof line === "string") {
    return line.split(/\r?\n/u).map(renderTelegramProgressStringLine).filter(Boolean).join("<br>");
  }
  if (!line.icon && line.label === "Commentary") {
    // Commentary is model prose behind a 💬 marker: render its markdown (plain
    // unless the model emphasized) via the shared converter — distinct from the
    // 🧠 italic reasoning lane, mirroring Discord. Multi-line notes keep their
    // line structure (Discord parity); converting per line also prevents block
    // markdown (setext headings) from forming across lines.
    return line.text
      .split(/\r?\n/u)
      .map(renderTelegramProgressStringLine)
      .filter(Boolean)
      .join("<br>");
  }
  const label = [line.icon, line.label].filter(Boolean).join(" ");
  const parts = [`<b>${escapeTelegramProgressHtml(label)}</b>`];
  const detail = line.detail && line.detail !== line.label ? line.detail : undefined;
  if (detail) {
    parts.push(`<code>${escapeTelegramProgressHtml(clipTelegramProgressText(detail))}</code>`);
  } else {
    const text = line.text.trim();
    if (text && text !== label) {
      // Generic item payload (e.g. an "Update" line) keeps the monospace payload
      // styling shared with tool details; only the reasoning/commentary lanes
      // carry model markdown that needs converting.
      parts.push(`<code>${escapeTelegramProgressHtml(clipTelegramProgressText(text))}</code>`);
    }
  }
  if (line.status && line.status !== "completed" && line.status !== line.detail) {
    parts.push(`<i>${escapeTelegramProgressHtml(line.status)}</i>`);
  }
  return parts.join(" ");
}

export function renderTelegramProgressDraftPreview(
  text: string,
  lines: readonly ChannelProgressDraftCompositorLine[],
  richMessages: boolean,
  statusHeadlineActive = false,
): TelegramDraftPreview {
  const trimmed = text.trimEnd();
  if (statusHeadlineActive) {
    const statusLines = trimmed
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const html =
      statusLines.length > 1
        ? [
            `<b>${escapeTelegramProgressHtml(statusLines[0] ?? "")}</b>`,
            ...statusLines.slice(1).map(renderTelegramProgressStringLine),
          ].join("<br>")
        : statusLines.map(renderTelegramProgressStringLine).join("<br>");
    if (!richMessages) {
      return { text: html, parseMode: "HTML" };
    }
    return {
      text: trimmed,
      richMessage: buildTelegramRichHtml(html, { skipEntityDetection: true }),
    };
  }
  const renderedLines = lines.map(renderTelegramProgressLine).filter(Boolean);
  const textLines = trimmed
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const heading = textLines.length > renderedLines.length ? textLines[0] : undefined;
  const htmlParts = heading
    ? [`<b>${escapeTelegramProgressHtml(heading)}</b>`, ...renderedLines]
    : renderedLines;
  const html = htmlParts.join("<br>");
  if (!richMessages) {
    return { text: html, parseMode: "HTML" };
  }
  return {
    text: trimmed,
    richMessage: buildTelegramRichHtml(html, { skipEntityDetection: true }),
  };
}
