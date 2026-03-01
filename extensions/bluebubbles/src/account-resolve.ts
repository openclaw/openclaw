import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { normalizeSecretInputString } from "./secret-input.js";

export type BlueBubblesAccountResolveOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
};

export function resolveBlueBubblesServerAccount(params: BlueBubblesAccountResolveOpts): {
  baseUrl: string;
  password: string;
  accountId: string;
  allowPrivateNetwork: boolean;
} {
  const account = resolveBlueBubblesAccount({
    cfg: params.cfg ?? {},
    accountId: params.accountId,
  });
  const baseUrl =
    normalizeSecretInputString(params.serverUrl) ||
    normalizeSecretInputString(account.config.serverUrl);
  const password =
    normalizeSecretInputString(params.password) ||
    normalizeSecretInputString(account.config.password);
  if (!baseUrl) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  if (!password) {
    throw new Error("BlueBubbles password is required");
  }
  return {
    baseUrl,
    password,
    accountId: account.accountId,
    allowPrivateNetwork: account.config.allowPrivateNetwork === true,
  };
}
