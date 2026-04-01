import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveBlueBubblesAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { normalizeResolvedSecretInputString } from "./secret-input.js";
import { normalizeBlueBubblesServerUrl } from "./types.js";

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
    normalizeResolvedSecretInputString({
      value: params.serverUrl,
      path: "channels.bluebubbles.serverUrl",
    }) ||
    normalizeResolvedSecretInputString({
      value: account.config.serverUrl,
      path: `channels.bluebubbles.accounts.${account.accountId}.serverUrl`,
    });
  const password =
    normalizeResolvedSecretInputString({
      value: params.password,
      path: "channels.bluebubbles.password",
    }) ||
    normalizeResolvedSecretInputString({
      value: account.config.password,
      path: `channels.bluebubbles.accounts.${account.accountId}.password`,
    });
  if (!baseUrl) {
    throw new Error("BlueBubbles serverUrl is required");
  }
  if (!password) {
    throw new Error("BlueBubbles password is required");
  }

  let autoAllowPrivateNetwork = false;
  try {
    const hostname = new URL(normalizeBlueBubblesServerUrl(baseUrl)).hostname.trim();
    autoAllowPrivateNetwork = Boolean(hostname) && isBlockedHostnameOrIp(hostname);
  } catch {
    autoAllowPrivateNetwork = false;
  }

  return {
    baseUrl,
    password,
    accountId: account.accountId,
    allowPrivateNetwork: account.config.allowPrivateNetwork === true || autoAllowPrivateNetwork,
  };
}
