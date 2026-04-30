import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { CoreConfig, VesicleAccountConfig } from "./types.js";

function readString(input: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

export function applyVesicleSetup(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const nextCfg = structuredClone(params.cfg) as CoreConfig;
  const section = nextCfg.channels?.vesicle ?? {};
  const accounts = { ...section.accounts };
  const target: Partial<VesicleAccountConfig> =
    params.accountId === DEFAULT_ACCOUNT_ID ? { ...section } : { ...accounts[params.accountId] };

  const serverUrl = readString(params.input, ["serverUrl", "baseUrl", "url"]);
  if (serverUrl) {
    target.serverUrl = serverUrl;
  }
  const authToken = readString(params.input, ["authToken", "token", "secret", "password"]);
  if (authToken) {
    target.authToken = authToken;
  }
  const webhookPath = readString(params.input, ["webhookPath"]);
  if (webhookPath) {
    target.webhookPath = webhookPath;
  }
  const webhookSecret = readString(params.input, ["webhookSecret"]);
  if (webhookSecret) {
    target.webhookSecret = webhookSecret;
  }

  nextCfg.channels ??= {};
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    nextCfg.channels.vesicle = {
      ...section,
      ...target,
    };
  } else {
    accounts[params.accountId] = target;
    nextCfg.channels.vesicle = {
      ...section,
      accounts,
    };
  }
  return nextCfg as OpenClawConfig;
}
