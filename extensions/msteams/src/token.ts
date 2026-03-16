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

export function hasConfiguredMSTeamsCredentials(cfg?: MSTeamsConfig): boolean {
  const appId = normalizeSecretInputString(cfg?.appId);
  const tenantId = normalizeSecretInputString(cfg?.tenantId);
  if (!appId || !tenantId) return false;

  const authType = cfg?.authType ?? "clientSecret";

  switch (authType) {
    case "certificate":
    case "federatedCredential":
      // Auth type explicitly set — detail fields may come from SDK env fallbacks.
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
      // Config fields are optional — the SDK's getAuthConfigWithDefaults()
      // can also source certPemFile/certKeyFile from environment variables.
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
      // Config fields are optional — the SDK's getAuthConfigWithDefaults()
      // can also source ficClientId/widAssertionFile from environment variables.
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
