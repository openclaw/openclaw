import {
  DEFAULT_ACCOUNT_ID,
  hasConfiguredSecretInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/mattermost";
import { createPatchedAccountSetupAdapter } from "../../../src/channels/plugins/setup-helpers.js";
import type { ChannelSetupAdapter } from "../../../src/channels/plugins/types.adapters.js";
import { resolveMattermostAccount, type ResolvedMattermostAccount } from "./mattermost/accounts.js";
import { normalizeMattermostBaseUrl } from "./mattermost/client.js";

const channel = "mattermost" as const;

export function isMattermostConfigured(account: ResolvedMattermostAccount): boolean {
  const tokenConfigured =
    Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
  return tokenConfigured && Boolean(account.baseUrl);
}

export function resolveMattermostAccountWithSecrets(cfg: OpenClawConfig, accountId: string) {
  return resolveMattermostAccount({
    cfg,
    accountId,
    allowUnresolvedSecretRef: true,
  });
}

export const mattermostSetupAdapter: ChannelSetupAdapter = createPatchedAccountSetupAdapter({
  channelKey: channel,
  validateInput: ({ accountId, input }) => {
    const token = input.botToken ?? input.token;
    const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
    if (input.useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      return "Mattermost env vars can only be used for the default account.";
    }
    if (!input.useEnv && (!token || !baseUrl)) {
      return "Mattermost requires --bot-token and --http-url (or --use-env).";
    }
    if (input.httpUrl && !baseUrl) {
      return "Mattermost --http-url must include a valid base URL.";
    }
    return null;
  },
  buildPatch: (input) => {
    const token = input.botToken ?? input.token;
    const baseUrl = normalizeMattermostBaseUrl(input.httpUrl);
    return input.useEnv
      ? {}
      : {
          ...(token ? { botToken: token } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        };
  },
});
