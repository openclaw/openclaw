type InteractiveCardObject = Record<string, unknown>;

const INTERACTIVE_CARD_PLACEHOLDER = "[Interactive Card]";
const MAX_CARD_PARSE_DEPTH = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonObject(value: string): InteractiveCardObject | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function resolveCardObject(parsed: unknown): InteractiveCardObject | undefined {
  if (!isRecord(parsed)) {
    return undefined;
  }

  const asRecord = parsed as InteractiveCardObject;

  if (isRecord(asRecord.card)) {
    return asRecord.card as InteractiveCardObject;
  }
  if (typeof asRecord.card === "string") {
    const parsedCard = parseJsonObject(asRecord.card);
    if (parsedCard) {
      return parsedCard;
    }
  }

  if (isRecord(asRecord.raw_card_content)) {
    return asRecord.raw_card_content as InteractiveCardObject;
  }
  if (typeof asRecord.raw_card_content === "string") {
    return parseJsonObject(asRecord.raw_card_content);
  }

  if (
    Array.isArray(asRecord.elements) ||
    isRecord(asRecord.body) ||
    isRecord(asRecord.header) ||
    typeof asRecord.schema === "string"
  ) {
    return asRecord;
  }

  return undefined;
}

function pushText(out: string[], value: unknown): void {
  const text = readNonEmptyString(value);
  if (text) {
    out.push(text);
  }
}

function collectElementText(node: unknown, out: string[], depth = 0): void {
  if (!node || depth > MAX_CARD_PARSE_DEPTH) {
    return;
  }
  if (typeof node === "string") {
    pushText(out, node);
    return;
  }
  if (!isRecord(node)) {
    return;
  }

  const obj = node as Record<string, unknown>;
  const textField = obj.text;
  if (isRecord(textField)) {
    pushText(out, textField.content);
  } else {
    pushText(out, textField);
  }
  pushText(out, obj.content);

  const title = obj.title;
  if (isRecord(title)) {
    pushText(out, title.content);
    pushText(out, title.text);
  } else {
    pushText(out, title);
  }

  const note = obj.note;
  if (Array.isArray(note)) {
    for (const item of note) {
      collectElementText(item, out, depth + 1);
    }
  } else {
    collectElementText(note, out, depth + 1);
  }

  const fields = obj.fields;
  if (Array.isArray(fields)) {
    for (const field of fields) {
      collectElementText(field, out, depth + 1);
    }
  }

  const options = obj.options;
  if (Array.isArray(options)) {
    for (const option of options) {
      collectElementText(option, out, depth + 1);
    }
  }

  const actions = obj.actions;
  if (Array.isArray(actions)) {
    for (const action of actions) {
      collectElementText(action, out, depth + 1);
    }
  }

  const children = obj.elements;
  if (Array.isArray(children)) {
    for (const child of children) {
      collectElementText(child, out, depth + 1);
    }
  }
}

function collectCardText(card: InteractiveCardObject): string[] {
  const lines: string[] = [];

  if (isRecord(card.header)) {
    const header = card.header as Record<string, unknown>;
    if (isRecord(header.title)) {
      const title = header.title as Record<string, unknown>;
      pushText(lines, title.content);
      pushText(lines, title.text);
    }
  }

  const topLevelElements = Array.isArray(card.elements) ? card.elements : [];
  const bodyElements =
    isRecord(card.body) && Array.isArray((card.body as Record<string, unknown>).elements)
      ? ((card.body as Record<string, unknown>).elements as unknown[])
      : [];
  const i18nElements =
    isRecord(card.i18n_elements) &&
    Array.isArray((card.i18n_elements as Record<string, unknown>).zh_cn)
      ? ((card.i18n_elements as Record<string, unknown>).zh_cn as unknown[])
      : [];

  for (const element of [...topLevelElements, ...bodyElements, ...i18nElements]) {
    collectElementText(element, lines);
  }

  return lines;
}

function dedupeLines(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = line.trim();
    if (!normalized) {
      continue;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function parseInteractiveCardPayload(rawContent: string): {
  text: string;
  card?: InteractiveCardObject;
  rawCardJson?: string;
} {
  if (!rawContent) {
    return { text: INTERACTIVE_CARD_PLACEHOLDER };
  }

  const parsed = parseJsonObject(rawContent);
  if (!parsed) {
    return { text: rawContent };
  }

  const card = resolveCardObject(parsed);
  if (!card) {
    const textValue = readNonEmptyString(parsed.text);
    if (textValue) {
      return { text: textValue };
    }
    return { text: INTERACTIVE_CARD_PLACEHOLDER };
  }

  const text = dedupeLines(collectCardText(card)).join("\n");
  return {
    text: text || INTERACTIVE_CARD_PLACEHOLDER,
    card,
    rawCardJson: JSON.stringify(card),
  };
}

export function isInteractiveCardPlaceholder(value: string): boolean {
  return value.trim() === INTERACTIVE_CARD_PLACEHOLDER;
}
