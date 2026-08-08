/**
 * Shared provider HTTP error normalization helpers.
 *
 * Transport adapters use this module to turn provider-specific response bodies,
 * request ids, and binary payload guardrails into stable OpenClaw error shapes.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
export { asFiniteNumber } from "../../packages/normalization-core/src/number-coercion.js";
import { normalizeOptionalString as trimToUndefined } from "../../packages/normalization-core/src/string-coerce.js";
import {
  readResponseTextPrefix,
  readResponseWithLimit,
  type ReadResponseTextPrefixOptions,
} from "../infra/http-body.js";
import { redactSensitiveText, redactToolPayloadText } from "../logging/redact.js";
export { asBoolean } from "../utils/boolean.js";
export { normalizeOptionalString as trimToUndefined } from "../../packages/normalization-core/src/string-coerce.js";

const ERROR_BODY_METADATA_LIMIT = 500;
const PROVIDER_BINARY_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const PROVIDER_JSON_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const PROVIDER_TEXT_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;

/** Shared timeout and byte-limit options for provider response consumption. */
type ProviderResponseReadOptions = ReadResponseTextPrefixOptions & {
  maxBytes?: number;
  onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
};

/** Options for bounded provider error-body normalization. */
type ProviderHttpErrorOptions = {
  statusPrefix?: string;
  bodyTimeoutMs?: ReadResponseTextPrefixOptions["timeoutMs"];
  onBodyTimeout?: NonNullable<ReadResponseTextPrefixOptions["onTimeout"]>;
  sensitiveValues?: readonly string[];
};

class ProviderErrorBodyTimeout extends Error {
  readonly timeoutError: unknown;

  constructor(timeoutError: unknown) {
    super(timeoutError instanceof Error ? timeoutError.message : String(timeoutError), {
      cause: timeoutError,
    });
    this.name = "ProviderErrorBodyTimeout";
    this.timeoutError = timeoutError;
  }
}

/** Returns a plain object view for provider JSON payloads when one exists. */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Trims provider error details to a log- and prompt-safe preview length. */
export function truncateErrorDetail(detail: string, limit = 220): string {
  return detail.length <= limit ? detail : `${truncateUtf16Safe(detail, limit - 1)}…`;
}

function redactProviderErrorText(body: string, sensitiveValues?: readonly string[]): string {
  return sensitiveValues?.length
    ? redactToolPayloadText(body, { exactSecretValues: sensitiveValues })
    : redactSensitiveText(body);
}

async function readResponseTextLimitedResult(
  response: Response,
  limitBytes: number,
  options?: ReadResponseTextPrefixOptions,
) {
  return await readResponseTextPrefix(response, limitBytes, {
    chunkTimeoutMs: options?.chunkTimeoutMs ?? 10_000,
    onIdleTimeout:
      options?.onIdleTimeout ??
      (({ chunkTimeoutMs }) => new Error(`error body read stalled for ${chunkTimeoutMs}ms`)),
    timeoutMs: options?.timeoutMs,
    onTimeout: options?.onTimeout,
  });
}

/** Redacts secrets before preserving a bounded provider error body preview. */
function redactProviderErrorBody(body: string, sensitiveValues?: readonly string[]): string {
  return truncateErrorDetail(
    redactProviderErrorText(body, sensitiveValues),
    ERROR_BODY_METADATA_LIMIT,
  );
}

/**
 * Reads at most `limitBytes` without buffering provider-sized failures.
 * Request secrets are redacted before a partial value can survive the byte boundary.
 */
export async function readResponseTextLimited(
  response: Response,
  limitBytes = 16 * 1024,
  options?: ReadResponseTextPrefixOptions & { sensitiveValues?: readonly string[] },
): Promise<string> {
  if (limitBytes <= 0) {
    return "";
  }
  const result = await readResponseTextLimitedResult(response, limitBytes, options);
  return options?.sensitiveValues?.length
    ? redactToolPayloadText(result.text, {
        exactSecretValues: options.sensitiveValues,
        sourceTruncated: result.truncated,
      })
    : result.text;
}

/** Reads a successful provider text response under a byte cap. */
export async function readProviderTextResponse(
  response: Response,
  label: string,
  opts?: ProviderResponseReadOptions,
): Promise<string> {
  const maxBytes = opts?.maxBytes ?? PROVIDER_TEXT_RESPONSE_MAX_BYTES;
  const bytes = await readResponseWithLimit(response, maxBytes, {
    chunkTimeoutMs: opts?.chunkTimeoutMs ?? 30_000,
    onIdleTimeout:
      opts?.onIdleTimeout ??
      (({ chunkTimeoutMs }) =>
        new Error(`${label}: response body stalled for ${chunkTimeoutMs}ms`)),
    timeoutMs: opts?.timeoutMs,
    onTimeout: opts?.onTimeout,
    onOverflow: ({ maxBytes: maxBytesLocal }) =>
      new Error(`${label}: text response exceeds ${maxBytesLocal} bytes`),
  });
  return new TextDecoder().decode(bytes);
}

type ProviderErrorPayloadFields = {
  message?: string;
  code?: string;
  type?: string;
};

function extractProviderErrorPayloadFields(
  payload: unknown,
): ProviderErrorPayloadFields | undefined {
  const root = asObject(payload);
  const detailObject = asObject(root?.detail);
  const subject = asObject(root?.error) ?? detailObject ?? root;
  if (!subject) {
    return undefined;
  }
  const errorDescription =
    trimToUndefined(subject.error_description) ?? trimToUndefined(root?.error_description);
  const oauthCode = errorDescription ? trimToUndefined(root?.error) : undefined;
  const message =
    trimToUndefined(subject.message) ??
    trimToUndefined(subject.detail) ??
    errorDescription ??
    trimToUndefined(root?.message) ??
    trimToUndefined(root?.error) ??
    trimToUndefined(root?.detail);
  const type = trimToUndefined(subject.type);
  const code = trimToUndefined(subject.code) ?? trimToUndefined(subject.status) ?? oauthCode;
  return {
    ...(message ? { message } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  };
}

function formatProviderErrorFields(fields: ProviderErrorPayloadFields): string | undefined {
  const metadata = [
    fields.type ? `type=${fields.type}` : undefined,
    fields.code ? `code=${fields.code}` : undefined,
  ]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  if (fields.message && metadata) {
    return `${truncateErrorDetail(fields.message)} [${metadata}]`;
  }
  if (fields.message) {
    return truncateErrorDetail(fields.message);
  }
  if (metadata) {
    return `[${metadata}]`;
  }
  return undefined;
}

/** Formats common provider JSON error payload shapes into one readable detail string. */
export function formatProviderErrorPayload(payload: unknown): string | undefined {
  const fields = extractProviderErrorPayloadFields(payload);
  return fields ? formatProviderErrorFields(fields) : undefined;
}

type ProviderErrorPayloadMetadata = {
  detail?: string;
  code?: string;
  type?: string;
};

function extractProviderErrorPayloadMetadata(
  payload: unknown,
  sensitiveValues?: readonly string[],
): ProviderErrorPayloadMetadata {
  const fields = extractProviderErrorPayloadFields(payload);
  if (!fields) {
    return {};
  }
  // Redact before the detail cap; truncating first can retain an unmatched secret prefix.
  const message = fields.message
    ? redactProviderErrorText(fields.message, sensitiveValues)
    : undefined;
  const code = fields.code ? redactProviderErrorText(fields.code, sensitiveValues) : undefined;
  const type = fields.type ? redactProviderErrorText(fields.type, sensitiveValues) : undefined;
  const detail = formatProviderErrorFields({ message, code, type });
  return {
    ...(detail ? { detail } : {}),
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  };
}

/** Metadata extracted from a non-2xx provider response body and headers. */
type ProviderHttpErrorInfo = {
  detail?: string;
  code?: string;
  type?: string;
  body?: string;
  requestId?: string;
};

/** Extracts normalized provider error metadata while keeping the raw body bounded and redacted. */
async function extractProviderErrorInfo(
  response: Response,
  options?: ProviderHttpErrorOptions,
): Promise<ProviderHttpErrorInfo> {
  const bodyTimeoutMs = options?.bodyTimeoutMs;
  const bodyRead = await readResponseTextLimitedResult(response, 16 * 1024, {
    timeoutMs:
      typeof bodyTimeoutMs === "function"
        ? () => {
            try {
              return bodyTimeoutMs();
            } catch (error) {
              throw new ProviderErrorBodyTimeout(error);
            }
          }
        : bodyTimeoutMs,
    onTimeout: (params) =>
      new ProviderErrorBodyTimeout(
        options?.onBodyTimeout?.(params) ??
          new Error(`Provider error body timed out after ${params.timeoutMs}ms`),
      ),
  }).catch((error: unknown) => {
    if (error instanceof ProviderErrorBodyTimeout) {
      throw error.timeoutError;
    }
    return { text: "", size: 0, truncated: false };
  });
  const rawBody = trimToUndefined(bodyRead.text);
  const rawRequestId = extractProviderRequestId(response);
  const requestId = rawRequestId
    ? redactProviderErrorText(rawRequestId, options?.sensitiveValues)
    : undefined;
  if (!rawBody) {
    return requestId ? { requestId } : {};
  }
  if (bodyRead.truncated && options?.sensitiveValues?.length) {
    const body = truncateErrorDetail(
      redactToolPayloadText(rawBody, {
        exactSecretValues: options.sensitiveValues,
        sourceTruncated: true,
      }),
      ERROR_BODY_METADATA_LIMIT,
    );
    return {
      detail: body,
      body,
      ...(requestId ? { requestId } : {}),
    };
  }
  const body = redactProviderErrorBody(rawBody, options?.sensitiveValues);
  try {
    const metadata = extractProviderErrorPayloadMetadata(
      JSON.parse(rawBody),
      options?.sensitiveValues,
    );
    return {
      ...(metadata.detail ? { detail: metadata.detail } : { detail: body }),
      ...(metadata.code ? { code: metadata.code } : {}),
      ...(metadata.type ? { type: metadata.type } : {}),
      body,
      ...(requestId ? { requestId } : {}),
    };
  } catch {
    return {
      detail: body,
      body,
      ...(requestId ? { requestId } : {}),
    };
  }
}

/** Returns only the normalized provider detail string for callers that do not need metadata. */
export async function extractProviderErrorDetail(
  response: Response,
  options?: ProviderHttpErrorOptions,
): Promise<string | undefined> {
  return (await extractProviderErrorInfo(response, options)).detail;
}

/** Reads the provider request id header variants used across model and media APIs. */
export function extractProviderRequestId(response: Response): string | undefined {
  return (
    trimToUndefined(response.headers.get("x-request-id")) ??
    trimToUndefined(response.headers.get("request-id"))
  );
}

/** Error type carrying normalized provider status, request id, code, type, and body metadata. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly statusCode: number;
  readonly code?: string;
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly errorBody?: string;
  readonly requestId?: string;

  constructor(
    message: string,
    params: {
      status: number;
      code?: string;
      type?: string;
      body?: string;
      requestId?: string;
    },
  ) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = params.status;
    this.statusCode = params.status;
    this.code = params.code;
    this.errorCode = params.code;
    this.errorType = params.type;
    this.errorBody = params.body;
    this.requestId = params.requestId;
  }
}

/** Builds the human-facing provider HTTP error message from normalized metadata. */
export function formatProviderHttpErrorMessage(params: {
  label: string;
  status: number;
  detail?: string;
  requestId?: string;
  statusPrefix?: string;
}): string {
  const { label, status, detail, requestId, statusPrefix = "" } = params;
  return (
    `${label} (${statusPrefix}${status})` +
    (detail ? `: ${detail}` : "") +
    (requestId ? ` [request_id=${requestId}]` : "")
  );
}

/** Creates a normalized provider HTTP error from a failed response. */
export async function createProviderHttpError(
  response: Response,
  label: string,
  options?: ProviderHttpErrorOptions,
): Promise<Error> {
  const info = await extractProviderErrorInfo(response, options);
  return new ProviderHttpError(
    formatProviderHttpErrorMessage({
      label,
      status: response.status,
      detail: info.detail,
      requestId: info.requestId,
      statusPrefix: options?.statusPrefix,
    }),
    {
      status: response.status,
      code: info.code,
      type: info.type,
      body: info.body,
      requestId: info.requestId,
    },
  );
}

/** Throws a normalized provider error when a fetch response is not OK. */
export async function assertOkOrThrowProviderError(
  response: Response,
  label: string,
  options?: Omit<ProviderHttpErrorOptions, "statusPrefix">,
): Promise<void> {
  if (response.ok) {
    return;
  }
  throw await createProviderHttpError(response, label, options);
}

/** Throws a normalized generic HTTP error when a fetch response is not OK. */
export async function assertOkOrThrowHttpError(
  response: Response,
  label: string,
  options?: Omit<ProviderHttpErrorOptions, "statusPrefix">,
): Promise<void> {
  if (response.ok) {
    return;
  }
  throw await createProviderHttpError(response, label, { ...options, statusPrefix: "HTTP " });
}

/**
 * Parses a provider JSON response under a byte cap and wraps malformed JSON with the caller's label.
 *
 * The body is read through the same bounded reader as binary responses so a provider that streams an
 * unbounded JSON body cannot force the runtime to buffer the whole payload before parsing.
 */
export async function readProviderJsonResponse<T>(
  response: Response,
  label: string,
  opts?: ProviderResponseReadOptions,
): Promise<T> {
  const maxBytes = opts?.maxBytes ?? PROVIDER_JSON_RESPONSE_MAX_BYTES;
  const bytes = await readResponseWithLimit(response, maxBytes, {
    chunkTimeoutMs: opts?.chunkTimeoutMs ?? 30_000,
    onIdleTimeout:
      opts?.onIdleTimeout ??
      (({ chunkTimeoutMs }) =>
        new Error(`${label}: response body stalled for ${chunkTimeoutMs}ms`)),
    timeoutMs: opts?.timeoutMs,
    onTimeout: opts?.onTimeout,
    onOverflow: ({ maxBytes: maxBytesLocal }) =>
      new Error(`${label}: JSON response exceeds ${maxBytesLocal} bytes`),
  });
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch (cause) {
    throw new Error(`${label}: malformed JSON response`, { cause });
  }
}

/** Parses a provider JSON response that must be a top-level object. */
export async function readProviderJsonObjectResponse(
  response: Response,
  label: string,
  opts?: ProviderResponseReadOptions,
): Promise<Record<string, unknown>> {
  const payload = await readProviderJsonResponse<unknown>(response, label, opts);
  const object = asObject(payload);
  if (!object) {
    throw new Error(`${label}: malformed JSON response`);
  }
  return object;
}

/** Parses a provider JSON object response and returns an array field. */
export async function readProviderJsonArrayFieldResponse(
  response: Response,
  label: string,
  field: string,
  opts?: ProviderResponseReadOptions,
): Promise<unknown[]> {
  const payload = await readProviderJsonObjectResponse(response, label, opts);
  const value = payload[field];
  if (!Array.isArray(value)) {
    throw new Error(`${label}: malformed JSON response`);
  }
  return value;
}

function normalizeContentType(response: Response): string | undefined {
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return contentType || undefined;
}

/** Rejects text or JSON responses on provider endpoints that should return binary bytes. */
export function assertProviderBinaryResponseContent(
  response: Response,
  label: string,
  kind = "binary",
): void {
  const contentType = normalizeContentType(response);
  if (!contentType) {
    return;
  }
  if (
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType.startsWith("text/")
  ) {
    throw new Error(`${label}: malformed ${kind} response`);
  }
}

/** Reads a bounded non-empty binary provider response after content-type validation. */
export async function readProviderBinaryResponse(
  response: Response,
  label: string,
  kind = "binary",
  opts?: ProviderResponseReadOptions,
): Promise<Uint8Array> {
  try {
    assertProviderBinaryResponseContent(response, label, kind);
  } catch (error) {
    // A captured response may be teed; do not await cancellation before its
    // rejected branch and dispatcher can be released.
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const maxBytes = opts?.maxBytes ?? PROVIDER_BINARY_RESPONSE_MAX_BYTES;
  const bytes = await readResponseWithLimit(response, maxBytes, {
    ...opts,
    onOverflow:
      opts?.onOverflow ??
      (({ maxBytes: maxBytesLocal }) =>
        new Error(`${label}: ${kind} response exceeds ${maxBytesLocal} bytes`)),
  });
  if (bytes.byteLength === 0) {
    throw new Error(`${label}: malformed ${kind} response`);
  }
  return bytes;
}
