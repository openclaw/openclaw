// Narrow network/runtime facade re-exported for memory remote HTTP helpers.
import type { createProviderHttpError as CreateProviderHttpError } from "../../../../src/agents/provider-http-errors.js";
import type { resolvePluginMetadataSnapshotAsync as ResolvePluginMetadataSnapshotAsync } from "../../../../src/plugins/plugin-metadata-snapshot.js";

export { resolveProviderTransportSsrFPolicy } from "../../../../src/agents/provider-network-policy.js";
export { resolveProviderRequestPolicyConfig } from "../../../../src/agents/provider-request-config.js";
export { fetchWithSsrFGuard } from "../../../../src/infra/net/fetch-guard.js";
export { shouldUseEnvHttpProxyForUrl } from "../../../../src/infra/net/proxy-env.js";
export { ssrfPolicyFromHttpBaseUrlAllowedHostname } from "../../../../src/infra/net/ssrf.js";
export type { SsrFPolicy } from "../../../../src/infra/net/ssrf.js";

export const createProviderHttpError: typeof CreateProviderHttpError = async (...args) => {
  const http = await import("../../../../src/agents/provider-http-errors.js");
  return http.createProviderHttpError(...args);
};

export const resolvePluginMetadataSnapshotAsync: typeof ResolvePluginMetadataSnapshotAsync = async (
  ...args
) => {
  const metadata = await import("../../../../src/plugins/plugin-metadata-snapshot.js");
  return metadata.resolvePluginMetadataSnapshotAsync(...args);
};
