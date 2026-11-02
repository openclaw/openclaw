export const UI_RAIL_SHORTCUTS_PREFERENCE_KEY = "ui.railShortcuts";
export const UI_PERSONAL_SESSION_GROUPS_PREFERENCE_KEY = "ui.personalSessionGroups";
export const UI_SIDEBAR_AGENT_ORDER_PREFERENCE_KEY = "ui.sidebarAgentOrder";

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
