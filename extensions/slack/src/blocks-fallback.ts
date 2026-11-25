import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  renderSlackDataTableCompactPlainTextFallback,
  renderSlackDataTableFallbackText,
  renderSlackTableFallbackText,
} from "./data-table.js";
import { renderSlackDataVisualizationFallbackText } from "./data-visualization.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { renderSlackRichText } from "./rich-text.js";

type SlackNativeDataFallbackFormat = "plain" | "mrkdwn-safe";

type RenderSlackBlockFallbackOptions = {
  includeSelectOptions?: boolean;
  nativeDataFormat?: SlackNativeDataFallbackFormat;
  nativeReferenceFormat?: SlackNativeDataFallbackFormat;
};

const SLACK_SELECT_ELEMENT_TYPES = new Set([
  "static_select",
  "multi_static_select",
  "external_select",
  "multi_external_select",
  "users_select",
  "multi_users_select",
  "conversations_select",
  "multi_conversations_select",
  "channels_select",
  "multi_channels_select",
]);

function readTextObject(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const record = asOptionalRecord(value);
  const text = normalizeOptionalString(record?.text);
  if (!text) {
    return undefined;
  }
  return record?.type === "plain_text" && options.nativeDataFormat !== "plain"
    ? escapeSlackMrkdwn(text)
    : text;
}

function readAltText(value: unknown): string | undefined {
  const text = normalizeOptionalString(value);
  return text ? escapeSlackMrkdwn(text) : undefined;
}

function readControlElementText(
  value: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const element = asOptionalRecord(value);
  const type = normalizeOptionalString(element?.type);
  if (type === "button" || type === "workflow_button") {
    return normalizeOptionalString(element?.text) ?? readTextObject(element?.text, options);
  }
  if (type && (SLACK_SELECT_ELEMENT_TYPES.has(type) || type === "overflow")) {
    if (!options.includeSelectOptions) {
      return readTextObject(element?.placeholder, options);
    }
    const choices = Array.isArray(element?.options) ? element.options : [];
    return [
      readTextObject(element?.placeholder, options),
      ...choices.map((choice) => readTextObject(asOptionalRecord(choice)?.text, options)),
    ]
      .filter(Boolean)
      .join("\n");
  }
  return undefined;
}

/** Read only user-visible text from one Slack block. */
export function renderSlackBlockFallbackText(
  raw: unknown,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const block = asOptionalRecord(raw);
  if (!block) {
    return undefined;
  }
  switch (block.type) {
    case "rich_text":
      // Inbound references must survive for name resolution; literal text stays escaped
      // so token-shaped text cannot become a native mention. Outbound remains escaped.
      return normalizeOptionalString(
        renderSlackRichText(
          block.elements,
          options.nativeReferenceFormat === "plain" ? "native-reference" : "escaped",
          "\n",
        ),
      );
    case "header":
      return readTextObject(block.text, options);
    case "section":
    case "context": {
      const context = block.type === "context";
      const parts = context
        ? (Array.isArray(block.elements) ? block.elements : []).map((element) => {
            const record = asOptionalRecord(element);
            return readTextObject(record, options) ?? readAltText(record?.alt_text);
          })
        : [
            readTextObject(block.text, options),
            ...(Array.isArray(block.fields)
              ? block.fields.map((field) => readTextObject(field, options))
              : []),
            readControlElementText(block.accessory, options),
          ];
      return parts.filter(Boolean).join(context ? " " : "\n") || undefined;
    }
    case "image":
      return readAltText(block.alt_text) ?? readTextObject(block.title) ?? "Shared an image";
    case "video":
      return (
        readTextObject(block.title, options) ?? readAltText(block.alt_text) ?? "Shared a video"
      );
    case "file":
      return "Shared a file";
    case "actions": {
      if (!Array.isArray(block.elements)) {
        return undefined;
      }
      const labels = block.elements
        .map((value) => readControlElementText(value, options))
        .filter(Boolean);
      return [...new Set(labels)].join("\n") || undefined;
    }
    case "data_visualization":
      return renderSlackDataVisualizationFallbackText(block, options.nativeDataFormat !== "plain");
    case "data_table":
      return renderSlackDataTableFallbackText(block, options.nativeDataFormat !== "plain");
    case "table":
      return renderSlackTableFallbackText(block, options.nativeDataFormat !== "plain");
    default:
      return undefined;
  }
}

export function buildSlackBlocksFallbackText(blocks: readonly unknown[]): string {
  for (const block of blocks) {
    const text = renderSlackBlockFallbackText(block);
    if (text) {
      return text;
    }
  }

  return "Shared a Block Kit message";
}

export function buildSlackCompleteBlocksFallbackText(
  blocks: readonly unknown[],
  options: RenderSlackBlockFallbackOptions = {},
): string {
  const text = blocks
    .map((block) => renderSlackBlockFallbackText(block, options))
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || buildSlackBlocksFallbackText(blocks);
}

export const SLACK_MALFORMED_NATIVE_DATA_FALLBACK =
  "Slack could not render this chart or table data.";

function isSlackNativeDataBlock(block: unknown): boolean {
  const type = asOptionalRecord(block)?.type;
  return type === "data_table" || type === "data_visualization";
}

export function hasSlackNativeDataBlock(blocks?: readonly unknown[]): boolean {
  return blocks?.some(isSlackNativeDataBlock) ?? false;
}

/** Keep every sibling block while removing Slack's native data blocks. */
export function stripSlackNativeDataBlocks<T>(blocks?: readonly T[]): T[] {
  return (blocks ?? []).filter((block) => !isSlackNativeDataBlock(block));
}

function comparableText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function countComparableOccurrences(value: string, candidate: string): number {
  if (!candidate) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(candidate, offset)) >= 0) {
    count += 1;
    offset += candidate.length;
  }
  return count;
}

/** Consume native fallback occurrences already carried by an explicit outside base. */
export function createSlackNativeDataBaseTextConsumer(baseText: string): (text: string) => boolean {
  const comparableBase = comparableText(baseText);
  const remainingByText = new Map<string, number>();
  return (text) => {
    const comparable = comparableText(text);
    const remaining =
      remainingByText.get(comparable) ?? countComparableOccurrences(comparableBase, comparable);
    if (remaining <= 0) {
      return false;
    }
    remainingByText.set(comparable, remaining - 1);
    return true;
  };
}

function appendSlackBlockFallback(
  text: string,
  blocks: readonly unknown[] | undefined,
  render: (value: unknown) => string | undefined,
): string {
  const consumeFromBase = createSlackNativeDataBaseTextConsumer(text);
  const parts = [text];
  for (const block of blocks ?? []) {
    const dataText = render(block);
    if (!dataText) {
      continue;
    }
    if (isSlackNativeDataBlock(block) && consumeFromBase(dataText)) {
      continue;
    }
    parts.push(dataText);
  }
  return parts.filter((part) => part.trim()).join("\n\n");
}

export function renderSlackNativeDataPlainTextBlock(value: unknown): string | undefined {
  const type = asOptionalRecord(value)?.type;
  if (type === "data_table") {
    return renderSlackDataTableCompactPlainTextFallback(value);
  }
  if (type === "data_visualization") {
    return renderSlackDataVisualizationFallbackText(value);
  }
  return undefined;
}

/** Build formatting-disabled accessibility text from actual Slack block order. */
export function buildSlackNativeDataAccessibilityText(
  text: string,
  blocks?: readonly unknown[],
): string {
  return appendSlackBlockFallback(
    text,
    blocks,
    (block) =>
      renderSlackNativeDataPlainTextBlock(block) ??
      renderSlackBlockFallbackText(block, {
        nativeDataFormat: "plain",
        includeSelectOptions: true,
      }) ??
      (isSlackNativeDataBlock(block) ? SLACK_MALFORMED_NATIVE_DATA_FALLBACK : undefined),
  );
}

/** Preserve every native data block's content once when Slack requires a text-only retry. */
export function appendSlackNativeDataFallbackText(
  text: string,
  blocks?: readonly unknown[],
): string {
  return appendSlackBlockFallback(text.trim(), blocks, (block) =>
    isSlackNativeDataBlock(block) ? renderSlackBlockFallbackText(block) : undefined,
  );
}

/** Build a bounded plain-text retry without activating control tokens. */
export function appendSlackNativeDataPlainTextFallback(
  text: string,
  blocks?: readonly unknown[],
): string {
  return appendSlackBlockFallback(text.trim(), blocks, renderSlackNativeDataPlainTextBlock);
}
