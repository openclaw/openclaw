import { fetchWithSsrFGuard } from "../../../api.js";

type GuardedJsonApiRequestParams = {
  url: string;
  method: "GET" | "POST" | "DELETE" | "PUT" | "PATCH";
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  /** Treat 404 as an idempotent "already gone" result for delete/status probes. */
  allowNotFound?: boolean;
  /** Exact provider API hostnames permitted after SSRF resolution and redirect checks. */
  allowedHostnames: string[];
  /** Audit label emitted by the network guard for provider-specific API calls. */
  auditContext: string;
  /** Prefix preserved on thrown errors so callers can attribute provider failures. */
  errorPrefix: string;
};

/** Performs a provider JSON request through the SSRF guard and always releases the response pin. */
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
        // Provider lookup/delete paths use 404 as "already gone" rather than a hard failure.
        return undefined as T;
      }
      const errorText = await response.text();
      throw new Error(`${params.errorPrefix}: ${response.status} ${errorText}`);
    }

    const text = await response.text();
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${params.errorPrefix}: malformed JSON response`);
    }
  } finally {
    // Release the SSRF guard's resolved-address pin after all body reads finish.
    await release();
  }
}
