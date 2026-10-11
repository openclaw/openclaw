import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { renderSlackDataTableFallbackText, renderSlackTableFallbackText } from "./data-table.js";
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

function readControlElementsText(
  values: readonly unknown[],
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
  const labels = values.map((value) => readControlElementText(value, options)).filter(Boolean);
  return [...new Set(labels)].join("\n") || undefined;
}

function readTextLayout(
  block: Record<string, unknown>,
  options: RenderSlackBlockFallbackOptions = {},
): string | undefined {
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
    case "context":
      return readTextLayout(block, options);
    case "image":
      return readAltText(block.alt_text) ?? readTextObject(block.title) ?? "Shared an image";
    case "video":
      return (
        readTextObject(block.title, options) ?? readAltText(block.alt_text) ?? "Shared a video"
      );
    case "file":
      return "Shared a file";
    case "actions":
      return Array.isArray(block.elements)
        ? readControlElementsText(block.elements, options)
        : undefined;
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
