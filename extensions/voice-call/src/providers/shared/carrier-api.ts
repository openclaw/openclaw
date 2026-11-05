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
  const request = <T = unknown>(
    endpoint: string,
    body: ApiRequest["body"],
    params?: Partial<Pick<ApiRequest, "method" | "allowNotFound">>,
  ): Promise<T> =>
    guardedJsonApiRequest<T>({
      method: params?.method ?? "POST",
      allowNotFound: params?.allowNotFound,
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
