// Keep Teams activation independent of the full channel and Azure SDK runtimes.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { hasConfiguredSecretInput, normalizeSecretInputString } from "./src/secret-input.js";

/** Checks the same auth-mode and credential requirements as the Teams runtime. */
export function hasConfiguredMSTeamsChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = params.env ?? process.env;
  const config = params.cfg.channels?.msteams;
  if (config?.enabled === false) {
    return false;
  }
  const appId =
    normalizeSecretInputString(config?.appId) || normalizeSecretInputString(env.MSTEAMS_APP_ID);
  const tenantId =
    normalizeSecretInputString(config?.tenantId) ||
    normalizeSecretInputString(env.MSTEAMS_TENANT_ID);
  if (!appId || !tenantId) {
    return false;
  }

  const authType =
    config?.authType === "secret" || config?.authType === "federated"
      ? config.authType
      : env.MSTEAMS_AUTH_TYPE === "federated"
        ? "federated"
        : "secret";
  if (authType === "federated") {
    const hasCertificate = Boolean(
      normalizeSecretInputString(config?.certificatePath) ||
      normalizeSecretInputString(env.MSTEAMS_CERTIFICATE_PATH),
    );
    const hasManagedIdentity =
      config?.useManagedIdentity ?? env.MSTEAMS_USE_MANAGED_IDENTITY === "true";
    return hasCertificate || hasManagedIdentity;
  }

  return (
    hasConfiguredSecretInput(config?.appPassword) ||
    Boolean(normalizeSecretInputString(env.MSTEAMS_APP_PASSWORD))
  );
}
