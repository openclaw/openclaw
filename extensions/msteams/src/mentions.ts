type MentionEntity = {
  type: "mention";
  text: string;
  mentioned: {
    id: string;
    name: string;
  };
};

/**
 * Check whether an ID looks like a valid Teams user/bot identifier.
 * Accepts:
 * - Bot Framework IDs: "28:xxx..." / "29:xxx..." / "8:orgid:..."
 * - AAD object IDs (UUIDs): "d5318c29-33ac-4e6b-bd42-57b8b793908f"
 *
 * Keep this permissive enough for real Teams IDs while still rejecting
 * documentation placeholders like `@[表示名](ユーザーID)`.
 */
const TEAMS_BOT_ID_PATTERN = /^\d+:[a-z0-9._=-]+(?::[a-z0-9._=-]+)*$/i;
const AAD_OBJECT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function isValidTeamsId(id: string): boolean {
  return TEAMS_BOT_ID_PATTERN.test(id) || AAD_OBJECT_ID_PATTERN.test(id);
}

/**
 * Convert @[Name](id) into matching <at> text and mention entities.
 * Only matches where the id looks like a real Teams user/bot ID are treated
 * as mentions. This avoids false positives from documentation or code samples
 * embedded in the message (e.g. `@[表示名](ユーザーID)` in backticks).
 */
export function parseMentions(text: string): {
  text: string;
  entities: MentionEntity[];
} {
  const mentionPattern = /@\[((?:\\[\s\S]|[^\]\\])+)\]\(([^)]+)\)/g;
  const entities: MentionEntity[] = [];

  const formattedText = text.replace(mentionPattern, (match, name, id) => {
    const trimmedId = id.trim();

    if (!isValidTeamsId(trimmedId)) {
      return match;
    }

    const trimmedName = name.replace(/\\([\\[\]])/g, "$1").trim();
    const mentionTag = `<at>${trimmedName}</at>`;
    entities.push({
      type: "mention",
      text: mentionTag,
      mentioned: {
        id: trimmedId,
        name: trimmedName,
      },
    });
    return mentionTag;
  });

  return {
    text: formattedText,
    entities,
  };
}
