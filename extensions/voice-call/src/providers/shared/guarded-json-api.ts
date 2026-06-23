// Voice Call API module exposes the plugin public contract.
import { fetchWithSsrFGuard } from "../../../api.js";
import {
  cancelProviderResponseBody,
  readProviderErrorResponseSnippet,
  readProviderJsonResponseText,
} from "./response-body.js";

// Shared guarded JSON API client for voice-call providers.

/** Parameters for an SSRF-guarded provider JSON request. */
type GuardedJsonApiRequestParams = {
  url: string;
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  allowNotFound?: boolean;
  allowedHostnames: string[];
  auditContext: string;
  errorPrefix: string;
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
      body: params.body ? JSON.stringify(params.body) : undefined,
    },
    policy: { allowedHostnames: params.allowedHostnames },
    auditContext: params.auditContext,
  });

  try {
    if (!response.ok) {
      if (params.allowNotFound && response.status === 404) {
        await cancelProviderResponseBody(response);
        return undefined as T;
      }
      const errorText = await readProviderErrorResponseSnippet(response);
      throw new Error(`${params.errorPrefix}: ${response.status} ${errorText}`);
    }

    const text = await readProviderJsonResponseText(response);
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${params.errorPrefix}: malformed JSON response`);
    }
  } finally {
    await release();
  }
}
