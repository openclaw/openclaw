// Msteams plugin module implements conversation reference helpers.
import { tryNormalizeBotFrameworkServiceUrl } from "./bot-framework-service-url.js";
import type { StoredConversationReference } from "./conversation-store.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

export function buildStoredConversationReference(params: {
  activity: MSTeamsTurnContext["activity"];
  conversationId: string;
  conversationType: string;
  teamId?: string;
  /** Thread root message ID for channel thread messages. */
  threadId?: string;
}): StoredConversationReference {
  const { activity, conversationId, conversationType, teamId, threadId } = params;
  const from = activity.from;
  const conversation = activity.conversation;
  const agent = activity.recipient;
  const clientInfo = activity.entities?.find((e) => e.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  // Bot Framework requires tenantId on proactive activities so the connector
  // routes to the right tenant; channel activities often only carry it here.
  const channelDataTenantId = activity.channelData?.tenant?.id;
  const tenantId = channelDataTenantId ?? conversation?.tenantId;
  const aadObjectId = from?.aadObjectId;
  const serviceUrl = tryNormalizeBotFrameworkServiceUrl(activity.serviceUrl);
  return {
    activityId: activity.id,
    user: from ? { id: from.id, name: from.name, aadObjectId: from.aadObjectId } : undefined,
    agent,
    bot: agent ? { id: agent.id, name: agent.name } : undefined,
    conversation: {
      id: conversationId,
      conversationType,
      tenantId,
    },
    ...(tenantId ? { tenantId } : {}),
    ...(aadObjectId ? { aadObjectId } : {}),
    teamId,
    channelId: activity.channelId,
    ...(serviceUrl ? { serviceUrl } : {}),
    locale: activity.locale,
    ...(clientInfo?.timezone ? { timezone: clientInfo.timezone } : {}),
    ...(threadId ? { threadId } : {}),
  };
}
