export const UI_RAIL_SHORTCUTS_PREFERENCE_KEY = "ui.railShortcuts";

/** Shared interpretation of a personal sidebar session reference; other shortcuts are not sessions. */
export function parseSidebarSessionReference(value: unknown): string | null {
  if (typeof value !== "string" || !value.startsWith("session:")) {
    return null;
  }
  return value.slice("session:".length).trim() || null;
}
