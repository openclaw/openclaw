/**
 * DingTalk reply implementation via sessionWebhook.
 */

import type { DingTalkActionCard } from "../types/channel-data.js";
import { chunkText, chunkMarkdownText, normalizeForTextMessage } from "./chunker.js";
import { convertMarkdownForDingTalk } from "./markdown.js";

export interface ReplyOptions {
  replyMode?: "text" | "markdown";
  maxChars?: number;
  tableMode?: "code" | "off";
  logger?: ReplyLogger;
}

export interface ReplyResult {
  ok: boolean;
  reason?: string;
  status?: number;
  data?: unknown;
  chunks?: number;
}

export interface ReplyLogger {
  debug?: (obj: Record<string, unknown>, msg?: string) => void;
  warn?: (obj: Record<string, unknown> | string, msg?: string) => void;
  error?: (obj: Record<string, unknown>, msg?: string) => void;
}

/**
 * Mask webhook URL for logging (hide query params).
 */
function maskWebhook(url: string): string {
  if (!url) {
    return "";
  }
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).slice(0, 64) + "...";
  }
}

/**
 * Send reply to DingTalk via sessionWebhook.
 * Automatically chunks long messages.
 */
export async function sendReplyViaSessionWebhook(
  sessionWebhook: string,
  text: string,
  options: ReplyOptions = {},
): Promise<ReplyResult> {
  const { replyMode = "text", maxChars = 1800, tableMode = "code", logger } = options;

  if (!sessionWebhook) {
    logger?.warn?.("No sessionWebhook, cannot reply");
    return { ok: false, reason: "missing_sessionWebhook" };
  }

  let processedText = text;
  if (replyMode === "markdown" && tableMode !== "off") {
    processedText = convertMarkdownForDingTalk(processedText, { tableMode });
  }

  const cleaned = normalizeForTextMessage(processedText);
  const chunks =
    replyMode === "markdown" ? chunkMarkdownText(cleaned, maxChars) : chunkText(cleaned, maxChars);

  for (let i = 0; i < chunks.length; i++) {
    const part = chunks[i];
    const payload =
      replyMode === "markdown"
        ? {
            msgtype: "markdown",
            markdown: {
              title: "OpenClaw",
              text: part,
            },
          }
        : {
            msgtype: "text",
            text: {
              content: part,
            },
          };

    try {
      const resp = await fetch(sessionWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        const data = await resp.text();
        logger?.error?.(
          {
            err: { message: `HTTP ${resp.status}`, status: resp.status, data },
            webhook: maskWebhook(sessionWebhook),
          },
          "Failed to reply DingTalk",
        );
        return { ok: false, reason: "http_error", status: resp.status, data };
      }

      logger?.debug?.(
        { webhook: maskWebhook(sessionWebhook), idx: i + 1, total: chunks.length },
        "Replied to DingTalk",
      );
    } catch (err) {
      const error = err as Error;
      logger?.error?.(
        { err: { message: error?.message }, webhook: maskWebhook(sessionWebhook) },
        "Failed to reply DingTalk",
      );
      return { ok: false, reason: "fetch_error" };
    }
  }

  return { ok: true, chunks: chunks.length };
}

/**
 * Send an image reply via sessionWebhook.
 */
export async function sendImageViaSessionWebhook(
  sessionWebhook: string,
  picUrl: string,
  options: { text?: string; logger?: ReplyLogger } = {},
): Promise<ReplyResult> {
  const { text, logger } = options;

  if (!sessionWebhook) {
    logger?.warn?.("No sessionWebhook, cannot reply");
    return { ok: false, reason: "missing_sessionWebhook" };
  }

  // DingTalk sessionWebhook uses "image" msgtype with picURL
  const payload = {
    msgtype: "image",
    image: {
      picURL: picUrl,
    },
  };

  try {
    const resp = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const data = await resp.text();
      logger?.error?.(
        {
          err: { message: `HTTP ${resp.status}`, status: resp.status, data },
          webhook: maskWebhook(sessionWebhook),
        },
        "Failed to send image to DingTalk",
      );
      return { ok: false, reason: "http_error", status: resp.status, data };
    }

    logger?.debug?.({ webhook: maskWebhook(sessionWebhook), picUrl }, "Sent image to DingTalk");

    // If there's accompanying text, send it after the image
    if (text?.trim()) {
      await sendReplyViaSessionWebhook(sessionWebhook, text, { logger });
    }

    return { ok: true };
  } catch (err) {
    const error = err as Error;
    logger?.error?.(
      { err: { message: error?.message }, webhook: maskWebhook(sessionWebhook) },
      "Failed to send image to DingTalk",
    );
    return { ok: false, reason: "fetch_error" };
  }
}

/**
 * Send an image reply via sessionWebhook using mediaId.
 * Use this when you have uploaded a file and have a mediaId.
 */
export async function sendImageWithMediaIdViaSessionWebhook(
  sessionWebhook: string,
  mediaId: string,
  options: { text?: string; logger?: ReplyLogger } = {},
): Promise<ReplyResult> {
  const { text, logger } = options;

  if (!sessionWebhook) {
    logger?.warn?.("No sessionWebhook, cannot reply");
    return { ok: false, reason: "missing_sessionWebhook" };
  }

  // DingTalk sessionWebhook uses "image" msgtype with media_id
  const payload = {
    msgtype: "image",
    image: {
      media_id: mediaId,
    },
  };

  try {
    const resp = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    // Read response body for both success and failure cases
    const respText = await resp.text();
    let respData: { errcode?: number; errmsg?: string } = {};
    try {
      respData = JSON.parse(respText);
    } catch {
      // Non-JSON response
    }

    if (!resp.ok) {
      logger?.error?.(
        {
          err: {
            message: `HTTP ${resp.status}`,
            status: resp.status,
            data: respText.slice(0, 500),
          },
          webhook: maskWebhook(sessionWebhook),
        },
        "Failed to send image (mediaId) to DingTalk",
      );
      return { ok: false, reason: "http_error", status: resp.status, data: respText };
    }

    // Check DingTalk API-level error (HTTP 200 but errcode != 0)
    if (respData.errcode !== undefined && respData.errcode !== 0) {
      logger?.error?.(
        {
          errcode: respData.errcode,
          errmsg: respData.errmsg,
          webhook: maskWebhook(sessionWebhook),
          mediaId,
        },
        "DingTalk API returned error for image send",
      );
      return { ok: false, reason: "api_error", status: resp.status, data: respData };
    }

    logger?.debug?.(
      { webhook: maskWebhook(sessionWebhook), mediaId, response: respText.slice(0, 200) },
      "Sent image (mediaId) to DingTalk",
    );

    // If there's accompanying text, send it after the image
    if (text?.trim()) {
      await sendReplyViaSessionWebhook(sessionWebhook, text, { logger });
    }

    return { ok: true };
  } catch (err) {
    const error = err as Error;
    logger?.error?.(
      { err: { message: error?.message }, webhook: maskWebhook(sessionWebhook) },
      "Failed to send image (mediaId) to DingTalk",
    );
    return { ok: false, reason: "fetch_error" };
  }
}

/**
 * Send an ActionCard reply via sessionWebhook.
 */
export async function sendActionCardViaSessionWebhook(
  sessionWebhook: string,
  actionCard: DingTalkActionCard,
  options: { logger?: ReplyLogger } = {},
): Promise<ReplyResult> {
  const { logger } = options;

  if (!sessionWebhook) {
    logger?.warn?.("No sessionWebhook, cannot reply");
    return { ok: false, reason: "missing_sessionWebhook" };
  }

  // Build ActionCard payload for sessionWebhook
  // DingTalk sessionWebhook uses different format than proactive API
  let payload: Record<string, unknown>;

  if (actionCard.buttons && actionCard.buttons.length >= 2) {
    // Multi-button ActionCard
    payload = {
      msgtype: "actionCard",
      actionCard: {
        title: actionCard.title,
        text: actionCard.text,
        btnOrientation: actionCard.btnOrientation ?? "0",
        btns: actionCard.buttons.map((btn) => ({
          title: btn.title,
          actionURL: btn.actionURL,
        })),
      },
    };
  } else {
    // Single-button ActionCard
    payload = {
      msgtype: "actionCard",
      actionCard: {
        title: actionCard.title,
        text: actionCard.text,
        singleTitle: actionCard.singleTitle ?? "查看详情",
        singleURL: actionCard.singleURL ?? "",
      },
    };
  }

  try {
    const resp = await fetch(sessionWebhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      const data = await resp.text();
      logger?.error?.(
        {
          err: { message: `HTTP ${resp.status}`, status: resp.status, data },
          webhook: maskWebhook(sessionWebhook),
        },
        "Failed to send ActionCard to DingTalk",
      );
      return { ok: false, reason: "http_error", status: resp.status, data };
    }

    logger?.debug?.(
      { webhook: maskWebhook(sessionWebhook), title: actionCard.title },
      "Sent ActionCard to DingTalk",
    );

    return { ok: true };
  } catch (err) {
    const error = err as Error;
    logger?.error?.(
      { err: { message: error?.message }, webhook: maskWebhook(sessionWebhook) },
      "Failed to send ActionCard to DingTalk",
    );
    return { ok: false, reason: "fetch_error" };
  }
}

/**
 * Response prefix template variable pattern.
 */
const TEMPLATE_VAR_PATTERN = /\{([a-zA-Z][a-zA-Z0-9.]*)\}/g;

/**
 * Resolve response prefix template with model context.
 */
export function resolveResponsePrefix(
  template: string | undefined,
  context: { model?: string; provider?: string; identity?: string },
): string | undefined {
  if (template === undefined || template === null) {
    return undefined;
  }

  return template.replace(TEMPLATE_VAR_PATTERN, (match, varName: string) => {
    const normalized = varName.toLowerCase();
    switch (normalized) {
      case "model":
        return context.model ?? match;
      case "provider":
        return context.provider ?? match;
      case "identity":
        return context.identity ?? match;
      default:
        return match;
    }
  });
}
