import type { ConversationCapabilityProfileParams } from "../conversation-capability-profile.js";

/** Both native MCP adapters project the same requester facts before selecting runtime policy. */
export function projectNativeMcpRunContext(run: ConversationCapabilityProfileParams) {
  return {
    sessionId: run.sessionId,
    runId: run.runId,
    agentAccountId: run.agentAccountId,
    messageProvider: run.messageProvider ?? run.messageChannel,
    messageChannel: run.messageChannel,
    groupId: run.groupId,
    groupChannel: run.groupChannel,
    groupSpace: run.groupSpace,
    spawnedBy: run.spawnedBy,
    senderId: run.senderId,
    senderName: run.senderName,
    senderUsername: run.senderUsername,
    senderE164: run.senderE164,
    senderIsOwner: run.senderIsOwner,
    conversationToolPolicy: run.conversationToolPolicy,
    inputProvenance: run.inputProvenance,
    trustedInternalHandoff: run.trustedInternalHandoff,
    scheduledToolPolicy: run.scheduledToolPolicy,
  };
}
