import type { ChannelDirectTargetResolution } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { resolveSlackAccount } from "./accounts.js";
import { getSlackInstallationTeamId } from "./installation-identity-state.js";
import { formatSlackTarget, parseSlackTarget } from "./target-parsing.js";

/**
 * Slack sends to `user:<id>` open the user's DM conversation. `teamId`
 * qualifies the target when the id does not already name a workspace.
 */
export function resolveSlackDirectTarget(params: {
  senderId: string;
  teamId?: string;
}): ChannelDirectTargetResolution | undefined {
  const target = parseSlackTarget(params.senderId, { defaultKind: "user" });
  if (target?.kind !== "user") {
    return undefined;
  }
  return {
    kind: "direct",
    to: formatSlackTarget({
      kind: "user",
      id: target.id,
      teamId: target.teamId ?? params.teamId,
      explicitKind: true,
    }),
  };
}

/** Direct target in the account's connected workspace; malformed ids map to nothing. */
export const resolveSlackAccountDirectTarget: NonNullable<
  ChannelMessagingAdapter["resolveDirectTarget"]
> = ({ cfg, accountId, senderId }) => {
  try {
    return resolveSlackDirectTarget({
      senderId,
      teamId: getSlackInstallationTeamId(resolveSlackAccount({ cfg, accountId }).accountId),
    });
  } catch {
    return undefined;
  }
};
