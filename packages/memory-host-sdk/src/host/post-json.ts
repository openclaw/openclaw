import { extractErrorCode, formatErrorMessage } from "../../../../src/infra/errors.js";
import type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";
import { withRemoteHttpResponse } from "./remote-http.js";

function formatPostJsonCause(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const cause = (err as { cause?: unknown }).cause;
  if (!cause) {
    return "";
  }
  const parts: string[] = [];
  const code = extractErrorCode(cause);
  if (code) {
    parts.push(code);
  }
  const message = formatErrorMessage(cause);
  if (message && !parts.includes(message)) {
    parts.push(message);
  }
  return parts.length > 0 ? ` (cause: ${parts.join(" ")})` : "";
}

export async function postJson<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  body: unknown;
  errorPrefix: string;
  attachStatus?: boolean;
  parse: (payload: unknown) => T | Promise<T>;
}): Promise<T> {
  try {
    return await withRemoteHttpResponse({
      url: params.url,
      ssrfPolicy: params.ssrfPolicy,
      init: {
        method: "POST",
        headers: params.headers,
        body: JSON.stringify(params.body),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`${params.errorPrefix}: ${res.status} ${text}`) as Error & {
            status?: number;
          };
          if (params.attachStatus) {
            err.status = res.status;
          }
          throw err;
        }
        return await params.parse(await res.json());
      },
    });
  } catch (err) {
    const message = formatErrorMessage(err);
    if (message.startsWith(`${params.errorPrefix}:`)) {
      throw err;
    }
    throw new Error(`${params.errorPrefix}: ${message}${formatPostJsonCause(err)}`, {
      cause: err,
    });
  }
}
