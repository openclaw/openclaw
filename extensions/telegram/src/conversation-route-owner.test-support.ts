import { inspectConversationBindingAsync } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import { prepareTelegramConversationRouteOwnersAsync } from "./conversation-route-owner.js";

export async function inspectTelegramConversationRouteOwner(
  params: Parameters<typeof prepareTelegramConversationRouteOwnersAsync>[0][number],
) {
  const [resolve] = await prepareTelegramConversationRouteOwnersAsync([params], async (refs) => {
    const inspections = await Promise.all(refs.map(inspectConversationBindingAsync));
    return () => inspections;
  });
  return resolve!(params);
}
