import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/tlon";
import { validateUrbitBaseUrl } from "./base-url.js";
import { UrbitUrlError } from "./errors.js";
async function urbitFetch(params) {
  const validated = validateUrbitBaseUrl(params.baseUrl);
  if (!validated.ok) {
    throw new UrbitUrlError(validated.error);
  }
  const url = new URL(params.path, validated.baseUrl).toString();
  return await fetchWithSsrFGuard({
    url,
    fetchImpl: params.fetchImpl,
    init: params.init,
    timeoutMs: params.timeoutMs,
    maxRedirects: params.maxRedirects,
    signal: params.signal,
    policy: params.ssrfPolicy,
    lookupFn: params.lookupFn,
    auditContext: params.auditContext,
    pinDns: params.pinDns
  });
}
export {
  urbitFetch
};
