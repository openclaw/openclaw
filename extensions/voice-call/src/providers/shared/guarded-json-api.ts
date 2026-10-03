import {
  readResponseTextPrefix,
  readResponseWithLimit,
} from "openclaw/plugin-sdk/response-limit-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard } from "../../../api.js";
import type { GetCallStatusResult } from "../../types.js";
const VOICE_CALL_PROVIDER_API_TIMEOUT_MS = 30_000;
const PROVIDER_JSON_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;
const PROVIDER_ERROR_RESPONSE_MAX_BYTES = 8 * 1024;

type GuardedJsonApiRequestParams = {
  url: string;
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body?: Record<string, unknown> | URLSearchParams;
  allowNotFound?: boolean;
  allowedHostnames: string[];
  auditContext: string;
  errorPrefix: string;
  malformedJsonMessage?: string;
  createError?: (status: number, text: string) => Error;
};

/** Send a provider JSON request through the SSRF guard and parse bounded JSON responses. */
export async function guardedJsonApiRequest<T = unknown>(
  params: GuardedJsonApiRequestParams,
): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    init: {
      method: params.method,
      headers: params.headers,
      body:
        params.body instanceof URLSearchParams
          ? params.body
          : params.body
            ? JSON.stringify(params.body)
            : undefined,
    },
    policy: { allowedHostnames: params.allowedHostnames },
    auditContext: params.auditContext,
    timeoutMs: VOICE_CALL_PROVIDER_API_TIMEOUT_MS,
  });

  try {
    if (!response.ok) {
      if (params.allowNotFound && response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return undefined as T;
      }
      const prefix = await readResponseTextPrefix(response, PROVIDER_ERROR_RESPONSE_MAX_BYTES);
      // Provider errors can echo credentials; tools mode keeps redaction on regardless of log config.
      const text = redactSensitiveText(prefix.text, { mode: "tools" });
      const errorText = prefix.truncated ? `${text.trimEnd()}... [truncated]` : text;
      throw params.createError
        ? params.createError(response.status, errorText)
        : new Error(`${params.errorPrefix}: ${response.status} ${errorText}`);
    }

    const body = await readResponseWithLimit(response, PROVIDER_JSON_RESPONSE_MAX_BYTES, {
      onOverflow: ({ size, maxBytes }) =>
        new Error(`provider response body too large: ${size} bytes (limit: ${maxBytes} bytes)`),
    });
    if (body.byteLength === 0) {
      return undefined as T;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new Error(
        params.malformedJsonMessage ?? `${params.errorPrefix}: malformed JSON response`,
        { cause },
      );
    }
  } finally {
    await release();
  }
}

/** Failed carrier probes keep calls alive; an empty or missing response is terminal. */
export async function readProviderCallStatus<T>(
  request: () => Promise<T>,
  describe: (data: NonNullable<T>) => GetCallStatusResult,
): Promise<GetCallStatusResult> {
  try {
    const data = await request();
    return data ? describe(data) : { status: "not-found", isTerminal: true };
  } catch {
    return { status: "error", isTerminal: false, isUnknown: true };
  }
}
