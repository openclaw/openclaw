// Shared Feishu interactive-card text extractor. Both the fetched-message read
// path (`send.ts`) and the merge_forward sub-message formatter (`bot-content.ts`)
// must turn a card JSON payload into the same display text; keeping one walker
// here stops the two paths drifting on whitelisted tags, template variables,
// i18n locale selection, and post fallback.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parsePostContent } from "./post.js";

// Generic placeholder parsePostContent yields when a card carries no rich-text
// post body; treat it as "no text" so we keep walking instead of surfacing it.
const POST_FALLBACK_TEXT = "[Rich text message]";

// Whitelisted text-bearing card element tags. Restricting to these keeps button
// values, action payloads, and other non-display `content` fields out of the
// extracted text.
const FEISHU_CARD_TEXT_TAGS = new Set(["div", "markdown", "lark_md", "plain_text"]);

function normalizeCardTemplateVariable(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function readCardTemplateVariables(card: Record<string, unknown>): Map<string, string> {
  const variables = new Map<string, string>();
  for (const source of [card.template_variable, card.template_variables]) {
    if (!isRecord(source)) {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      const normalized = normalizeCardTemplateVariable(value);
      if (normalized !== undefined) {
        variables.set(key, normalized);
      }
    }
  }
  return variables;
}

function applyCardTemplateVariables(text: string, variables: Map<string, string>): string {
  if (variables.size === 0) {
    return text;
  }
  return text.replace(/\$\{([A-Za-z0-9_.-]+)\}|\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, a, b) => {
    const variableName = typeof a === "string" ? a : b;
    return variables.get(variableName) ?? match;
  });
}

// Pull the display string off a single leaf element (div text, markdown, plain
// text). Returns undefined for structural/non-text nodes so the walker keeps
// descending instead of treating them as leaves.
function readCardElementText(record: Record<string, unknown>): string | undefined {
  const tag = typeof record.tag === "string" ? record.tag : "";
  if (!FEISHU_CARD_TEXT_TAGS.has(tag)) {
    return undefined;
  }
  if (tag === "div") {
    const text = isRecord(record.text) ? record.text : undefined;
    return typeof text?.content === "string" ? text.content : undefined;
  }
  return typeof record.content === "string" ? record.content : undefined;
}

// Card text nests under whitelisted tags at arbitrary depth (column_set, table,
// columns). Walk into every object/array, resolve template variables, and push
// each leaf's text so nested layouts keep their content.
function walkCardText(node: unknown, variables: Map<string, string>, parts: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkCardText(item, variables, parts);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  const text = readCardElementText(node);
  if (text !== undefined) {
    // Leaf text element: stop here so a div is not re-read through its nested
    // `text` node.
    const resolved = applyCardTemplateVariables(text, variables).trim();
    if (resolved) {
      parts.push(resolved);
    }
    return;
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      walkCardText(value, variables, parts);
    }
  }
}

// Candidate element arrays in precedence order: direct elements, body elements,
// then each i18n locale. Callers walk these until one yields text, so a
// multilingual card emits a single locale instead of every translation.
function collectCardElementArrays(card: Record<string, unknown>): unknown[][] {
  const body = isRecord(card.body) ? card.body : undefined;
  const arrays: unknown[][] = [];
  for (const candidate of [card.elements, body?.elements]) {
    if (Array.isArray(candidate)) {
      arrays.push(candidate);
    }
  }
  for (const candidate of [card.i18n_elements, body?.i18n_elements]) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const localeElements of Object.values(candidate)) {
      if (Array.isArray(localeElements)) {
        arrays.push(localeElements);
      }
    }
  }
  return arrays;
}

function parseCardPostFallback(card: Record<string, unknown>): string | undefined {
  const textContent = parsePostContent(JSON.stringify(card)).textContent.trim();
  return textContent && textContent !== POST_FALLBACK_TEXT ? textContent : undefined;
}

// Extract the display text from a parsed Feishu interactive card, or "" when the
// card carries no text-bearing content (e.g. image-only cards). Callers decide
// the placeholder to surface in that case.
export function extractFeishuCardText(card: unknown): string {
  if (!isRecord(card)) {
    return "";
  }
  const variables = readCardTemplateVariables(card);
  const headerParts: string[] = [];
  walkCardText(card.header, variables, headerParts);

  let bodyText = "";
  for (const elements of collectCardElementArrays(card)) {
    const parts: string[] = [];
    walkCardText(elements, variables, parts);
    if (parts.length > 0) {
      bodyText = parts.join("\n");
      break;
    }
  }

  const combined = [...headerParts, bodyText].filter(Boolean).join("\n");
  if (combined) {
    return combined;
  }
  return parseCardPostFallback(card) ?? "";
}
