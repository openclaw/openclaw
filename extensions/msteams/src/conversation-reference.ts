// Msteams plugin module builds the canonical proactive conversation reference.
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
  const clientInfo = activity.entities?.find((entity) => entity.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  // Bot Framework requires tenantId on proactive activities. Channel invokes
  // commonly expose it only through channelData, not conversation.tenantId.
  const tenantId = activity.channelData?.tenant?.id ?? conversation?.tenantId;
  const aadObjectId = from?.aadObjectId;
  const serviceUrl = tryNormalizeBotFrameworkServiceUrl(activity.serviceUrl);
  return {
    activityId: activity.id,
    user: from ? { id: from.id, name: from.name, aadObjectId: from.aadObjectId } : undefined,
    agent,
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
