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

const AI_GENERATED_ENTITY = {
  type: "https://schema.org/Message",
  "@type": "Message",
  "@context": "https://schema.org",
  "@id": "",
  additionalType: ["AIGeneratedContent"],
};

/**
 * Convert @[Name](id) into matching <at> text and mention entities.
 * Only matches where the id looks like a real Teams user/bot ID are treated
 * as mentions. This avoids false positives from documentation or code samples
 * embedded in the message (e.g. `@[表示名](ユーザーID)` in backticks).
 */
/** Build final transport text and its matching entities after Markdown rendering. */
export function buildMSTeamsMessageActivity(text?: string) {
  const sourceText = text ?? "";
  const entities: MentionEntity[] = [];
  let formattedText = "";
  let copiedUntil = 0;

  // Scan once instead of retrying an unanchored regex from every unmatched `@[`, which rescans
  // the tail each time and blocks the event loop quadratically on long malformed text.
  let start = sourceText.indexOf("@[");
  while (start !== -1) {
    // A backslash escapes the next character, so only an unescaped `]` closes the name.
    let close = start + 2;
    while (close < sourceText.length && sourceText[close] !== "]") {
      close += sourceText[close] === "\\" ? 2 : 1;
    }
    // Every later `@[` reaches the same `]` with the same escapes, so no later match can exist.
    if (close >= sourceText.length) {
      break;
    }
    // An empty name or id, or a missing `(`, also fails every `@[` that shares this `]`.
    if (close === start + 2 || sourceText[close + 1] !== "(" || sourceText[close + 2] === ")") {
      start = sourceText.indexOf("@[", close + 1);
      continue;
    }
    const idEnd = sourceText.indexOf(")", close + 2);
    if (idEnd === -1) {
      break;
    }
    const trimmedId = sourceText.slice(close + 2, idEnd).trim();
    // Non-Teams IDs keep their original text but are still consumed, like documentation samples.
    if (TEAMS_BOT_ID_PATTERN.test(trimmedId) || AAD_OBJECT_ID_PATTERN.test(trimmedId)) {
      const trimmedName = sourceText
        .slice(start + 2, close)
        .replace(/\\([\\[\]])/g, "$1")
        .trim();
      const mentionTag = `<at>${trimmedName}</at>`;
      entities.push({
        type: "mention",
        text: mentionTag,
        mentioned: {
          id: trimmedId,
          name: trimmedName,
        },
      });
      formattedText += sourceText.slice(copiedUntil, start) + mentionTag;
      copiedUntil = idEnd + 1;
    }
    start = sourceText.indexOf("@[", idEnd + 1);
  }
  formattedText += sourceText.slice(copiedUntil);
  return {
    type: "message" as const,
    ...(text === undefined ? {} : { text: formattedText }),
    entities: [...entities, AI_GENERATED_ENTITY],
  };
}

export function buildMSTeamsAdaptiveCardActivity(card: Record<string, unknown>) {
  return {
    type: "message" as const,
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }],
  };
}
