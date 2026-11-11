import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { inspectMattermostAccount, listMattermostAccountIds } from "./mattermost/accounts.js";

export const loadMattermostChannelRuntime = createLazyRuntimeModule(
  () => import("./channel.runtime.js"),
);

export type MattermostDirectoryListParams = Parameters<
  NonNullable<NonNullable<ChannelPlugin["directory"]>["listGroups"]>
>[0];

export function listEnabledMattermostAccounts({
  cfg,
  accountId,
}: Pick<MattermostDirectoryListParams, "cfg" | "accountId">) {
  return (
    accountId
      ? [inspectMattermostAccount({ cfg, accountId })]
      : listMattermostAccountIds(cfg).map((listedAccountId) =>
          inspectMattermostAccount({ cfg, accountId: listedAccountId }),
        )
  ).filter((account) => account.enabled && account.botToken?.trim() && account.baseUrl?.trim());
}
