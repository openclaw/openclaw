function toMessageSidPart(value) {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return "";
}
function parseZalouserMessageSidFull(value) {
  const raw = toMessageSidPart(value);
  if (!raw) {
    return null;
  }
  const [msgIdPart, cliMsgIdPart] = raw.split(":").map((entry) => entry.trim());
  if (!msgIdPart || !cliMsgIdPart) {
    return null;
  }
  return { msgId: msgIdPart, cliMsgId: cliMsgIdPart };
}
function resolveZalouserReactionMessageIds(params) {
  const explicitMessageId = toMessageSidPart(params.messageId);
  const explicitCliMsgId = toMessageSidPart(params.cliMsgId);
  if (explicitMessageId && explicitCliMsgId) {
    return { msgId: explicitMessageId, cliMsgId: explicitCliMsgId };
  }
  const parsedFromCurrent = parseZalouserMessageSidFull(params.currentMessageId);
  if (parsedFromCurrent) {
    return parsedFromCurrent;
  }
  const currentRaw = toMessageSidPart(params.currentMessageId);
  if (!currentRaw) {
    return null;
  }
  if (explicitMessageId && !explicitCliMsgId) {
    return { msgId: explicitMessageId, cliMsgId: currentRaw };
  }
  if (!explicitMessageId && explicitCliMsgId) {
    return { msgId: currentRaw, cliMsgId: explicitCliMsgId };
  }
  return { msgId: currentRaw, cliMsgId: currentRaw };
}
function formatZalouserMessageSidFull(params) {
  const msgId = toMessageSidPart(params.msgId);
  const cliMsgId = toMessageSidPart(params.cliMsgId);
  if (!msgId && !cliMsgId) {
    return void 0;
  }
  if (msgId && cliMsgId) {
    return `${msgId}:${cliMsgId}`;
  }
  return msgId || cliMsgId || void 0;
}
function resolveZalouserMessageSid(params) {
  const msgId = toMessageSidPart(params.msgId);
  const cliMsgId = toMessageSidPart(params.cliMsgId);
  if (msgId || cliMsgId) {
    return msgId || cliMsgId;
  }
  return toMessageSidPart(params.fallback) || void 0;
}
export {
  formatZalouserMessageSidFull,
  parseZalouserMessageSidFull,
  resolveZalouserMessageSid,
  resolveZalouserReactionMessageIds
};
