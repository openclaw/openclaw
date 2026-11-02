import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readTransportDiagnosticLabel } from "../utils/provider-error.js";
import { emitModelTransportError, resolveModelPayloadDebugMode } from "./model-transport-debug.js";
import { RESPONSE_FAILED_NO_DETAILS_MESSAGE } from "./openai-responses-contracts.js";
import { log } from "./openai-transport-shared.js";
import { redactIdentifier, sha256Hex } from "./transport-utils.js";

function stringifyUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
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

function readResponsesToolDisplayName(tool: unknown): string {
  if (!tool || typeof tool !== "object") {
    return "";
  }
  const record = tool as Record<string, unknown>;
  const name = record.name;
  if (typeof name === "string") {
    return name;
  }
  const fn = record.function;
  if (fn && typeof fn === "object") {
    const fnName = (fn as Record<string, unknown>).name;
    if (typeof fnName === "string") {
      return fnName;
    }
  }
  const type = record.type;
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
      const normalizedKey = childIdentifierKey.replace(/[-_\s]/g, "").toLowerCase();
      const isIdentifier =
        (normalizedKey.includes("request") && normalizedKey.endsWith("id")) ||
        (normalizedKey.includes("provider") && normalizedKey.endsWith("id"));
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

function buildResponsesFailedNoDetailsObservation(
  event: Record<string, unknown>,
  model: Model,
  response: Record<string, unknown> | undefined,
) {
  const failureFieldNames = RESPONSE_FAILED_FAILURE_FIELD_KEYS.filter(
    (key) => response?.[key] !== undefined && response[key] !== null,
  );
  const metadataKeys = isRecord(response?.metadata)
    ? Object.keys(response.metadata).toSorted()
    : [];
  return {
    event: "openai_responses_response_failed_without_details" as const,
    provider: model.provider,
    api: model.api,
    transportModel: model.id,
    providerRuntimeFailureKind: "no_error_details" as const,
    responseId: stringifyUnknown(response?.id),
    responseStatus: stringifyUnknown(response?.status),
    responseModel: stringifyUnknown(response?.model),
    responseObject: stringifyUnknown(response?.object),
    metadataKeys,
    requestIdHashes: collectResponseFailedIdentifierHashes(event),
    failureFieldNames,
  };
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

function logResponsesFailedNoDetails(observation: ResponsesFailedNoDetailsObservation): void {
  const requestIds = observation.requestIdHashes.join(",");
  const metadataKeys = observation.metadataKeys.join(",");
  log.warn(
    `[responses] response.failed missing error details provider=${observation.provider} ` +
      `api=${observation.api} model=${observation.transportModel} ` +
      `responseId=${safeDebugValue(observation.responseId || undefined)} ` +
      `responseStatus=${safeDebugValue(observation.responseStatus || undefined)} ` +
      `responseModel=${safeDebugValue(observation.responseModel || undefined)} ` +
      `requestIds=${requestIds || "none"} metadataKeys=${metadataKeys || "none"} ` +
      `failureFields=${observation.failureFieldNames.join(",") || "none"}`,
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
  return parts.join(" ");
}

const ABORT_REASON_LABELS = new Map([
  ["LlmIdleTimeoutError", "idle_timeout"],
  ["LlmNoProgressError", "no_progress"],
  ["FirstStreamEventTimeoutError", "first_event_timeout"],
  ["OPENCLAW_SESSION_WATCHDOG", "session_watchdog"],
  ["degenerate_output", "degenerate_output"],
  ["OPENCLAW_RESTART_ABORT", "restart"],
  ["ERR_STALE_GATEWAY_LIFECYCLE", "restart"],
  ["AGENT_RUN_SUPERSEDED_ABORT", "superseded"],
]);

function resolveOpenAITransportAbortReason(signal?: AbortSignal): string | undefined {
  if (!signal?.aborted) {
    return undefined;
  }
  const reason = isRecord(signal.reason) ? signal.reason : undefined;
  const defaultReason = reason?.name === "TimeoutError" ? "request_deadline" : "caller_abort";
  // Only classify the request signal; provider errors can echo message/tool content.
  const reasonKey = reason?.code ?? reason?.name;
  return (
    (typeof reasonKey === "string" ? ABORT_REASON_LABELS.get(reasonKey) : undefined) ??
    defaultReason
  );
}

function summarizeOpenAITransportError(error: unknown, signal?: AbortSignal): string {
  const record = isRecord(error) ? error : undefined;
  const cause =
    record?.cause && typeof record.cause === "object"
      ? (record.cause as Record<string, unknown>)
      : undefined;
  const parts = record
    ? Object.entries({
        name: readTransportDiagnosticLabel(record.name),
        status: readTransportDiagnosticLabel(record.status),
        code: readTransportDiagnosticLabel(record.code),
        type: readTransportDiagnosticLabel(record.type),
        causeName: readTransportDiagnosticLabel(cause?.name),
        causeCode: readTransportDiagnosticLabel(cause?.code),
      }).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]))
    : [`type=${typeof error}`];
  const abortReason = resolveOpenAITransportAbortReason(signal);
  if (abortReason) {
    parts.push(`abortReason=${abortReason}`);
  }
  return parts.join(" ");
}

/** Protocol-specific labels join the shared failure line; caller aborts keep their own diagnostic. */
export function observeResponsesTransportFailure(params: {
  error: unknown;
  model: Model;
  output: AssistantMessage;
  signal?: AbortSignal;
  requestSignal?: AbortSignal;
}) {
  const { error, model, output, signal, requestSignal } = params;
  if (error instanceof ResponsesStreamFailure && error.observation) {
    logResponsesFailedNoDetails(error.observation);
  }
  const incomplete = output.diagnostics?.find(({ type }) => type === "openai_responses_terminal")
    ?.details?.incompleteReason;
  const incompleteReason = typeof incomplete === "string" ? incomplete : undefined;
  if (signal?.aborted) {
    emitModelTransportError(
      log,
      "responses",
      () =>
        `provider=${model.provider} api=${model.api} model=${model.id} ` +
        summarizeOpenAITransportError(error, requestSignal) +
        (incompleteReason ? ` incompleteReason=${incompleteReason}` : ""),
      signal,
    );
    return undefined;
  }
  return { abortReason: resolveOpenAITransportAbortReason(requestSignal), incompleteReason };
}
