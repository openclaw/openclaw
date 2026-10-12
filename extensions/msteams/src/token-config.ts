import type { MSTeamsConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { readNonBlankString } from "openclaw/plugin-sdk/string-coerce-runtime";

type MSTeamsCredentialConfig = Pick<
  MSTeamsConfig,
  | "appId"
  | "appPassword"
  | "tenantId"
  | "authType"
  | "certificatePath"
  | "certificateThumbprint"
  | "useManagedIdentity"
  | "managedIdentityClientId"
>;

type MSTeamsSecretCredentials = {
  type: "secret";
  appId: string;
  appPassword: string;
  tenantId: string;
};

type MSTeamsFederatedCredentials = {
  type: "federated";
  appId: string;
  tenantId: string;
  certificatePath?: string;
  certificateThumbprint?: string;
  useManagedIdentity?: boolean;
  managedIdentityClientId?: string;
};

export type MSTeamsCredentials = MSTeamsSecretCredentials | MSTeamsFederatedCredentials;

type MSTeamsCredentialInspection = {
  credentials?: MSTeamsFederatedCredentials;
  status: "available" | "configured_unavailable" | "missing";
};

function resolveAuthType(
  cfg?: MSTeamsCredentialConfig,
  options?: { allowEnvFallback?: boolean },
): "secret" | "federated" {
  const fromCfg = cfg?.authType;
  if (fromCfg === "secret" || fromCfg === "federated") {
    return fromCfg;
  }

  const fromEnv = options?.allowEnvFallback === false ? undefined : process.env.MSTEAMS_AUTH_TYPE;
  if (fromEnv === "federated") {
    return "federated";
  }

  return "secret";
}

function resolveFederatedPath(configValue?: string, envValue?: string): string | undefined {
  // Reject blank settings without trimming a real path: surrounding whitespace
  // can be part of the certificate filename on the filesystem.
  return readNonBlankString(configValue) ?? readNonBlankString(envValue);
}

function resolveMSTeamsAppId(cfg: MSTeamsCredentialConfig | undefined, allowEnvFallback: boolean) {
  return (
    normalizeSecretInputString(cfg?.appId) ||
    (allowEnvFallback ? normalizeSecretInputString(process.env.MSTEAMS_APP_ID) : undefined)
  );
}

function resolveMSTeamsTenantId(
  cfg: MSTeamsCredentialConfig | undefined,
  allowEnvFallback: boolean,
) {
  return (
    normalizeSecretInputString(cfg?.tenantId) ||
    (allowEnvFallback ? normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID) : undefined)
  );
}

export function hasConfiguredMSTeamsCredentials(
  cfg?: MSTeamsCredentialConfig,
  options?: { allowEnvFallback?: boolean },
): boolean {
  return inspectMSTeamsCredentials(cfg, options).status !== "missing";
}

export function resolveMSTeamsCredentials(
  cfg?: MSTeamsCredentialConfig,
  options?: { allowEnvFallback?: boolean; pathPrefix?: string },
): MSTeamsCredentials | undefined {
  const allowEnvFallback = options?.allowEnvFallback ?? true;
  const pathPrefix = options?.pathPrefix ?? "channels.msteams";
  const authType = resolveAuthType(cfg, { allowEnvFallback });

  const appId = resolveMSTeamsAppId(cfg, allowEnvFallback);
  const tenantId = resolveMSTeamsTenantId(cfg, allowEnvFallback);

  if (!appId || !tenantId) {
    return undefined;
  }

  if (authType === "federated") {
    const certificatePath = resolveFederatedPath(
      cfg?.certificatePath,
      allowEnvFallback ? process.env.MSTEAMS_CERTIFICATE_PATH : undefined,
    );

    const certificateThumbprint =
      cfg?.certificateThumbprint ||
      (allowEnvFallback ? process.env.MSTEAMS_CERTIFICATE_THUMBPRINT : undefined) ||
      undefined;

    const useManagedIdentity =
      cfg?.useManagedIdentity ??
      (allowEnvFallback ? process.env.MSTEAMS_USE_MANAGED_IDENTITY === "true" : false);

    const managedIdentityClientId =
      cfg?.managedIdentityClientId ||
      (allowEnvFallback ? process.env.MSTEAMS_MANAGED_IDENTITY_CLIENT_ID : undefined) ||
      undefined;

    // At least one federated mechanism must be configured.
    if (!certificatePath && !useManagedIdentity) {
      return undefined;
    }

    return {
      type: "federated",
      appId,
      tenantId,
      certificatePath,
      certificateThumbprint,
      useManagedIdentity: useManagedIdentity || undefined,
      managedIdentityClientId,
    };
  }

  const appPassword =
    normalizeResolvedSecretInputString({
      value: cfg?.appPassword,
      path: `${pathPrefix}.appPassword`,
    }) ||
    (allowEnvFallback ? normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD) : undefined);

  if (!appPassword) {
    return undefined;
  }

  return { type: "secret", appId, appPassword, tenantId };
}

/** Read credential availability for diagnostics without redeeming unresolved SecretRefs. */
export function inspectMSTeamsCredentials(
  cfg?: MSTeamsCredentialConfig,
  options?: { allowEnvFallback?: boolean },
): MSTeamsCredentialInspection {
  const allowEnvFallback = options?.allowEnvFallback ?? true;
  const authType = resolveAuthType(cfg, { allowEnvFallback });
  const appId = resolveMSTeamsAppId(cfg, allowEnvFallback);
  const tenantId = resolveMSTeamsTenantId(cfg, allowEnvFallback);
  if (!appId || !tenantId) {
    return { status: "missing" };
  }

  if (authType === "federated") {
    const credentials = resolveMSTeamsCredentials(cfg, { allowEnvFallback });
    return credentials?.type === "federated"
      ? { credentials, status: "available" }
      : { status: "missing" };
  }

  const configuredPassword = normalizeSecretInputString(cfg?.appPassword);
  if (configuredPassword) {
    return { status: "available" };
  }
  // A configured ref remains authoritative while unavailable. Inspection must not
  // imply that a lower-precedence environment credential is active.
  if (hasConfiguredSecretInput(cfg?.appPassword)) {
    return { status: "configured_unavailable" };
  }
  const envPassword = allowEnvFallback
    ? normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD)
    : undefined;
  return envPassword ? { status: "available" } : { status: "missing" };
}
