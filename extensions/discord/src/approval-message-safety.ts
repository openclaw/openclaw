// Discord approval message safety keeps operator metadata inert and bounded.
export const DISCORD_APPROVAL_ALLOWED_MENTIONS = { parse: [] } as const;

const DISCORD_MARKDOWN_META_CHARACTERS = new Set([
  "\\",
  "`",
  "*",
  "_",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "#",
  "+",
  "-",
  ".",
  "!",
  "|",
  "~",
]);

function escapeDiscordApprovalDisplayCharacter(character: string): string {
  if (character === "\n") {
    return "\\n";
  }
  if (character === "\r") {
    return "\\r";
  }
  if (character === "\t") {
    return "\\t";
  }
  const codePoint = character.codePointAt(0) ?? 0;
  if (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029
  ) {
    return `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
  }
  return DISCORD_MARKDOWN_META_CHARACTERS.has(character) ? `\\${character}` : character;
}

/** Keep opaque approval metadata bounded, single-line, and inert in Discord Markdown. */
export function formatDiscordApprovalDisplayValue(value: string, maxChars = 200): string {
  const limit = Number.isFinite(maxChars) ? Math.max(0, Math.trunc(maxChars)) : 200;
  let escaped = "";
  let bounded = "";
  for (const character of value) {
    escaped += escapeDiscordApprovalDisplayCharacter(character);
    if (escaped.length <= limit - 3) {
      bounded = escaped;
    }
    if (escaped.length > limit) {
      return limit <= 3 ? ".".repeat(limit) : `${bounded}...`;
    }
  }
  return escaped;
}
