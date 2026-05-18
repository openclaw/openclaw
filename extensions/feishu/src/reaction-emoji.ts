const FEISHU_REACTION_EMOJI_ALIASES = new Map<string, string>([
  ["+1", "THUMBSUP"],
  ["like", "THUMBSUP"],
  ["thumbsup", "THUMBSUP"],
  ["thumbs_up", "THUMBSUP"],
  ["thumbs-up", "THUMBSUP"],
  ["👍", "THUMBSUP"],
  ["heart", "HEART"],
  ["redheart", "HEART"],
  ["red_heart", "HEART"],
  ["red-heart", "HEART"],
  ["❤", "HEART"],
  ["❤️", "HEART"],
  ["clap", "CLAP"],
  ["applause", "CLAP"],
  ["👏", "CLAP"],
  ["ok", "OK"],
  ["okay", "OK"],
  ["👌", "OK"],
  ["smile", "SMILE"],
  ["smiley", "SMILE"],
  ["🙂", "SMILE"],
  ["😊", "SMILE"],
]);

function normalizeEmojiAliasKey(value: string): string {
  return value
    .trim()
    .replace(/^:+|:+$/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, "")
    .replace(/[\uFE0E\uFE0F]/gu, "");
}

export function normalizeFeishuEmojiType(value: string): string {
  const trimmed = value.trim();
  const alias = FEISHU_REACTION_EMOJI_ALIASES.get(normalizeEmojiAliasKey(trimmed));
  if (alias) {
    return alias;
  }
  return trimmed;
}
