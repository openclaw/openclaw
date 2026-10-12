import { inspectConversationBindingAsync } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { prepareDiscordConversationRouteOwnersAsync } from "./conversation-route-owner.js";

export async function inspectDiscordConversationRouteOwner(
  params: Parameters<typeof prepareDiscordConversationRouteOwnersAsync>[0][number],
) {
  const [resolve] = await prepareDiscordConversationRouteOwnersAsync([params], async (refs) => {
    const inspections = await Promise.all(refs.map(inspectConversationBindingAsync));
    return () => inspections;
  });
  return resolve!(params);
}
