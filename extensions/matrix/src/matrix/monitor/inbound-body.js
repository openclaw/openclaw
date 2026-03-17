function resolveMatrixSenderUsername(senderId) {
  const username = senderId.split(":")[0]?.replace(/^@/, "").trim();
  return username ? username : void 0;
}
function resolveMatrixInboundSenderLabel(params) {
  const senderName = params.senderName.trim();
  const senderUsername = params.senderUsername ?? resolveMatrixSenderUsername(params.senderId);
  if (senderName && senderUsername && senderName !== senderUsername) {
    return `${senderName} (${senderUsername})`;
  }
  return senderName || senderUsername || params.senderId;
}
function resolveMatrixBodyForAgent(params) {
  if (params.isDirectMessage) {
    return params.bodyText;
  }
  return `${params.senderLabel}: ${params.bodyText}`;
}
export {
  resolveMatrixBodyForAgent,
  resolveMatrixInboundSenderLabel,
  resolveMatrixSenderUsername
};
