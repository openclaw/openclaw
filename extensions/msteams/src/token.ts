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
/** Return trimmed value if non-blank, otherwise undefined. */
function trimPresence(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function hasCertificateAuthMaterial(
  cfg?: MSTeamsConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const hasPem = Boolean(trimPresence(cfg?.certPemFile) || trimPresence(env.certPemFile));
  const hasKey = Boolean(trimPresence(cfg?.certKeyFile) || trimPresence(env.certKeyFile));
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
    trimPresence(cfg?.ficClientId) ||
    trimPresence(env.FICClientId) ||
    trimPresence(cfg?.widAssertionFile) ||
    trimPresence(env.WIDAssertionFile),
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
    case "defaultAzureCredential":
      // DAC handles its own credential discovery — appId + tenantId is sufficient.
      return true;
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
        certPemFile: trimPresence(cfg?.certPemFile),
        certKeyFile: trimPresence(cfg?.certKeyFile),
        sendX5C: cfg?.sendX5C,
      };
    }
    case "federatedCredential": {
      if (!hasFederatedAuthMaterial(cfg)) return undefined;
      return {
        appId,
        tenantId,
        authType,
        ficClientId: trimPresence(cfg?.ficClientId),
        widAssertionFile: trimPresence(cfg?.widAssertionFile),
      };
    }
    case "defaultAzureCredential": {
      // DAC defers credential selection to @azure/identity at runtime.
      // Only appId + tenantId are required from config.
      return { appId, tenantId, authType };
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
