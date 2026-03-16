export function formatDiscordAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return allowFrom
    .map((entry) =>
      String(entry)
        .trim()
        .replace(/^<@!?/, "")
        .replace(/>$/, "")
        .replace(/^discord:/i, "")
        .replace(/^user:/i, "")
        .replace(/^pk:/i, "")
        .trim()
        .toLowerCase(),
    )
    .filter(Boolean);
}
