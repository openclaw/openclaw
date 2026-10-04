import type { Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveModelPayloadDebugMode } from "./model-transport-debug.js";
import { RESPONSE_FAILED_NO_DETAILS_MESSAGE } from "./openai-responses-contracts.js";
import { log } from "./openai-transport-shared.js";
import { redactIdentifier, redactSensitiveText, sha256Hex } from "./transport-utils.js";

function stringifyUnknown(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

export function safeDebugValue(value: unknown): string {
  if (
    value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function responseInputTextChars(input: unknown): number {
  if (typeof input === "string") {
    return input.length;
  }
  if (Array.isArray(input)) {
    return input.reduce((total, item) => total + responseInputTextChars(item), 0);
  }
  if (!input || typeof input !== "object") {
    return 0;
  }
  const record = input as Record<string, unknown>;
  let total = 0;
  if (typeof record.text === "string") {
    total += record.text.length;
  }
  if (typeof record.content === "string") {
    total += record.content.length;
  } else if (Array.isArray(record.content)) {
    total += responseInputTextChars(record.content);
  }
  return total;
}

function responseInputRoles(input: unknown): string {
  if (!Array.isArray(input)) {
    return "";
  }
  const roles = new Set<string>();
  for (const item of input) {
    if (item && typeof item === "object") {
      const role = (item as Record<string, unknown>).role;
      if (typeof role === "string" && role.trim()) {
        roles.add(role.trim());
      }
    }
  }
  return [...roles].toSorted().join(",");
}

function responseInputItemShape(input: unknown): string {
  if (!Array.isArray(input)) {
    return "none";
  }
  return (
    input
      .map((item) => {
        if (!isRecord(item) || typeof item.type !== "string") {
          return "unknown";
        }
        if (item.type === "message" && typeof item.role === "string") {
          return `message:${item.role}`;
        }
        return item.type;
      })
      .join(",") || "none"
  );
}

function summarizeResponsesCompactionItems(input: unknown): string[] {
  const compactions = (Array.isArray(input) ? input : []).flatMap((item, inputIndex) => {
    if (!isRecord(item) || item.type !== "compaction") {
      return [];
    }
    const idHash = typeof item.id === "string" ? sha256Hex(item.id) : undefined;
    const payloadHash =
      typeof item.encrypted_content === "string" ? sha256Hex(item.encrypted_content) : undefined;
    return [{ idHash, inputIndex, payloadHash }];
  });
  return [
    `compactionItems=${compactions.length}`,
    `compactionIdHashes=${compactions.flatMap((item) => item.idHash ?? []).join(",") || "none"}`,
    `compactionPayloadHashes=${compactions.flatMap((item) => item.payloadHash ?? []).join(",") || "none"}`,
    `compactionInputIndexes=${compactions.map((item) => item.inputIndex).join(",") || "none"}`,
  ];
}

function readToolPayloadField(record: Record<string, unknown>, field: string): unknown {
  try {
    return record[field];
  } catch {
    return undefined;
  }
}

function readResponsesToolDisplayName(tool: unknown): string {
  if (!tool || typeof tool !== "object") {
    return "";
  }
  const record = tool as Record<string, unknown>;
  const name = readToolPayloadField(record, "name");
  if (typeof name === "string") {
    return name;
  }
  const fn = readToolPayloadField(record, "function");
  if (fn && typeof fn === "object") {
    const fnName = readToolPayloadField(fn as Record<string, unknown>, "name");
    if (typeof fnName === "string") {
      return fnName;
    }
  }
  const type = readToolPayloadField(record, "type");
  return typeof type === "string" && type !== "function" ? type : "";
}

function summarizeResponsesTools(tools: unknown): string {
  if (!Array.isArray(tools)) {
    return "count=0";
  }
  const names = tools.map(readResponsesToolDisplayName).filter(Boolean);
  const mode = resolveModelPayloadDebugMode();
  const maxNames = mode === "tools" || mode === "full-redacted" ? names.length : 12;
  const label = maxNames >= names.length ? "names" : "sample";
  const shown = names.slice(0, maxNames).join(",");
  return `count=${tools.length}${shown ? ` ${label}=${shown}` : ""}`;
}

function stringifyRedactedPayload(value: unknown): string {
  try {
    const encoded = JSON.stringify(value, (key, child) =>
      key === "encrypted_content" ? "<opaque data omitted>" : child,
    );
    if (!encoded) {
      return "<empty>";
    }
    const redacted = redactSensitiveText(encoded);
    return redacted.length > 8000 ? `${truncateUtf16Safe(redacted, 8000)}…<truncated>` : redacted;
  } catch {
    return "<unserializable>";
  }
}

export function stringifyRedactedEvent(value: unknown): string {
  const redacted = stringifyRedactedPayload(value);
  return redacted.length > 2000 ? `${truncateUtf16Safe(redacted, 2000)}…<truncated>` : redacted;
}

type ResponsesFailedNoDetailsObservation = ReturnType<
  typeof buildResponsesFailedNoDetailsObservation
>;

type ResponsesFailedEventSummary = {
  message: string;
  responseId?: string;
  // Structured provider error code (e.g. "server_error") preserved from
  // response.failed so downstream failover classification can route on it
  // instead of guessing from the prose message (#117609).
  code?: string;
  observation?: ResponsesFailedNoDetailsObservation;
};

const RESPONSE_FAILED_FAILURE_FIELD_KEYS = [
  "error",
  "incomplete_details",
  "status_details",
  "failure_reason",
  "last_error",
  "provider_error",
  "error_details",
] as const;

function buildResponsesFailedEventSummary(
  message: string,
  responseId: string | undefined,
  code?: string,
  observation?: ResponsesFailedNoDetailsObservation,
): ResponsesFailedEventSummary {
  return {
    message,
    ...(responseId ? { responseId } : {}),
    ...(code ? { code } : {}),
    ...(observation ? { observation } : {}),
  };
}

function isResponseFailedIdentifierKey(key: string): boolean {
  const normalized = key.replace(/[-_\s]/g, "").toLowerCase();
  return (
    (normalized.includes("request") && normalized.endsWith("id")) ||
    (normalized.includes("provider") && normalized.endsWith("id"))
  );
}

function collectResponseFailedIdentifierHashes(input: unknown): string[] {
  const out: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (value: unknown, path: string, depth: number, identifierKey: string): void => {
    if (out.length >= 12 || depth > 4 || !value || typeof value !== "object" || seen.has(value)) {
      return;
    }
    seen.add(value);
    const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
    for (const [key, child] of entries) {
      if (out.length >= 12 || (typeof key === "number" && key >= 8)) {
        break;
      }
      const childPath = typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key;
      const childIdentifierKey = typeof key === "number" ? identifierKey : key;
      const isIdentifier = isResponseFailedIdentifierKey(childIdentifierKey);
      const childString =
        typeof child === "string" || typeof child === "number" ? String(child).trim() : "";
      if (isIdentifier && childString) {
        out.push(`${childPath}=${redactIdentifier(childString, { len: 12 })}`);
      } else {
        visit(child, childPath, depth + 1, isIdentifier ? childIdentifierKey : "");
      }
    }
  };
  visit(input, "", 0, "");
  return out;
}

function redactResponseFailedDiagnosticValue(input: unknown): unknown {
  const seen = new WeakSet<object>();
  const redact = (value: unknown, key: string, depth: number): unknown => {
    if (typeof value === "string" || typeof value === "number") {
      return key && isResponseFailedIdentifierKey(key)
        ? redactIdentifier(String(value), { len: 12 })
        : value;
    }
    if (depth > 6 || !value || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return "<circular>";
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.slice(0, 16).map((item) => redact(item, key, depth + 1));
    }
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = redact(child, childKey, depth + 1);
    }
    return out;
  };
  return redact(input, "", 0);
}

function buildResponsesFailedFailureFields(
  response: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!response) {
    return {};
  }
  const fields: Record<string, unknown> = {};
  for (const key of RESPONSE_FAILED_FAILURE_FIELD_KEYS) {
    if (response[key] !== undefined && response[key] !== null) {
      fields[key] = response[key];
    }
  }
  return fields;
}

function buildResponsesFailedNoDetailsObservation(
  event: Record<string, unknown>,
  model: Model,
  response: Record<string, unknown> | undefined = isRecord(event.response)
    ? event.response
    : undefined,
) {
  const failureFields = redactResponseFailedDiagnosticValue(
    buildResponsesFailedFailureFields(response),
  ) as Record<string, unknown>;
  const metadataKeys = isRecord(response?.metadata)
    ? Object.keys(response.metadata).toSorted()
    : [];
  const responsePreview = {
    id: stringifyUnknown(response?.id),
    status: stringifyUnknown(response?.status),
    model: stringifyUnknown(response?.model),
    object: stringifyUnknown(response?.object),
    failureFields,
    metadataKeys,
  };
  return {
    event: "openai_responses_response_failed_without_details" as const,
    provider: model.provider,
    api: model.api,
    transportModel: model.id,
    providerRuntimeFailureKind: "no_error_details" as const,
    responseId: responsePreview.id,
    responseStatus: responsePreview.status,
    responseModel: responsePreview.model,
    responseObject: responsePreview.object,
    metadataKeys,
    requestIdHashes: collectResponseFailedIdentifierHashes(event),
    failureFieldsPreview: stringifyRedactedEvent(failureFields),
    responsePreview: stringifyRedactedEvent(responsePreview),
  };
}

function summarizeResponsesFailedNoDetailsObservation(
  observation: ResponsesFailedNoDetailsObservation,
): string {
  const requestIds = observation.requestIdHashes.join(",");
  const metadataKeys = observation.metadataKeys.join(",");
  return (
    `responseId=${safeDebugValue(observation.responseId || undefined)} ` +
    `responseStatus=${safeDebugValue(observation.responseStatus || undefined)} ` +
    `responseModel=${safeDebugValue(observation.responseModel || undefined)} ` +
    `requestIds=${requestIds || "none"} metadataKeys=${metadataKeys || "none"} ` +
    `failureFields=${observation.failureFieldsPreview}`
  );
}

export function normalizeResponsesFailedEvent(
  event: Record<string, unknown>,
  model: Model,
): ResponsesFailedEventSummary {
  const response = isRecord(event.response) ? event.response : undefined;
  const responseId = stringifyUnknown(response?.id) || undefined;
  const error = isRecord(response?.error) ? response.error : undefined;
  if (error) {
    const code = stringifyUnknown(error.code).trim();
    const message = stringifyUnknown(error.message).trim();
    if (code || message) {
      return buildResponsesFailedEventSummary(
        `${code || "unknown"}: ${message || "no message"}`,
        responseId,
        code || undefined,
      );
    }
  }
  const incompleteDetails = isRecord(response?.incomplete_details)
    ? response.incomplete_details
    : undefined;
  const incompleteReason = stringifyUnknown(incompleteDetails?.reason);
  if (incompleteReason) {
    return buildResponsesFailedEventSummary(`incomplete: ${incompleteReason}`, responseId);
  }
  return buildResponsesFailedEventSummary(
    RESPONSE_FAILED_NO_DETAILS_MESSAGE,
    responseId,
    undefined,
    buildResponsesFailedNoDetailsObservation(event, model, response),
  );
}

export class ResponsesStreamFailure extends Error {
  readonly responseId?: string;
  readonly response: unknown;
  readonly code?: string;
  readonly observation: ReturnType<typeof normalizeResponsesFailedEvent>["observation"];

  constructor(failure: ReturnType<typeof normalizeResponsesFailedEvent>, response: unknown) {
    super(failure.message);
    this.name = "ResponsesStreamFailure";
    this.responseId = failure.responseId;
    this.response = response;
    this.code = failure.code;
    this.observation = failure.observation;
  }
}

export function logResponsesFailedNoDetails(
  observation: ResponsesFailedNoDetailsObservation,
): void {
  log.warn(
    `[responses] response.failed missing error details provider=${observation.provider} ` +
      `api=${observation.api} model=${observation.transportModel} ` +
      summarizeResponsesFailedNoDetailsObservation(observation),
    observation,
  );
}

export function summarizeResponsesPayload(params: unknown): string {
  if (!params || typeof params !== "object") {
    return "payload=non-object";
  }
  const record = params as Record<string, unknown>;
  const input = record.input;
  const reasoning =
    record.reasoning && typeof record.reasoning === "object"
      ? (record.reasoning as Record<string, unknown>)
      : undefined;
  const text =
    record.text && typeof record.text === "object"
      ? (record.text as Record<string, unknown>)
      : undefined;
  const parts = [
    `fields=${Object.keys(record).toSorted().join(",")}`,
    `model=${safeDebugValue(record.model)}`,
    `stream=${safeDebugValue(record.stream)}`,
    `inputItems=${Array.isArray(input) ? input.length : typeof input}`,
    `inputItemShape=${responseInputItemShape(input)}`,
    `inputRoles=${responseInputRoles(input) || "none"}`,
    `inputTextChars=${responseInputTextChars(input)}`,
    `tools=${summarizeResponsesTools(record.tools)}`,
    `reasoningEffort=${safeDebugValue(reasoning?.effort)}`,
    `reasoningSummary=${safeDebugValue(reasoning?.summary)}`,
    `textVerbosity=${safeDebugValue(text?.verbosity)}`,
    `serviceTier=${safeDebugValue(record.service_tier)}`,
    ...summarizeResponsesCompactionItems(input),
    `store=${safeDebugValue(record.store)}`,
    `promptCacheKey=${record.prompt_cache_key === undefined ? "absent" : "present"}`,
    `metadataKeys=${
      record.metadata && typeof record.metadata === "object"
        ? Object.keys(record.metadata).toSorted().join(",")
        : "none"
    }`,
  ];
  if (resolveModelPayloadDebugMode() === "full-redacted") {
    parts.push(`payload=${stringifyRedactedPayload(record)}`);
  }
  return parts.join(" ");
}

export function summarizeOpenAITransportError(error: unknown): string {
  if (!error || typeof error !== "object") {
    return `type=${typeof error} message=${safeDebugValue(error)}`;
  }
  const record = error as Record<string, unknown>;
  const cause =
    record.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : undefined;
  return [
    `name=${safeDebugValue(record.name)}`,
    `status=${safeDebugValue(record.status)}`,
    `code=${safeDebugValue(record.code)}`,
    `type=${safeDebugValue(record.type)}`,
    `causeName=${safeDebugValue(cause?.name)}`,
    `causeCode=${safeDebugValue(cause?.code)}`,
    `message=${error instanceof Error ? error.message : safeDebugValue(error)}`,
  ].join(" ");
}
