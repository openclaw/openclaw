import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parsePostContent } from "./post.js";

const INTERACTIVE_CARD_FALLBACK_TEXT = "[Interactive Card]";
const POST_FALLBACK_TEXT = "[Rich text message]";

function normalizeCardTemplateVariable(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function readCardTemplateVariables(parsed: Record<string, unknown>): Map<string, string> {
  const variables = new Map<string, string>();
  for (const source of [parsed.template_variable, parsed.template_variables]) {
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

function normalizeInteractiveTableCell(value: unknown, variables: Map<string, string>): string {
  const normalized = normalizeCardTemplateVariable(value);
  if (normalized !== undefined) {
    return applyCardTemplateVariables(normalized, variables);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeInteractiveTableCell(entry, variables))
      .filter(Boolean)
      .join(", ");
  }
  if (!isRecord(value)) {
    return "";
  }

  // Table options and people can be objects; preserve their visible label before opaque IDs.
  for (const key of [
    "content",
    "text",
    "label",
    "name",
    "display_name",
    "user_name",
    "user_id",
    "open_id",
    "id",
    "value",
  ]) {
    const text = normalizeInteractiveTableCell(value[key], variables);
    if (text) {
      return text;
    }
  }
  return "";
}

function extractInteractiveTableText(
  element: Record<string, unknown>,
  variables: Map<string, string>,
): string | undefined {
  if (!Array.isArray(element.columns) || !Array.isArray(element.rows)) {
    return undefined;
  }

  const columns = element.columns.flatMap((column) => {
    if (!isRecord(column) || typeof column.name !== "string") {
      return [];
    }
    return [
      {
        name: column.name,
        title: typeof column.display_name === "string" ? column.display_name : column.name,
      },
    ];
  });
  if (columns.length === 0) {
    return undefined;
  }

  const lines = [
    columns.map((column) => applyCardTemplateVariables(column.title, variables)).join(" | "),
  ];
  for (const row of element.rows) {
    if (!isRecord(row)) {
      continue;
    }
    const cells = columns.map((column) =>
      normalizeInteractiveTableCell(row[column.name], variables),
    );
    if (cells.some(Boolean)) {
      lines.push(cells.join(" | "));
    }
  }
  return lines.join("\n");
}

function extractInteractiveElementText(
  element: unknown,
  variables: Map<string, string>,
): string | undefined {
  if (!isRecord(element)) {
    return undefined;
  }
  const tag = typeof element.tag === "string" ? element.tag : "";
  const text = isRecord(element.text) ? element.text : undefined;

  if (tag === "div") {
    const parts: string[] = [];
    if (typeof text?.content === "string") {
      parts.push(applyCardTemplateVariables(text.content, variables));
    }
    if (Array.isArray(element.fields)) {
      const fields = extractInteractiveElementsText(element.fields, variables);
      if (fields) {
        parts.push(fields);
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  if ((tag === "markdown" || tag === "lark_md") && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  if ((tag === "text" || tag === "a" || tag === "button") && typeof element.text === "string") {
    return applyCardTemplateVariables(element.text, variables);
  }
  if (tag === "at") {
    const mention =
      typeof element.user_name === "string"
        ? element.user_name
        : typeof element.user_id === "string"
          ? element.user_id
          : "";
    const resolvedMention = applyCardTemplateVariables(mention, variables).trim();
    return resolvedMention
      ? resolvedMention.startsWith("@")
        ? resolvedMention
        : `@${resolvedMention}`
      : undefined;
  }
  if (tag === "button" && typeof text?.content === "string") {
    return applyCardTemplateVariables(text.content, variables);
  }
  if (!tag && typeof text?.content === "string") {
    return applyCardTemplateVariables(text.content, variables);
  }
  if (tag === "plain_text" && typeof element.content === "string") {
    return applyCardTemplateVariables(element.content, variables);
  }
  if (tag === "table") {
    return extractInteractiveTableText(element, variables);
  }

  const nestedTexts: string[] = [];
  for (const nested of [
    element.elements,
    element.columns,
    element.children,
    element.fields,
    element.actions,
  ]) {
    if (!Array.isArray(nested)) {
      continue;
    }
    const nestedText = extractInteractiveElementsText(nested, variables);
    if (nestedText) {
      nestedTexts.push(nestedText);
    }
  }
  return nestedTexts.length > 0 ? nestedTexts.join("\n") : undefined;
}

function extractInteractiveElementsText(
  elements: unknown[],
  variables: Map<string, string>,
): string {
  const texts: string[] = [];
  for (const element of elements) {
    if (Array.isArray(element)) {
      const parts: Array<{ text: string; isControl: boolean }> = [];
      for (const part of element) {
        const text = extractInteractiveElementText(part, variables);
        if (text !== undefined) {
          parts.push({ text, isControl: isRecord(part) && part.tag === "button" });
        }
      }
      const row = parts
        .reduce((combined, part, index) => {
          if (index === 0) {
            return part.text;
          }
          return part.isControl || parts[index - 1]?.isControl
            ? `${combined.trimEnd()} ${part.text.trimStart()}`
            : `${combined}${part.text}`;
        }, "")
        .trim();
      if (row) {
        texts.push(row);
      }
      continue;
    }
    const text = extractInteractiveElementText(element, variables);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts.join("\n").trim();
}

type InteractiveCardElementArray = { elements: unknown[]; locale?: string };

function readInteractiveElementArrays(
  parsed: Record<string, unknown>,
): InteractiveCardElementArray[] {
  const body = isRecord(parsed.body) ? parsed.body : undefined;
  const elementArrays: InteractiveCardElementArray[] = [];

  for (const candidate of [parsed.elements, body?.elements]) {
    if (Array.isArray(candidate)) {
      elementArrays.push({ elements: candidate });
    }
  }

  for (const candidate of [parsed.i18n_elements, body?.i18n_elements]) {
    if (!isRecord(candidate)) {
      continue;
    }
    for (const [locale, localeElements] of Object.entries(candidate)) {
      if (Array.isArray(localeElements)) {
        elementArrays.push({ elements: localeElements, locale });
      }
    }
  }

  return elementArrays;
}

function readInteractiveCardTitle(
  parsed: Record<string, unknown>,
  variables: Map<string, string>,
  locale?: string,
): string {
  if (typeof parsed.title === "string") {
    return applyCardTemplateVariables(parsed.title, variables).trim();
  }

  const header = isRecord(parsed.header) ? parsed.header : undefined;
  const headerTitle = isRecord(header?.title) ? header.title : undefined;
  const localizedTitles = isRecord(headerTitle?.i18n_content)
    ? headerTitle.i18n_content
    : isRecord(headerTitle?.i18n)
      ? headerTitle.i18n
      : undefined;
  if (!locale && localizedTitles) {
    const titles = Object.entries(localizedTitles)
      .flatMap(([titleLocale, value]) => {
        if (typeof value !== "string") {
          return [];
        }
        const title = applyCardTemplateVariables(value, variables).trim();
        return title ? [{ locale: titleLocale, title }] : [];
      })
      .toSorted((left, right) =>
        left.locale < right.locale ? -1 : left.locale > right.locale ? 1 : 0,
      );
    if (titles.length === 1) {
      return titles[0]?.title ?? "";
    }
    if (titles.length > 1) {
      // Card headers localize independently; shared body elements do not select a locale.
      return titles.map((title) => `[${title.locale}] ${title.title}`).join("\n");
    }
  }
  const localizedTitle =
    locale && typeof localizedTitles?.[locale] === "string" ? localizedTitles[locale] : undefined;
  const rawTitle =
    localizedTitle ?? (typeof headerTitle?.content === "string" ? headerTitle.content : "");
  return applyCardTemplateVariables(rawTitle, variables).trim();
}

export function parseFeishuInteractiveCardContent(parsed: unknown): string {
  if (!isRecord(parsed)) {
    return INTERACTIVE_CARD_FALLBACK_TEXT;
  }

  const variables = readCardTemplateVariables(parsed);
  const localizedVariants: Array<{ locale: string; title: string; text: string }> = [];
  for (const { elements, locale } of readInteractiveElementArrays(parsed)) {
    const text = extractInteractiveElementsText(elements, variables);
    if (text) {
      const cardTitle = readInteractiveCardTitle(parsed, variables, locale);
      if (!locale) {
        return cardTitle ? `${cardTitle}\n${text}` : text;
      }
      localizedVariants.push({ locale, title: cardTitle, text });
    }
  }
  const singleVariant = localizedVariants[0];
  if (localizedVariants.length === 1 && singleVariant) {
    return singleVariant.title
      ? `${singleVariant.title}\n${singleVariant.text}`
      : singleVariant.text;
  }
  if (localizedVariants.length > 1) {
    // Original card JSON does not identify the recipient's displayed locale.
    // Keep all variants in stable locale order instead of guessing from JSON key order.
    return localizedVariants
      .toSorted((left, right) =>
        left.locale < right.locale ? -1 : left.locale > right.locale ? 1 : 0,
      )
      .map((variant) =>
        variant.title
          ? `[${variant.locale}] ${variant.title}\n${variant.text}`
          : `[${variant.locale}] ${variant.text}`,
      )
      .join("\n\n");
  }

  const postText = parsePostContent(JSON.stringify(parsed)).textContent.trim();
  if (postText && postText !== POST_FALLBACK_TEXT) {
    return postText;
  }
  return readInteractiveCardTitle(parsed, variables) || INTERACTIVE_CARD_FALLBACK_TEXT;
}
