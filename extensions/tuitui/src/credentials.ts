import { readFileSync } from "node:fs";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { TuituiConfig } from "./types.js";

export type TuituiCredentialsResolution = {
  appId: string;
  secret: string;
  source: "env" | "config" | "configFile" | "none";
};

function readSecretFromFile(secretFile: string): string {
  try {
    return readFileSync(secretFile, "utf8").trim();
  } catch {
    return "";
  }
}

export function resolveTuituiCredentials(
  config: TuituiConfig | undefined,
  accountId?: string | null,
): TuituiCredentialsResolution {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const baseConfig = config;
  const accountConfig =
    resolvedAccountId !== DEFAULT_ACCOUNT_ID
      ? (baseConfig?.accounts?.[resolvedAccountId] as TuituiConfig | undefined)
      : undefined;

  const readAccount = (c: TuituiConfig | undefined) => {
    if (!c) return { appId: "", secret: "", source: "none" as const };
    const appId = c.appId?.trim() ?? "";
    const secret = c.secret?.trim() ?? "";
    if (appId && secret) return { appId, secret, source: "config" as const };
    const secretFile = c.secretFile?.trim();
    if (appId && secretFile) {
      const secret = readSecretFromFile(secretFile);
      if (secret) return { appId, secret, source: "configFile" as const };
    }
    return { appId: "", secret: "", source: "none" as const };
  };

  const fromAccount = readAccount(accountConfig);
  if (fromAccount.source !== "none") return fromAccount;

  if (isDefaultAccount) {
    const fromBase = readAccount(baseConfig);
    if (fromBase.source !== "none") return fromBase;
    const envAppId = process.env.TUITUI_APPID?.trim();
    const envSecret = process.env.TUITUI_SECRET?.trim();
    if (envAppId && envSecret) {
      return { appId: envAppId, secret: envSecret, source: "env" };
    }
  }

  return { appId: "", secret: "", source: "none" };
}
