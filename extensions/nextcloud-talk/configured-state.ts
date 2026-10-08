import {
  DEFAULT_ACCOUNT_ID,
  createAccountListHelpers,
  hasConfiguredAccountValue,
  normalizeAccountId,
} from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { CoreConfig, NextcloudTalkAccountConfig } from "./src/types.js";

type NextcloudAccount = NonNullable<NonNullable<CoreConfig["channels"]>["nextcloud-talk"]>;

const {
  listAccountIds: listNextcloudTalkAccountIds,
  resolveDefaultAccountId: resolveDefaultNextcloudTalkAccountId,
  resolveAccountConfig: mergeNextcloudTalkAccountConfig,
} = createAccountListHelpers<NextcloudTalkAccountConfig>("nextcloud-talk", {
  normalizeAccountId,
  omitKeys: ["defaultAccount"],
  hasImplicitDefaultAccount: (cfg) => {
    const channel = cfg.channels?.["nextcloud-talk"];
    return Boolean(
      channel?.baseUrl?.trim() &&
      (hasConfiguredAccountValue(channel.botSecret) ||
        channel.botSecretFile?.trim() ||
        process.env.NEXTCLOUD_TALK_BOT_SECRET?.trim()),
    );
  },
});
export {
  listNextcloudTalkAccountIds,
  mergeNextcloudTalkAccountConfig,
  resolveDefaultNextcloudTalkAccountId,
};

function hasConfiguredNextcloudAccount(
  account: NextcloudAccount | undefined,
  env: NodeJS.ProcessEnv,
) {
  return Boolean(
    account?.baseUrl?.trim() &&
    (hasConfiguredAccountValue(account.botSecret) ||
      hasConfiguredAccountValue(account.botSecretFile) ||
      hasConfiguredAccountValue(env.NEXTCLOUD_TALK_BOT_SECRET)),
  );
}

/** Require a Nextcloud server plus its account-owned bot credential. */
export function hasConfiguredNextcloudTalkChannelState(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  // SAFETY: Nextcloud Talk's registered channel schema owns its account-config shape.
  const channel = params.cfg.channels?.["nextcloud-talk"] as NextcloudAccount | undefined;
  if (channel?.enabled === false) {
    return false;
  }
  const defaultAccount = channel?.accounts?.[DEFAULT_ACCOUNT_ID];
  if (defaultAccount?.enabled !== false) {
    const account = mergeNextcloudTalkAccountConfig(params.cfg, DEFAULT_ACCOUNT_ID);
    if (hasConfiguredNextcloudAccount(account, params.env ?? process.env)) {
      return true;
    }
  }
  return Object.entries(channel?.accounts ?? {}).some(
    ([accountId, account]) =>
      accountId !== DEFAULT_ACCOUNT_ID &&
      account.enabled !== false &&
      hasConfiguredNextcloudAccount(mergeNextcloudTalkAccountConfig(params.cfg, accountId), {}),
  );
}
