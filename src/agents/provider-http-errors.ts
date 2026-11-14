import { mediaKindFromMime } from "@openclaw/media-core/constants";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { readTransportDiagnosticLabel } from "../../packages/ai/src/utils/provider-error.js";
import { normalizeOptionalString as trimToUndefined } from "../../packages/normalization-core/src/string-coerce.js";
import {
  readResponseTextPrefix,
  readResponseWithLimit,
  type ReadResponseTextPrefixOptions,
} from "../infra/http-body.js";
import { parseRetryAfterHeaderSeconds } from "../infra/retry-after.js";
import { redactSensitiveText, redactToolPayloadText } from "../logging/redact.js";
import type { ModelProviderRequestTransportOverrides } from "./provider-request-config.types.js";
import {
  collectRequestHeaderSecretValues,
  createExactSecretValueMatcher,
  createExactSecretValueRedactor,
  redactProviderResponseErrorText,
} from "./provider-request-header-redaction.js";
export { asFiniteNumber } from "../../packages/normalization-core/src/number-coercion.js";
export { asBoolean } from "../utils/boolean.js";
export { normalizeOptionalString as trimToUndefined } from "../../packages/normalization-core/src/string-coerce.js";

const ERROR_BODY_METADATA_LIMIT = 500;
const PROVIDER_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const SHORT_BEARER_TOKEN_PATTERN =
  /\b(Bearer)\s+[-A-Za-z0-9._~+/=]{1,17}(?![-A-Za-z0-9._~+/=…])/giu;

type ProviderErrorTextRedactionContext = {
  truncated?: boolean;
};

function extractHeaderCredential(headers: Headers, headerName: string, prefix = ""): string {
  const value = headers.get(headerName) ?? "";
  return prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

type ProviderRequestCredentialContext = {
  headers: Headers;
  request?: ModelProviderRequestTransportOverrides;
  /** Configured header names, excluding automatic transport defaults. Values come from headers. */
  configuredHeaderNames?: readonly string[];
  defaultAuthHeader: string;
  defaultAuthPrefix?: string;
};

function collectProviderRequestCredentialValues(
  params: ProviderRequestCredentialContext,
): string[] {
  const auth = params.request?.auth;
  const headers: [string, string][] = [];
  const names = new Set(
    [
      params.defaultAuthHeader,
      "Authorization",
      "Proxy-Authorization",
      ...(params.configuredHeaderNames ?? []),
      ...Object.keys(params.request?.headers ?? {}),
      ...(auth?.mode === "header" ? [auth.headerName] : []),
    ].map((name) => name.toLowerCase()),
  );
  for (const name of names) {
    const value = params.headers.get(name);
    if (value) {
      headers.push([name, value]);
    }
  }
  return [
    ...collectRequestHeaderSecretValues(headers),
    extractHeaderCredential(params.headers, params.defaultAuthHeader, params.defaultAuthPrefix),
    auth?.mode === "header"
      ? extractHeaderCredential(params.headers, auth.headerName, auth.prefix ?? "")
      : "",
  ];
}

/** Successful provider results must match actual credentials, not diagnostic redaction patterns. */
export function createProviderCredentialMatcher(
  params: ProviderRequestCredentialContext,
): (text: string) => boolean {
  return createExactSecretValueMatcher(collectProviderRequestCredentialValues(params));
}

/** Builds a redactor for response text that may reflect the request's active credential. */
export function createProviderErrorTextRedactor(
  params: ProviderRequestCredentialContext,
): (text: string, context?: ProviderErrorTextRedactionContext) => string {
  const credentials = collectProviderRequestCredentialValues(params);
  // Unused redactors must not prepare patterns on successful request paths.
  let redactCredentials: ReturnType<typeof createExactSecretValueRedactor> | undefined;
  return (text, context) => {
    const withoutActiveCredential = (redactCredentials ??=
      createExactSecretValueRedactor(credentials))(text, context?.truncated === true);
    return redactToolPayloadText(withoutActiveCredential).replace(
      SHORT_BEARER_TOKEN_PATTERN,
      "$1 ***",
    );
  };
}

type ProviderResponseReadOptions = ReadResponseTextPrefixOptions & {
  maxBytes?: number;
  onOverflow?: (params: { size: number; maxBytes: number; res: Response }) => Error;
  /** Credentials that must not appear in malformed-response diagnostics. */
  requestHeaders?: HeadersInit;
  /** Caller-facing message for malformed JSON or a non-object JSON response. */
  malformedResponseError?: string;
};

function readProviderResponseBytes(
  response: Response,
  label: string,
  kind: string,
  opts?: ProviderResponseReadOptions,
): Promise<Buffer> {
  return readResponseWithLimit(response, opts?.maxBytes ?? PROVIDER_RESPONSE_MAX_BYTES, {
    ...opts,
    chunkTimeoutMs: opts?.chunkTimeoutMs ?? 30_000,
    onIdleTimeout:
      opts?.onIdleTimeout ??
      (({ chunkTimeoutMs }) =>
        new Error(`${label}: response body stalled for ${chunkTimeoutMs}ms`)),
    onOverflow:
      opts?.onOverflow ??
      (({ maxBytes: limit }) => new Error(`${label}: ${kind} response exceeds ${limit} bytes`)),
  });
}

type ProviderHttpErrorOptions = {
  statusPrefix?: string;
  signal?: AbortSignal;
  maxBodyBytes?: number;
  bodyTimeoutMs?: ReadResponseTextPrefixOptions["timeoutMs"];
  onBodyTimeout?: NonNullable<ReadResponseTextPrefixOptions["onTimeout"]>;
  /** Scrub reflected request credentials before retaining response diagnostics. */
  requestHeaders?: HeadersInit;
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

/** Summarizes transport failures before the logger applies diagnostic redaction. */
export function summarizeProviderTransportError(error: unknown): string {
  const record = asOptionalObjectRecord(error);
  if (!record) {
    return `type=${typeof error}`;
  }
  const cause = asOptionalObjectRecord(record.cause);
  return Object.entries({
    name: readTransportDiagnosticLabel(record.name),
    code: readTransportDiagnosticLabel(record.code),
    causeName: readTransportDiagnosticLabel(cause?.name),
    causeCode: readTransportDiagnosticLabel(cause?.code),
  })
    .flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`]))
    .join(" ");
}

/** Trims provider error details to a log- and prompt-safe preview length. */
export function truncateErrorDetail(detail: string, limit = 220): string {
  return detail.length <= limit ? detail : `${truncateUtf16Safe(detail, limit - 1)}…`;
}

/** Redacts secrets before preserving a bounded provider error body preview. */
function redactProviderErrorBody(body: string): string {
  return truncateErrorDetail(redactSensitiveText(body), ERROR_BODY_METADATA_LIMIT);
}

/** Reads at most `limitBytes` from a response body without buffering provider-sized failures. */
export async function readResponseTextLimited(
  response: Response,
  limitBytes = 16 * 1024,
  options?: ReadResponseTextPrefixOptions,
): Promise<string> {
  if (limitBytes <= 0) {
    return "";
  }
  return (
    await readResponseTextPrefix(response, limitBytes, {
      signal: options?.signal,
      chunkTimeoutMs: options?.chunkTimeoutMs ?? 10_000,
      onIdleTimeout:
        options?.onIdleTimeout ??
        (({ chunkTimeoutMs }) => new Error(`error body read stalled for ${chunkTimeoutMs}ms`)),
      timeoutMs: options?.timeoutMs,
      onTimeout: options?.onTimeout,
    })
  ).text;
}

/** Reads a successful provider text response under a byte cap. */
export async function readProviderTextResponse(
  response: Response,
  label: string,
  opts?: ProviderResponseReadOptions,
): Promise<string> {
  const bytes = await readProviderResponseBytes(response, label, "text", opts);
  return new TextDecoder().decode(bytes);
}

type ProviderErrorPayloadMetadata = {
  detail?: string;
  code?: string;
  type?: string;
};

function resolveProviderErrorPayloadMetadata(payload: unknown): ProviderErrorPayloadMetadata {
  const root = asOptionalRecord(payload);
  const detailObject = asOptionalRecord(root?.detail);
  const subject = asOptionalRecord(root?.error) ?? detailObject ?? root;
  if (!subject) {
    return { detail: undefined };
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
  const metadata = [type ? `type=${type}` : undefined, code ? `code=${code}` : undefined]
    .filter((value): value is string => Boolean(value))
    .join(", ");
  const detail = message
    ? `${truncateErrorDetail(message)}${metadata ? ` [${metadata}]` : ""}`
    : metadata
      ? `[${metadata}]`
      : undefined;
  return { detail, code, type };
}

export function formatProviderErrorPayload(payload: unknown): string | undefined {
  return resolveProviderErrorPayloadMetadata(payload).detail;
}

type ProviderHttpErrorInfo = ProviderErrorPayloadMetadata & {
  body?: string;
  requestId?: string;
  retryAfterMs?: number;
};

/** Extracts normalized provider error metadata while keeping the raw body bounded and redacted. */
async function extractProviderErrorInfo(
  response: Response,
  options?: ProviderHttpErrorOptions,
): Promise<ProviderHttpErrorInfo> {
  const bodyTimeoutMs = options?.bodyTimeoutMs;
  const prefix = await readResponseTextPrefix(response, options?.maxBodyBytes ?? 16 * 1024, {
    signal: options?.signal,
    chunkTimeoutMs: 10_000,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`error body read stalled for ${chunkTimeoutMs}ms`),
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
    options?.signal?.throwIfAborted();
    if (error instanceof ProviderErrorBodyTimeout) {
      throw error.timeoutError;
    }
    // Fetch keeps its request deadline active while the response body is consumed.
    if (error instanceof Error && error.name === "TimeoutError") {
      throw error;
    }
    return undefined;
  });
  options?.signal?.throwIfAborted();
  const rawRequestId = extractProviderRequestId(response);
  const requestId =
    rawRequestId && options?.requestHeaders
      ? redactProviderResponseErrorText(rawRequestId, options.requestHeaders)
      : rawRequestId;
  const rawBody = trimToUndefined(prefix?.text);
  const retryAfterSeconds = parseRetryAfterHeaderSeconds(response.headers.get("Retry-After"));
  const headerRetryAfterMs =
    retryAfterSeconds === undefined ? undefined : Math.ceil(retryAfterSeconds * 1000);
  if (!rawBody) {
    return { requestId, retryAfterMs: headerRetryAfterMs };
  }
  // Redact before metadata extraction or preview truncation can split a credential.
  const safeBody = options?.requestHeaders
    ? redactProviderResponseErrorText(rawBody, options.requestHeaders, {
        sourceTruncated: prefix?.truncated,
      })
    : rawBody;
  const body = redactProviderErrorBody(safeBody);
  try {
    const metadata = resolveProviderErrorPayloadMetadata(JSON.parse(safeBody));
    return {
      // Public formatting stays raw; HTTP details are redacted before choosing the fallback.
      detail: (metadata.detail && redactSensitiveText(metadata.detail)) || body,
      code: metadata.code,
      type: metadata.type,
      retryAfterMs: headerRetryAfterMs,
      body,
      requestId,
    };
  } catch {
    return {
      detail: body,
      body,
      requestId,
      retryAfterMs: headerRetryAfterMs,
    };
  }
}

export async function extractProviderErrorDetail(response: Response): Promise<string | undefined> {
  return (await extractProviderErrorInfo(response)).detail;
}

export function extractProviderRequestId(response: Response): string | undefined {
  return (
    trimToUndefined(response.headers.get("x-request-id")) ??
    trimToUndefined(response.headers.get("request-id"))
  );
}

export class ProviderHttpError extends Error {
  readonly status: number;
  readonly statusCode: number;
  retryAfterMs?: number;
  readonly code?: string;
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly errorBody?: string;
  readonly requestId?: string;

  constructor(message: string, params: Omit<ProviderHttpErrorInfo, "detail"> & { status: number }) {
    super(message);
    this.name = "ProviderHttpError";
    this.status = params.status;
    this.statusCode = params.status;
    this.code = params.code;
    this.errorCode = params.code;
    this.errorType = params.type;
    this.errorBody = params.body;
    this.requestId = params.requestId;
    this.retryAfterMs = params.retryAfterMs;
  }
}

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

export async function createProviderHttpError(
  response: Response,
  label: string,
  options?: ProviderHttpErrorOptions,
): Promise<ProviderHttpError> {
  const { detail, ...info } = await extractProviderErrorInfo(response, options);
  return new ProviderHttpError(
    formatProviderHttpErrorMessage({
      label,
      status: response.status,
      detail,
      requestId: info.requestId,
      statusPrefix: options?.statusPrefix,
    }),
    {
      status: response.status,
      ...info,
    },
  );
}

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
  const bytes = await readProviderResponseBytes(response, label, "JSON", opts);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch (cause) {
    const error = new Error(
      `${label}: malformed JSON response`,
      opts?.requestHeaders ? undefined : { cause },
    );
    throw opts?.malformedResponseError === undefined
      ? error
      : new Error(opts.malformedResponseError, { cause: error });
  }
}

export async function readProviderJsonObjectResponse(
  response: Response,
  label: string,
  opts?: ProviderResponseReadOptions,
): Promise<Record<string, unknown>> {
  const payload = await readProviderJsonResponse<unknown>(response, label, opts);
  const object = asOptionalRecord(payload);
  if (!object) {
    throw new Error(opts?.malformedResponseError ?? `${label}: malformed JSON response`);
  }
  return object;
}

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

// One HTTP media type, with token or quoted parameters (including escaped codec
// commas) and empty parameter slots. Fetch combines repeated headers with commas
// outside those quotes.
const providerMediaContentTypePattern =
  /^[!#$%&'*+.^_`|~\da-z-]+\/[!#$%&'*+.^_`|~\da-z-]+(?:[ \t]*;(?:[ \t]*[!#$%&'*+.^_`|~\da-z-]+[ \t]*=[ \t]*(?:[!#$%&'*+.^_`|~\da-z-]+|"(?:[\t !#-[\]-~\x80-\xff]|\\[\t !-~\x80-\xff])*"))?)*[ \t]*$/iu;

/** Rejects non-binary responses and mismatched provider-owned audio/video families. */
export function assertProviderBinaryResponseContent(
  response: Response,
  label: string,
  kind = "binary",
): void {
  const rawContentType = response.headers.get("content-type");
  if (rawContentType === null) {
    return;
  }
  const contentType = rawContentType.split(";")[0]?.trim().toLowerCase();
  const requiresMediaFamily = kind === "audio" || kind === "video";
  // Ogg may be declared without an audio family; generic binary aliases also
  // leave the media family to the provider endpoint's existing contract.
  const unspecifiedMedia =
    contentType === "application/octet-stream" ||
    contentType === "binary/octet-stream" ||
    (kind === "audio" && contentType === "application/ogg");
  if (!contentType && !requiresMediaFamily) {
    return;
  }
  if (
    !contentType ||
    contentType === "application/json" ||
    contentType.endsWith("+json") ||
    contentType.startsWith("text/") ||
    (requiresMediaFamily &&
      (!providerMediaContentTypePattern.test(rawContentType.trim()) ||
        (!unspecifiedMedia && mediaKindFromMime(contentType) !== kind)))
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
): Promise<Buffer> {
  try {
    assertProviderBinaryResponseContent(response, label, kind);
  } catch (error) {
    // A captured response may be teed; do not await cancellation before its
    // rejected branch and dispatcher can be released.
    void response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = await readProviderResponseBytes(response, label, kind, opts);
  if (bytes.byteLength === 0) {
    throw new Error(`${label}: malformed ${kind} response`);
  }
  return bytes;
}
