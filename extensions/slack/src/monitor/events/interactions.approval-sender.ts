import { isSlackPluginApprovalAuthorizedSender } from "../../approval-auth.js";
import { formatSlackTarget } from "../../target-parsing.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";

export function resolveSlackPluginApprovalSender(params: {
  ctx: Pick<SlackMonitorContext, "cfg" | "accountId" | "teamId">;
  eventScope?: Pick<SlackEventScope, "teamId">;
  userId: string;
}) {
  // Carry the listener-validated team into Gateway custody. A bare Enterprise
  // user ID would lose the configured workspace boundary after this callback.
  const senderId = formatSlackTarget({
    kind: "user",
    id: params.userId,
    teamId: params.eventScope?.teamId ?? params.ctx.teamId,
  });
  return {
    senderId,
    authorized: isSlackPluginApprovalAuthorizedSender({
      cfg: params.ctx.cfg,
      accountId: params.ctx.accountId,
      senderId,
    }),
  };
}
