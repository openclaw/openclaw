const TEAMS_BOT_ID_PATTERN = /^\d+:[a-z0-9._=-]+(?::[a-z0-9._=-]+)*$/i;
const AAD_OBJECT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function isValidTeamsId(id) {
  return TEAMS_BOT_ID_PATTERN.test(id) || AAD_OBJECT_ID_PATTERN.test(id);
}
function parseMentions(text) {
  const mentionPattern = /@\[([^\]]+)\]\(([^)]+)\)/g;
  const entities = [];
  const formattedText = text.replace(mentionPattern, (match, name, id) => {
    const trimmedId = id.trim();
    if (!isValidTeamsId(trimmedId)) {
      return match;
    }
    const trimmedName = name.trim();
    const mentionTag = `<at>${trimmedName}</at>`;
    entities.push({
      type: "mention",
      text: mentionTag,
      mentioned: {
        id: trimmedId,
        name: trimmedName
      }
    });
    return mentionTag;
  });
  return {
    text: formattedText,
    entities
  };
}
function buildMentionEntities(mentions) {
  return mentions.map((mention) => ({
    type: "mention",
    text: `<at>${mention.name}</at>`,
    mentioned: {
      id: mention.id,
      name: mention.name
    }
  }));
}
function formatMentionText(text, mentions) {
  let formatted = text;
  for (const mention of mentions) {
    const escapedName = mention.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(`@${escapedName}`, "gi");
    formatted = formatted.replace(namePattern, `<at>${mention.name}</at>`);
  }
  return formatted;
}
export {
  buildMentionEntities,
  formatMentionText,
  parseMentions
};
