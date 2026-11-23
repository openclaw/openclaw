export const UI_RAIL_SHORTCUTS_PREFERENCE_KEY = "ui.railShortcuts";
export const UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY = "ui.personalSessionGroups";

/** Shared interpretation of a personal sidebar session reference; other shortcuts are not sessions. */
export function parseSidebarSessionReference(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const prefix = value.startsWith("session:")
    ? "session:"
    : value.startsWith("session-rail:")
      ? "session-rail:"
      : null;
  return prefix ? value.slice(prefix.length).trim() || null : null;
}

/** Missing preferences retain the same default rail as a newly signed-in browser. */
export const DEFAULT_RAIL_SHORTCUTS = ["route:cron", "route:plugins", "route:usage"];

/** Sidebar-only session references, in display order; a rail shortcut is independent. */
export function personalSessionPinKeys(entries: readonly unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    const key =
      typeof entry === "string" &&
      entry.startsWith("session:") &&
      parseSidebarSessionReference(entry);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

export function setPersonalSessionPins(
  entries: readonly unknown[],
  keys: readonly string[],
  pinned: boolean,
): unknown[] {
  const existing = personalSessionPinKeys(entries);
  const wanted = new Set(keys);
  if (pinned) {
    return [
      ...entries,
      ...[...wanted].filter((key) => !existing.has(key)).map((key) => `session:${key}`),
    ];
  }
  return entries.filter(
    (entry) =>
      !(
        typeof entry === "string" &&
        entry.startsWith("session:") &&
        wanted.has(parseSidebarSessionReference(entry) ?? "")
      ),
  );
}
