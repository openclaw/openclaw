import { createChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
import { resolveBuzzAccountConfig } from "./types.js";

const fields = ["privateKey", "authTag"] as const;

export const channelSecrets = createChannelSecretContract({
  channelKey: "buzz",
  account: fields,
  channel: fields,
  collect(params) {
    const collect = (accountId: string, account: Record<string, unknown>, rootIdentity = false) => {
      const resolved = resolveBuzzAccountConfig({ cfg: params.config, accountId });
      const active = resolved.config.enabled !== false && (!rootIdentity || resolved.allowEnv);
      const configPath = rootIdentity ? "channels.buzz" : resolved.configPath;
      for (const field of fields) {
        params.collectSecret(account, field, `${configPath}.${field}`, {
          active,
          inactiveReason: "Buzz identity is disabled or replaced by accounts.default.",
          owner: {
            ownerKind: "account",
            ownerId: `buzz:${accountId}`,
            requiredForGateway: false,
            disposition: "isolate",
            // Recovery follows this identity and its effective policy, never another account's key.
            contract: resolved.config,
          },
        });
      }
    };
    collect("default", params.channel, true);
    if (params.surface.hasExplicitAccounts) {
      for (const { accountId, account } of params.surface.accounts.toSorted((a, b) =>
        a.accountId.localeCompare(b.accountId),
      )) {
        collect(accountId, account);
      }
    }
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
