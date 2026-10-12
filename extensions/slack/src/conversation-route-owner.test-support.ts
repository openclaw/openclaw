import { inspectConversationBindingAsync } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { slackConversationRouteOwners } from "./conversation-route-owner.js";

export async function inspectSlackConversationRouteOwner(
  params: Parameters<
    typeof slackConversationRouteOwners.prepareConversationRouteOwnersAsync
  >[0][number],
) {
  const [resolve] = await slackConversationRouteOwners.prepareConversationRouteOwnersAsync(
    [params],
    async (refs) => {
      const inspections = await Promise.all(refs.map(inspectConversationBindingAsync));
      return () => inspections;
    },
  );
  return resolve!(params);
}
