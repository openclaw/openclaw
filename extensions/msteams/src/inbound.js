function normalizeMSTeamsConversationId(raw) {
  return raw.split(";")[0] ?? raw;
}
function extractMSTeamsConversationMessageId(raw) {
  if (!raw) {
    return void 0;
  }
  const match = /(?:^|;)messageid=([^;]+)/i.exec(raw);
  const value = match?.[1]?.trim() ?? "";
  return value || void 0;
}
function parseMSTeamsActivityTimestamp(value) {
  if (!value) {
    return void 0;
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value !== "string") {
    return void 0;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? void 0 : date;
}
function stripMSTeamsMentionTags(text) {
  return text.replace(/<at[^>]*>.*?<\/at>/gi, "").trim();
}
function wasMSTeamsBotMentioned(activity) {
  const botId = activity.recipient?.id;
  if (!botId) {
    return false;
  }
  const entities = activity.entities ?? [];
  return entities.some((e) => e.type === "mention" && e.mentioned?.id === botId);
}
export {
  extractMSTeamsConversationMessageId,
  normalizeMSTeamsConversationId,
  parseMSTeamsActivityTimestamp,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned
};
