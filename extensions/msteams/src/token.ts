import type { MSTeamsConfig } from "openclaw/plugin-sdk/msteams";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";

/** Derived from MSTeamsConfig.authType to keep a single source of truth. */
export type MSTeamsAuthType = NonNullable<MSTeamsConfig["authType"]>;

export type MSTeamsCredentials = {
  appId: string;
  appPassword?: string;
  tenantId: string;
  authType: MSTeamsAuthType;
  certPemFile?: string;
  certKeyFile?: string;
  sendX5C?: boolean;
  ficClientId?: string;
  widAssertionFile?: string;
};

/**
 * Check whether certificate auth material is present in typed config
 * or the SDK's plain env vars. Each field is checked independently so
 * mixed-source configs (e.g. certPemFile in config, certKeyFile in env)
 * are accepted — the SDK merges them field-by-field at runtime.
 *
 * Does not check connections__*__settings__* env vars because those may
 * belong to an unrelated Agents SDK connection and cannot be reliably
 * attributed to the Teams channel.
 */
function hasCertificateAuthMaterial(
  cfg?: MSTeamsConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const hasPem = Boolean(cfg?.certPemFile || env.certPemFile);
  const hasKey = Boolean(cfg?.certKeyFile || env.certKeyFile);
  return hasPem && hasKey;
}

/**
 * Check whether federated credential auth material is present in typed
 * config or the SDK's plain env vars. Either FICClientId or
 * WIDAssertionFile is sufficient.
 *
 * Does not check connections__*__settings__* env vars because those may
 * belong to an unrelated Agents SDK connection.
 */
function hasFederatedAuthMaterial(
  cfg?: MSTeamsConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(
    cfg?.ficClientId || env.FICClientId || cfg?.widAssertionFile || env.WIDAssertionFile,
  );
}

export function hasConfiguredMSTeamsCredentials(cfg?: MSTeamsConfig): boolean {
  const appId = normalizeSecretInputString(cfg?.appId);
  const tenantId = normalizeSecretInputString(cfg?.tenantId);
  if (!appId || !tenantId) return false;

  const authType = cfg?.authType ?? "clientSecret";

  switch (authType) {
    case "certificate":
      return hasCertificateAuthMaterial(cfg);
    case "federatedCredential":
      return hasFederatedAuthMaterial(cfg);
    case "clientSecret":
    default:
      return Boolean(hasConfiguredSecretInput(cfg?.appPassword));
  }
}

export function resolveMSTeamsCredentials(cfg?: MSTeamsConfig): MSTeamsCredentials | undefined {
  const appId =
    normalizeSecretInputString(cfg?.appId) ||
    normalizeSecretInputString(process.env.MSTEAMS_APP_ID);
  const tenantId =
    normalizeSecretInputString(cfg?.tenantId) ||
    normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID);

  if (!appId || !tenantId) {
    return undefined;
  }

  const authType: MSTeamsAuthType = cfg?.authType ?? "clientSecret";

  switch (authType) {
    case "certificate": {
      if (!hasCertificateAuthMaterial(cfg)) return undefined;
      return {
        appId,
        tenantId,
        authType,
        certPemFile: cfg?.certPemFile,
        certKeyFile: cfg?.certKeyFile,
        sendX5C: cfg?.sendX5C,
      };
    }
    case "federatedCredential": {
      if (!hasFederatedAuthMaterial(cfg)) return undefined;
      return {
        appId,
        tenantId,
        authType,
        ficClientId: cfg?.ficClientId,
        widAssertionFile: cfg?.widAssertionFile,
      };
    }
    case "clientSecret":
    default: {
      const appPassword =
        normalizeResolvedSecretInputString({
          value: cfg?.appPassword,
          path: "channels.msteams.appPassword",
        }) || normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD);
      if (!appPassword) return undefined;
      return { appId, appPassword, tenantId, authType: "clientSecret" };
    }
  }
}
