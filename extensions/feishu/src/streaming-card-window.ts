/**
 * Feishu closes a card's streaming_mode ten minutes after it was switched on:
 * the next element write fails with code=200850, every later one with 300309.
 * Toggling streaming_mode off and on again restarts that window, even after the
 * server already closed it; a full-card update needs no streaming_mode at all.
 */

import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveFeishuCardTemplate } from "./native-card.js";
import type { CardHeaderConfig } from "./send.js";

export const STREAMING_WINDOW_RENEW_MS = 8 * 60 * 1000;
const STREAMING_WINDOW_CLOSED_CODES = new Set([200850, 300309]);

export function isStreamingWindowClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = /\(code=(\d+)\)$/.exec(message);
  return match !== null && STREAMING_WINDOW_CLOSED_CODES.has(Number(match[1]));
}

export function truncateSummary(text: string, max = 50): string {
  if (!text) {
    return "";
  }
  const clean = text.replace(/\n/g, " ").trim();
  // Slice on a code-point boundary so CardKit never receives a lone surrogate at the limit.
  return clean.length <= max ? clean : sliceUtf16Safe(clean, 0, max - 3) + "...";
}

export function buildStreamingModeSettings(on: boolean): string {
  return JSON.stringify({ config: { streaming_mode: on } });
}

/** Complete card JSON for a full-card update once streaming is over. */
export function buildFinalCardJson(params: {
  text: string;
  note?: string;
  header?: CardHeaderConfig;
}): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    { tag: "markdown", content: params.text, element_id: "content" },
  ];
  if (params.note) {
    elements.push({ tag: "hr" });
    elements.push({
      tag: "markdown",
      content: `<font color='grey'>${params.note}</font>`,
      element_id: "note",
    });
  }
  const cardJson: Record<string, unknown> = {
    schema: "2.0",
    config: { streaming_mode: false, summary: { content: truncateSummary(params.text) } },
    body: { elements },
  };
  if (params.header) {
    cardJson.header = {
      title: { tag: "plain_text", content: params.header.title },
      template: resolveFeishuCardTemplate(params.header.template) ?? "blue",
    };
  }
  return cardJson;
}
