import type { GetCallStatusResult } from "../../types.js";
import { guardedJsonApiRequest } from "./guarded-json-api.js";

type ApiRequest = Parameters<typeof guardedJsonApiRequest>[0];

/** Keep call controls and recovery probes on the same carrier endpoint and credentials. */
export function createCarrierApi(
  name: "Twilio" | "Telnyx" | "Plivo",
  baseUrl: string,
  authorization: string,
  options: Pick<ApiRequest, "createError" | "malformedJsonMessage"> & {
    contentType?: string;
    statusContentType?: string;
  } = {},
) {
  const provider = name.toLowerCase();
  const headers = { Authorization: authorization };
  const allowedHostnames = [new URL(baseUrl).hostname];
  /**
   * Send `body` to `endpoint` (appended to the carrier base URL) with the carrier credentials
   * and resolve with the parsed JSON response. `params` overrides the method (POST by default),
   * allows a 404, or replaces the default request timeout. Rejects on carrier API errors.
   */
  const request = <T = unknown>(
    endpoint: string,
    body: ApiRequest["body"],
    params?: Partial<Pick<ApiRequest, "method" | "allowNotFound" | "timeoutMs">>,
  ): Promise<T> =>
    guardedJsonApiRequest<T>({
      method: params?.method ?? "POST",
      allowNotFound: params?.allowNotFound,
      timeoutMs: params?.timeoutMs,
      body,
      url: `${baseUrl}${endpoint}`,
      headers: { ...headers, "Content-Type": options.contentType ?? "application/json" },
      allowedHostnames,
      auditContext: `voice-call.${provider}.api`,
      errorPrefix: `${name} API error`,
      createError: options.createError,
      malformedJsonMessage: options.malformedJsonMessage,
    });

  return {
    request,
    async getCallStatus<T>(
      endpoint: string,
      describe: (data: NonNullable<T>) => GetCallStatusResult,
    ): Promise<GetCallStatusResult> {
      try {
        const data = await guardedJsonApiRequest<T>({
          url: `${baseUrl}${endpoint}`,
          method: "GET",
          allowNotFound: true,
          headers: options.statusContentType
            ? { ...headers, "Content-Type": options.statusContentType }
            : headers,
          allowedHostnames,
          auditContext: `${provider}-get-call-status`,
          errorPrefix: `${name} get call status error`,
        });
        return data ? describe(data) : { status: "not-found", isTerminal: true };
      } catch {
        // Transient carrier failures must not discard a persisted call during recovery.
        return { status: "error", isTerminal: false, isUnknown: true };
      }
    },
  };
}
