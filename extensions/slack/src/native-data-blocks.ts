// Shared detection and text fallback for Slack's native chart and table blocks.
import { hasSlackDataTableBlock, renderSlackDataTableMrkdwnFallbackText } from "./data-table.js";
import {
  hasSlackDataVisualizationBlock,
  renderSlackDataVisualizationMrkdwnFallbackText,
} from "./data-visualization.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Detect a native Slack chart or table block. */
export function hasSlackNativeDataBlock(blocks?: readonly unknown[]): boolean {
  return hasSlackDataVisualizationBlock(blocks) || hasSlackDataTableBlock(blocks);
}

/** Match Slack's Web API and response_url `invalid_blocks` error shapes. */
export function isSlackInvalidBlocksError(error: unknown): boolean {
  const record = asRecord(error);
  const rawData = record?.data;
  const data = asRecord(rawData);
  const rawResponseData = asRecord(record?.response)?.data;
  const responseData = asRecord(rawResponseData);
  const code =
    data?.error ??
    (typeof rawData === "string" ? rawData : undefined) ??
    responseData?.error ??
    (typeof rawResponseData === "string" ? rawResponseData : undefined) ??
    record?.error;
  return typeof code === "string" && code.trim().toLowerCase() === "invalid_blocks";
}

/** Extract a complete accessible summary from a supported native data block. */
export function renderSlackNativeDataFallbackText(value: unknown): string | undefined {
  const type = asRecord(value)?.type;
  if (type === "data_visualization") {
    return renderSlackDataVisualizationMrkdwnFallbackText(value);
  }
  if (type === "data_table") {
    return renderSlackDataTableMrkdwnFallbackText(value);
  }
  return undefined;
}

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Preserve every native data block's content once when Slack requires a text-only retry. */
export function appendSlackNativeDataFallbackText(
  text: string,
  blocks?: readonly unknown[],
): string {
  const base = text.trim();
  const comparableBase = comparableText(base);
  const seen = new Set<string>();
  const dataTexts: string[] = [];
  for (const block of blocks ?? []) {
    const dataText = renderSlackNativeDataFallbackText(block);
    if (!dataText) {
      continue;
    }
    const comparable = comparableText(dataText);
    if (!comparable || comparableBase.includes(comparable) || seen.has(comparable)) {
      continue;
    }
    seen.add(comparable);
    dataTexts.push(dataText);
  }
  return [base, ...dataTexts].filter(Boolean).join("\n\n");
}
