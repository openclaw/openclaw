import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  listSlackAccountIds,
  resolveDefaultSlackAccountId,
  resolveSlackAccount,
  resolveSlackConfigAccessorAccount,
  type ResolvedSlackAccount,
  type SlackConfigAccessorAccount,
} from "./accounts.js";
import { SLACK_CHANNEL } from "./setup-shared.js";
import { parseSlackTarget } from "./target-parsing.js";

function formatSlackAllowFrom(allowFrom: Array<string | number>): string[] {
  return formatAllowFromLowercase({ allowFrom }).map((entry) => {
    try {
      const target = parseSlackTarget(entry.replace(/^slack:(?=user:)/, ""));
      if (target?.kind === "user" && !target.teamId && /^[uw][a-z0-9]+$/.test(target.id)) {
        return target.id;
      }
    } catch {
      // Preserve invalid entries for the caller's policy handling.
    }
    return entry;
  });
}

export const slackBaseConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedSlackAccount,
  SlackConfigAccessorAccount
>({
  sectionKey: SLACK_CHANNEL,
  listAccountIds: listSlackAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveSlackAccount),
  resolveAccessorAccount: resolveSlackConfigAccessorAccount,
  defaultAccountId: resolveDefaultSlackAccountId,
  clearBaseFields: ["botToken", "appToken", "userToken", "signingSecret", "name"],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: formatSlackAllowFrom,
  resolveDefaultTo: (account) => account.defaultTo,
});
