import type { MSTeamsConfig } from "openclaw/plugin-sdk/msteams";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";

export type MSTeamsAuthType = "clientSecret" | "certificate" | "federatedCredential";

export type MSTeamsCredentials = {
  appId: string;
  appPassword: string;
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
      return Boolean(cfg?.certPemFile && cfg?.certKeyFile);
    case "federatedCredential":
      return Boolean(cfg?.ficClientId || cfg?.widAssertionFile);
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
      const certPemFile = cfg?.certPemFile;
      const certKeyFile = cfg?.certKeyFile;
      if (!certPemFile || !certKeyFile) return undefined;
      return {
        appId,
        appPassword: "", // not used for certificate auth
        tenantId,
        authType,
        certPemFile,
        certKeyFile,
        sendX5C: cfg?.sendX5C,
      };
    }
    case "federatedCredential": {
      const ficClientId = cfg?.ficClientId;
      const widAssertionFile = cfg?.widAssertionFile;
      if (!ficClientId && !widAssertionFile) return undefined;
      return {
        appId,
        appPassword: "", // not used for federated auth
        tenantId,
        authType,
        ficClientId,
        widAssertionFile,
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
