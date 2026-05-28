import type { IncomingMessage } from "node:http";
import { getHeader, getHeaderFromHeaders, type WebhookHeaderMap } from "./auth.js";
import type { ConfiguredWebhookEventConfig, ConfiguredWebhookIdempotencyConfig } from "./config.js";
import { normalizePathString, readTemplatePath } from "./template.js";

const DEFAULT_EVENT_HEADERS = [
  "x-github-event",
  "x-gitlab-event",
  "x-event-type",
  "x-webhook-event",
] as const;

const DEFAULT_EVENT_PAYLOAD_PATHS = ["event_type", "event.type", "event.action", "type"] as const;

const DEFAULT_IDEMPOTENCY_HEADERS = [
  "x-github-delivery",
  "x-request-id",
  "x-webhook-id",
  "x-delivery-id",
] as const;

const DEFAULT_IDEMPOTENCY_PAYLOAD_PATHS = [
  "delivery.id",
  "event.id",
  "webhook.id",
  "request.id",
] as const;

function readPayloadPath(value: unknown, path: string | undefined): unknown {
  if (!path) {
    return undefined;
  }
  return readTemplatePath(value, path);
}

export function extractEventType(params: {
  req?: IncomingMessage;
  headers?: WebhookHeaderMap;
  body: unknown;
  config: ConfiguredWebhookEventConfig | undefined;
}): string | undefined {
  const readHeader = (name: string) =>
    params.headers
      ? getHeaderFromHeaders(params.headers, name)
      : getHeader(params.req as IncomingMessage, name);
  const fromHeader = params.config?.header ? readHeader(params.config.header) : "";
  if (fromHeader) {
    return fromHeader;
  }
  const fromPayload = normalizePathString(readPayloadPath(params.body, params.config?.payloadPath));
  if (fromPayload) {
    return fromPayload;
  }
  for (const header of DEFAULT_EVENT_HEADERS) {
    const value = readHeader(header);
    if (value) {
      return value;
    }
  }
  for (const path of DEFAULT_EVENT_PAYLOAD_PATHS) {
    const value = normalizePathString(readPayloadPath(params.body, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function extractIdempotencyKey(params: {
  req?: IncomingMessage;
  headers?: WebhookHeaderMap;
  body: unknown;
  config: ConfiguredWebhookIdempotencyConfig | undefined;
}): string | undefined {
  const readHeader = (name: string) =>
    params.headers
      ? getHeaderFromHeaders(params.headers, name)
      : getHeader(params.req as IncomingMessage, name);
  const fromHeader = params.config?.header ? readHeader(params.config.header) : "";
  if (fromHeader) {
    return fromHeader;
  }
  const fromPayload = normalizePathString(readPayloadPath(params.body, params.config?.payloadPath));
  if (fromPayload) {
    return fromPayload;
  }
  if (!params.config) {
    return undefined;
  }
  for (const header of DEFAULT_IDEMPOTENCY_HEADERS) {
    const value = readHeader(header);
    if (value) {
      return value;
    }
  }
  for (const path of DEFAULT_IDEMPOTENCY_PAYLOAD_PATHS) {
    const value = normalizePathString(readPayloadPath(params.body, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}
