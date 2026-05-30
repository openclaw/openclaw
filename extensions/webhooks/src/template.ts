export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type WebhookDispatchContext = {
  routeId: string;
  eventType?: string;
  idempotencyKey?: string;
  body: unknown;
  rawBody: string;
  headers: Record<string, string>;
  completionText?: string;
};

export function normalizeJsonForState(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): JsonValue => {
    if (entry === null) {
      return null;
    }
    if (typeof entry === "string" || typeof entry === "boolean") {
      return entry;
    }
    if (typeof entry === "number") {
      return Number.isFinite(entry) ? entry : String(entry);
    }
    if (typeof entry === "bigint") {
      return entry.toString();
    }
    if (Array.isArray(entry)) {
      return entry.map(normalize);
    }
    if (typeof entry === "object") {
      if (seen.has(entry)) {
        return "[Circular]";
      }
      seen.add(entry);
      try {
        const record: Record<string, JsonValue> = {};
        for (const key of Object.keys(entry as Record<string, unknown>).sort()) {
          record[key] = normalize((entry as Record<string, unknown>)[key]);
        }
        return record;
      } finally {
        seen.delete(entry);
      }
    }
    return null;
  };
  return normalize(value);
}

export function jsonStringifyStable(value: unknown, maxChars?: number): string {
  const rendered = JSON.stringify(normalizeJsonForState(value), null, 2) ?? "null";
  return maxChars ? truncateTemplateString(rendered, maxChars) : rendered;
}

function truncateTemplateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...`;
}

function toTemplateString(value: unknown, maxChars?: number): string {
  if (value === null) {
    return "";
  }
  if (typeof value === "string") {
    return maxChars ? truncateTemplateString(value, maxChars) : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === undefined) {
    return "";
  }
  return jsonStringifyStable(value, maxChars);
}

const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

export function readTemplatePath(value: unknown, path: string): unknown {
  if (!path) {
    return undefined;
  }
  let current = value;
  for (const rawSegment of path.split(".")) {
    const segment = rawSegment.trim();
    if (!segment || BLOCKED_PATH_SEGMENTS.has(segment)) {
      return undefined;
    }
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0) {
        return undefined;
      }
      current = current[index];
      continue;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function normalizePathString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function normalizeTemplateOutput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function sanitizeSchedulerToken(value: string | undefined): string | undefined {
  const normalized = normalizeTemplateOutput(value);
  if (!normalized) {
    return undefined;
  }
  const safe = normalized.replace(/:/g, "-").replace(/\s+/g, "-").slice(0, 96);
  return safe || undefined;
}

function renderTemplateExpression(params: {
  match: string;
  rawExpression: string;
  context: WebhookDispatchContext;
  keepMissingLiteral: boolean;
}): string {
  const expression = params.rawExpression.trim();
  if (!expression) {
    return params.keepMissingLiteral ? params.match : "";
  }
  if (expression === "__raw__") {
    return jsonStringifyStable(params.context.body, 4000);
  }
  if (expression.startsWith("json ")) {
    const path = expression.slice(5).trim();
    const value = resolveTemplateValue(path, params.context);
    if (value === undefined && params.keepMissingLiteral) {
      return params.match;
    }
    if (value === undefined) {
      return "";
    }
    return jsonStringifyStable(value);
  }
  const value = resolveTemplateValue(expression, params.context);
  if (value === undefined && params.keepMissingLiteral) {
    return params.match;
  }
  return toTemplateString(value, params.keepMissingLiteral ? 2000 : undefined);
}

export function renderTemplate(template: string, context: WebhookDispatchContext): string {
  return template.replace(
    /\{\{\s*([^}]+?)\s*\}\}|\{([^{}\n]+)\}/g,
    (
      match: string,
      doubleBraceExpression: string | undefined,
      singleBraceExpression: string | undefined,
    ) =>
      renderTemplateExpression({
        match,
        rawExpression: doubleBraceExpression ?? singleBraceExpression ?? "",
        context,
        keepMissingLiteral: singleBraceExpression !== undefined,
      }),
  );
}

export function renderOptionalTemplate(
  template: string | undefined,
  context: WebhookDispatchContext,
): string | undefined {
  return template ? normalizeTemplateOutput(renderTemplate(template, context)) : undefined;
}

function resolveTemplateValue(path: string, context: WebhookDispatchContext): unknown {
  switch (path) {
    case "completion":
    case "completionText":
    case "result":
    case "resultText":
      return context.completionText;
    case "body":
    case "payload":
      return context.body;
    case "rawBody":
      return context.rawBody;
    case "event":
    case "eventType":
      return context.eventType;
    case "route":
    case "routeId":
      return context.routeId;
    case "idempotency":
    case "idempotencyKey":
      return context.idempotencyKey;
    default:
      break;
  }
  if (path.startsWith("body.")) {
    return readTemplatePath(context.body, path.slice("body.".length));
  }
  if (path.startsWith("payload.")) {
    return readTemplatePath(context.body, path.slice("payload.".length));
  }
  if (path.startsWith("headers.")) {
    return context.headers[path.slice("headers.".length).toLowerCase()];
  }
  if (path.startsWith("header.")) {
    return context.headers[path.slice("header.".length).toLowerCase()];
  }
  if (path.startsWith("event.")) {
    const eventMetadata = readTemplatePath(
      { type: context.eventType },
      path.slice("event.".length),
    );
    return eventMetadata !== undefined ? eventMetadata : readTemplatePath(context.body, path);
  }
  return readTemplatePath(context.body, path);
}

export function buildDefaultWebhookPrompt(context: WebhookDispatchContext): string {
  const lines = [
    `Webhook route: ${context.routeId}`,
    context.eventType ? `Event: ${context.eventType}` : undefined,
    context.idempotencyKey ? `Delivery id: ${context.idempotencyKey}` : undefined,
    "",
    "Payload:",
    jsonStringifyStable(context.body),
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}

export function applySkillHint(text: string, skills: string[] | undefined): string {
  if (!skills?.length) {
    return text;
  }
  return `${text}\n\nUse these OpenClaw skills when useful: ${skills.join(", ")}`;
}
