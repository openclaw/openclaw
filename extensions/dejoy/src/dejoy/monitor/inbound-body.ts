/**
 * Inbound body text for the agent: in group/channel contexts we prefix with
 * sender label so the model can distinguish who said what (see finalizeInboundContext
 * BodyForAgent fallback and P1 badge: preserve sender identity in group inbound context).
 */

export function resolveDeJoySenderUsername(senderId: string): string | undefined {
  const username = senderId.split(":")[0]?.replace(/^@/, "").trim();
  return username ? username : undefined;
}

export function resolveDeJoyInboundSenderLabel(params: {
  senderName: string;
  senderId: string;
  senderUsername?: string;
}): string {
  const senderName = params.senderName.trim();
  const senderUsername = params.senderUsername ?? resolveDeJoySenderUsername(params.senderId);
  if (senderName && senderUsername && senderName !== senderUsername) {
    return `${senderName} (${senderUsername})`;
  }
  return senderName || senderUsername || params.senderId;
}

export function resolveDeJoyBodyForAgent(params: {
  isDirectMessage: boolean;
  bodyText: string;
  senderLabel: string;
}): string {
  if (params.isDirectMessage) {
    return params.bodyText;
  }
  return `${params.senderLabel}: ${params.bodyText}`;
}
