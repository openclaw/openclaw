// Narrow network/runtime facade re-exported for memory remote HTTP helpers.

export { fetchWithResponseRelease } from "../../../../src/plugin-sdk/fetch-runtime.js";
export { createHttp1EnvHttpProxyAgent } from "../../../../src/plugin-sdk/fetch-runtime.js";
export { shouldUseEnvHttpProxyForUrl } from "../../../../src/infra/net/proxy-env.js";
export {
  assertHostnameAllowedWithPolicy,
  matchesHostnameAllowlist,
  normalizeHostnameAllowlist,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
} from "../../../../src/infra/net/ssrf.js";
export { normalizeHostname } from "../../../../src/infra/net/hostname.js";
