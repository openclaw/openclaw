import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { sha256Hex as hashText } from "openclaw/plugin-sdk/node-crypto-runtime";
import { generateSecureToken } from "openclaw/plugin-sdk/secure-random-runtime";
import { asOptionalRecord as record } from "openclaw/plugin-sdk/string-coerce-runtime";

/** OpenAI's webhook profile. */
export const MCP_EVENTS_PROFILE = "openai-webhook-2026-07-28";
/** SEP-3415 poll delivery (`events/poll`), identified by the extension it belongs to. */
export const MCP_EVENTS_POLL_PROFILE = "io.modelcontextprotocol/events";
const MIN_POLL_INTERVAL_MS = 1_000;
// Polls hold no server state; re-checking at least hourly bounds a server's oversized interval.
const MAX_POLL_INTERVAL_MS = 60 * 60_000;
export const MAX_EVENT_BYTES = 256 * 1024;
export const CALLBACK_PREFIX = "/plugins/mcp-events/callback/";
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export type DeliveryMode = "webhook" | "poll";
export type EventDefinition = {
  name: string;
  description?: string;
  /** Modes OpenClaw can use; absent on bindings stored before poll delivery, which are webhook. */
  delivery?: DeliveryMode[];
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
export type PollResult = {
  events: ApplicationEvent[];
  /** Occurrences that failed envelope or payloadSchema validation; skipped, never queued. */
  rejected: number;
  cursor: string | null;
  truncated: boolean;
  /** When to poll next: at once while hasMore, else nextPollMs with a 1 s floor. */
  delayMs: number;
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
  return hashText(JSON.stringify(parts));
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
  if (value.eventId !== webhookId || !(value.cursor === null || isCursor(value.cursor))) {
    throw new CallbackError(400, "Invalid event envelope");
  }
  return { kind: "event", event: parseOccurrence(value, definition, value.cursor) };
}

function isCursor(value: unknown): value is string {
  return boundedString(value, 16 * 1024);
}

/** One EventOccurrence, shared by webhook bodies and poll results. */
function parseOccurrence(
  value: Record<string, unknown>,
  definition: EventDefinition,
  cursor: string | null,
): ApplicationEvent {
  const data = record(value.data);
  if (
    !boundedString(value.eventId) ||
    value.name !== definition.name ||
    !isoTimestamp(value.timestamp) ||
    !data
  ) {
    throw new CallbackError(400, "Invalid event envelope");
  }
  const checked = validateJsonSchemaValue({ schema: definition.payloadSchema, value: data });
  if (!checked.ok) {
    throw new CallbackError(400, "Event data does not match payloadSchema");
  }
  return {
    eventId: value.eventId,
    name: definition.name,
    timestamp: value.timestamp,
    data,
    cursor,
  };
}

/** SEP-3415 `events/poll` result. An absent cursor means null; poll occurrences carry no cursor. */
export function parsePollResult(value: unknown, definition: EventDefinition): PollResult {
  const result = record(value);
  const cursor = result?.cursor ?? null;
  if (
    !result ||
    !Array.isArray(result.events) ||
    result.events.length > 1000 ||
    !(cursor === null || isCursor(cursor)) ||
    typeof result.truncated !== "boolean" ||
    typeof result.hasMore !== "boolean" ||
    typeof result.nextPollMs !== "number" ||
    !Number.isFinite(result.nextPollMs) ||
    result.nextPollMs < 0
  ) {
    throw new Error("Invalid MCP events/poll result");
  }
  const events: ApplicationEvent[] = [];
  let rejected = 0;
  for (const input of result.events) {
    const occurrence = record(input);
    try {
      // The same per-event bound as a webhook body, so one oversized event cannot stall the lane.
      if (!occurrence || Buffer.byteLength(JSON.stringify(occurrence)) > MAX_EVENT_BYTES) {
        throw new CallbackError(400, "Expected one event object within the size limit");
      }
      events.push(parseOccurrence(occurrence, definition, null));
    } catch (error) {
      if (!(error instanceof CallbackError)) {
        throw error;
      }
      rejected++;
    }
  }
  return {
    events,
    rejected,
    cursor,
    truncated: result.truncated,
    // An empty batch that claims hasMore makes no progress; the floor stops it spinning.
    delayMs:
      result.hasMore && result.events.length > 0
        ? 0
        : Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, result.nextPollMs)),
  };
}

/** SEP-3415 extension entry, or the top-level key from the design sketch that preceded it. */
export function advertisesEvents(discovered: unknown): boolean {
  const result = record(discovered);
  const capabilities = record(result?.capabilities);
  return (
    Array.isArray(result?.supportedVersions) &&
    result.supportedVersions.includes("2026-07-28") &&
    capabilities !== undefined &&
    (Object.hasOwn(capabilities, "events") ||
      Object.hasOwn(record(capabilities.extensions) ?? {}, "io.modelcontextprotocol/events"))
  );
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
    const inputSchema =
      typeof event?.inputSchema === "boolean" ? event.inputSchema : record(event?.inputSchema);
    const payloadSchema =
      typeof event?.payloadSchema === "boolean"
        ? event.payloadSchema
        : record(event?.payloadSchema);
    if (
      !event ||
      !boundedString(event.name, 256) ||
      !Array.isArray(event.delivery) ||
      inputSchema === undefined ||
      payloadSchema === undefined
    ) {
      throw new Error("Invalid MCP event definition");
    }
    const offered: unknown[] = event.delivery;
    const delivery = (["webhook", "poll"] as const).filter((mode) => offered.includes(mode));
    if (delivery.length === 0) {
      continue;
    }
    // Compile now: a broken catalog must not create a subscription that can never accept data.
    validateJsonSchemaValue({ schema: inputSchema, value: {} });
    validateJsonSchemaValue({ schema: payloadSchema, value: {} });
    events.push({
      name: event.name,
      delivery,
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
