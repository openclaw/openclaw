import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import { runWithMSTeamsGraphRequestCurrentness } from "./graph.js";

export const MSTEAMS_GROUP_MANAGEMENT_ACTIONS = new Set<ChannelMessageActionName>([
  "addParticipant",
  "removeParticipant",
  "renameGroup",
]);

export function withMSTeamsGraphMutationCurrentness(
  handleAction: NonNullable<ChannelMessageActionAdapter["handleAction"]>,
): NonNullable<ChannelMessageActionAdapter["handleAction"]> {
  return (ctx) => {
    if (
      ctx.action === "pin" ||
      ctx.action === "unpin" ||
      ctx.action === "react" ||
      MSTEAMS_GROUP_MANAGEMENT_ACTIONS.has(ctx.action)
    ) {
      return runWithMSTeamsGraphRequestCurrentness(ctx.assertDirectAdapterHandoff, () =>
        handleAction(ctx),
      );
    }
    return handleAction(ctx);
  };
}
