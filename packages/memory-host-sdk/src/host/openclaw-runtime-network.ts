// Narrow network/runtime facade re-exported for memory remote HTTP helpers.
import type { createProviderHttpError as CreateProviderHttpError } from "../../../../src/agents/provider-http-errors.js";

export { fetchWithSsrFGuard } from "../../../../src/infra/net/fetch-guard.js";
export { shouldUseEnvHttpProxyForUrl } from "../../../../src/infra/net/proxy-env.js";
export { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "../../../../src/infra/net/ssrf.js";
export type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";

export const createProviderHttpError: typeof CreateProviderHttpError = async (...args) => {
  const http = await import("../../../../src/agents/provider-http-errors.js");
  return http.createProviderHttpError(...args);
};
