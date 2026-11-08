import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { resolveDiscordAccountAvailability } from "./account-token-inspect.js";
import {
  listDiscordAccountIds,
  inspectDiscordAccountConfig,
  type ResolvedDiscordAccount,
} from "./accounts.js";

export type InspectedDiscordAccount = ResolvedDiscordAccount & {
  configured: boolean;
  stateReason?: string;
};

function inspectDiscordAccountPrimary(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): InspectedDiscordAccount {
  return inspectDiscordAccountConfig(params, {
    includeName: true,
    // Known divergence: doctor inspection must use its injected environment snapshot.
    resolveFallbackToken: (accountId) => {
      const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
      const envToken = allowEnv
        ? normalizeSecretInputString(params.envToken ?? process.env.DISCORD_BOT_TOKEN)
        : undefined;
      return {
        token: envToken?.replace(/^Bot\s+/i, "") ?? "",
        source: envToken ? ("env" as const) : ("none" as const),
      };
    },
  });
}

export function inspectDiscordAccount(
  params: Parameters<typeof inspectDiscordAccountPrimary>[0],
): InspectedDiscordAccount {
  const account = inspectDiscordAccountPrimary(params);
  return {
    ...account,
    // Keep the injected inspection environment; never switch to runtime-resolved secrets here.
    ...resolveDiscordAccountAvailability({
      account,
      resolveAccounts: () =>
        listDiscordAccountIds(params.cfg).map((accountId) =>
          inspectDiscordAccountPrimary({ ...params, accountId }),
        ),
    }),
  };
}
