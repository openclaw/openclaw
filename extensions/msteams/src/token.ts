import type { MSTeamsConfig } from "../runtime-api.js";
import {
  hasConfiguredSecretInput,
  normalizeResolvedSecretInputString,
  normalizeSecretInputString,
} from "./secret-input.js";

export type MSTeamsCredentials = {
  appId: string;
  appPassword: string;
  tenantId: string;
};

export function hasConfiguredMSTeamsCredentials(cfg?: MSTeamsConfig): boolean {
  return Boolean(
    normalizeSecretInputString(cfg?.appId) &&
    hasConfiguredSecretInput(cfg?.appPassword) &&
    normalizeSecretInputString(cfg?.tenantId),
  );
}

export function resolveMSTeamsCredentials(cfg?: MSTeamsConfig): MSTeamsCredentials | undefined {
  const appId =
    normalizeSecretInputString(cfg?.appId) ||
    normalizeSecretInputString(process.env.MSTEAMS_APP_ID);
  const appPassword =
    normalizeResolvedSecretInputString({
      value: cfg?.appPassword,
      path: "channels.msteams.appPassword",
    }) || normalizeSecretInputString(process.env.MSTEAMS_APP_PASSWORD);
  const tenantId =
    normalizeSecretInputString(cfg?.tenantId) ||
    normalizeSecretInputString(process.env.MSTEAMS_TENANT_ID);

  if (!appId || !appPassword || !tenantId) {
    return undefined;
  }

  return { appId, appPassword, tenantId };
}
