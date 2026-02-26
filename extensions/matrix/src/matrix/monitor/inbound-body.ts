function resolveMatrixSenderUsername(senderId: string): string | undefined {
  const username = senderId.split(":")[0]?.replace(/^@/, "").trim();
  return username ? username : undefined;
}

export function resolveMatrixInboundSenderLabel(params: {
  senderName: string;
  senderId: string;
}): string {
  const senderName = params.senderName.trim();
  const senderUsername = resolveMatrixSenderUsername(params.senderId);
  if (senderName && senderUsername && senderName !== senderUsername) {
    return `${senderName} (${senderUsername})`;
  }
  return senderName || senderUsername || params.senderId;
}

export function resolveMatrixBodyForAgent(params: {
  isDirectMessage: boolean;
  bodyText: string;
  senderName: string;
  senderId: string;
}): string {
  if (params.isDirectMessage) {
    return params.bodyText;
  }
  const senderLabel = resolveMatrixInboundSenderLabel({
    senderName: params.senderName,
    senderId: params.senderId,
  });
  return `${senderLabel}: ${params.bodyText}`;
}
