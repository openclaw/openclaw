import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";

/** OpenAI's webhook profile, not the experimental polling/streaming extensions. */
export const MCP_EVENTS_PROFILE = "openai-webhook-2026-07-28";
export const MAX_EVENT_BYTES = 256 * 1024;
export const CALLBACK_PREFIX = "/plugins/mcp-events/callback/";
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type EventDefinition = {
  name: string;
  description?: string;
  inputSchema: JsonSchemaObject | boolean;
  payloadSchema: JsonSchemaObject | boolean;
};
export type ApplicationEvent = {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor: string | null;
};
export type SubscriptionResult = {
  id: string;
  refreshBefore: number;
  cursor: string | null;
  truncated: boolean;
};
export class CallbackError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  // SAFETY: non-null, non-array objects expose string-indexed values only as unknown.
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxBytes = 1024): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= maxBytes;
}

function isoTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Canonical JSON gives subscribe and unsubscribe the same filter identity. */
export function canonicalArguments(value: Record<string, unknown>): string {
  const visit = (input: unknown, depth: number): string => {
    if (depth > 64) {
      throw new Error("MCP event arguments exceed the nesting limit");
    }
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))
    ) {
      return JSON.stringify(input);
    }
    if (Array.isArray(input)) {
      return "[" + input.map((entry) => visit(entry, depth + 1)).join(",") + "]";
    }
    const object = record(input);
    if (!object) {
      throw new Error("MCP event arguments must be JSON");
    }
    return (
      "{" +
      Object.keys(object)
        .toSorted()
        .map((key) => JSON.stringify(key) + ":" + visit(object[key], depth + 1))
        .join(",") +
      "}"
    );
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > 32 * 1024) {
    throw new Error("MCP event arguments exceed 32 KiB");
  }
  return result;
}

export function identityHash(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function createSigningSecret(): string {
  return generateSecureToken({ bytes: 32, redact: true, encoding: "base64", prefix: "whsec_" });
}

function decodeBase64(value: string): Buffer | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return undefined;
  }
  return Buffer.from(value, "base64");
}

/** Authenticate bytes before parsing; the subscription-id header is deliberately unused. */
export function verifyWebhook(params: {
  headers: IncomingHttpHeaders;
  body: Buffer;
  secrets: readonly string[];
  now: number;
}): string {
  const id = params.headers["webhook-id"];
  const timestamp = params.headers["webhook-timestamp"];
  const signatures = params.headers["webhook-signature"];
  if (
    !boundedString(id) ||
    typeof timestamp !== "string" ||
    !/^\d{1,12}$/u.test(timestamp) ||
    typeof signatures !== "string" ||
    signatures.length > 4096 ||
    Math.abs(params.now - Number(timestamp) * 1000) > MAX_CLOCK_SKEW_MS
  ) {
    throw new CallbackError(401, "Invalid webhook authentication");
  }
  const candidates = signatures.split(/\s+/u).flatMap((signature) => {
    if (!signature.startsWith("v1,")) {
      return [];
    }
    const decoded = decodeBase64(signature.slice(3));
    return decoded?.length === 32 ? [decoded] : [];
  });
  let matched = false;
  for (const secret of params.secrets) {
    const key = secret.startsWith("whsec_") ? decodeBase64(secret.slice(6)) : undefined;
    if (!key || key.length < 24 || key.length > 64) {
      continue;
    }
    const expected = createHmac("sha256", key)
      .update(id + "." + timestamp + ".")
      .update(params.body)
      .digest();
    for (const candidate of candidates) {
      matched = timingSafeEqual(expected, candidate) || matched;
    }
  }
  if (!matched) {
    throw new CallbackError(401, "Invalid webhook authentication");
  }
  return id;
}

export function parseCallback(
  body: Buffer,
  webhookId: string,
  definition: EventDefinition,
): { kind: "verification"; challenge: string } | { kind: "event"; event: ApplicationEvent } {
  if (body.length > MAX_EVENT_BYTES) {
    throw new CallbackError(413, "Event exceeds 256 KiB");
  }
  let value: Record<string, unknown> | undefined;
  try {
    value = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
  } catch {
    throw new CallbackError(400, "Invalid event JSON");
  }
  if (!value) {
    throw new CallbackError(400, "Expected one event object");
  }
  if (Object.hasOwn(value, "type")) {
    if (value.type !== "verification" || !boundedString(value.challenge, 4096)) {
      throw new CallbackError(400, "Unsupported control notification");
    }
    return { kind: "verification", challenge: value.challenge };
  }
  const data = record(value.data);
  if (
    !boundedString(value.eventId) ||
    value.eventId !== webhookId ||
    value.name !== definition.name ||
    !isoTimestamp(value.timestamp) ||
    !data ||
    !(value.cursor === null || boundedString(value.cursor, 16 * 1024))
  ) {
    throw new CallbackError(400, "Invalid event envelope");
  }
  const checked = validateJsonSchemaValue({ schema: definition.payloadSchema, value: data });
  if (!checked.ok) {
    throw new CallbackError(400, "Event data does not match payloadSchema");
  }
  return {
    kind: "event",
    event: {
      eventId: value.eventId,
      name: definition.name,
      timestamp: value.timestamp,
      data,
      cursor: value.cursor,
    },
  };
}

export function parseSubscriptionResult(value: unknown, now: number): SubscriptionResult {
  const result = record(value);
  if (
    !result ||
    !boundedString(result.id) ||
    !isoTimestamp(result.refreshBefore) ||
    Date.parse(result.refreshBefore) <= now ||
    !(result.cursor === null || boundedString(result.cursor, 16 * 1024)) ||
    typeof result.truncated !== "boolean"
  ) {
    throw new Error(
      "Invalid MCP subscription response (a finite future refreshBefore is required)",
    );
  }
  return {
    id: result.id,
    refreshBefore: Date.parse(result.refreshBefore),
    cursor: result.cursor,
    truncated: result.truncated,
  };
}

export function parseEventCatalog(value: unknown): {
  events: EventDefinition[];
  nextCursor?: string;
} {
  const result = record(value);
  if (
    !result ||
    !Array.isArray(result.events) ||
    result.events.length > 1000 ||
    (result.nextCursor !== undefined && !boundedString(result.nextCursor, 16 * 1024))
  ) {
    throw new Error("Invalid MCP event catalog");
  }
  const events: EventDefinition[] = [];
  for (const input of result.events) {
    const event = record(input);
    if (
      !event ||
      !boundedString(event.name, 256) ||
      !Array.isArray(event.delivery) ||
      !(typeof event.inputSchema === "boolean" || record(event.inputSchema)) ||
      !(typeof event.payloadSchema === "boolean" || record(event.payloadSchema))
    ) {
      throw new Error("Invalid MCP event definition");
    }
    if (!event.delivery.includes("webhook")) {
      continue;
    }
    const inputSchema =
      typeof event.inputSchema === "boolean" ? event.inputSchema : record(event.inputSchema)!;
    const payloadSchema =
      typeof event.payloadSchema === "boolean" ? event.payloadSchema : record(event.payloadSchema)!;
    // Compile now: a broken catalog must not create a subscription that can never accept data.
    validateJsonSchemaValue({ schema: inputSchema, value: {} });
    validateJsonSchemaValue({ schema: payloadSchema, value: {} });
    events.push({
      name: event.name,
      inputSchema,
      payloadSchema,
      ...(typeof event.description === "string"
        ? { description: event.description.slice(0, 4096) }
        : {}),
    });
  }
  return {
    events,
    ...(typeof result.nextCursor === "string" ? { nextCursor: result.nextCursor } : {}),
  };
}
