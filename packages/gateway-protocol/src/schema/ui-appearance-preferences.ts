import { isThemeId, normalizeThemeMode } from "../theme-ids.js";
import { normalizeTabIconPreference } from "./tab-icon.js";
import { UI_APPEARANCE_TYPEFACE_VALUES } from "./ui-appearance-typefaces.js";

export { normalizeTabIconPreference, type TabIconPreference } from "./tab-icon.js";

export const UI_APPEARANCE_PREFERENCE_KEYS = {
  theme: "ui.theme",
  themeMode: "ui.themeMode",
  accent: "ui.accent",
  fontUi: "ui.fontUi",
  fontChat: "ui.fontChat",
  tabIcon: "ui.tabIcon",
} as const;

export type UiAppearancePreferenceKey =
  (typeof UI_APPEARANCE_PREFERENCE_KEYS)[keyof typeof UI_APPEARANCE_PREFERENCE_KEYS];

const UI_APPEARANCE_TYPEFACES = new Set<string>(UI_APPEARANCE_TYPEFACE_VALUES);

export function normalizeUiAppearancePreference(
  key: UiAppearancePreferenceKey,
  value: unknown,
): string | undefined {
  if (key === UI_APPEARANCE_PREFERENCE_KEYS.tabIcon) {
    return normalizeTabIconPreference(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  if (key === UI_APPEARANCE_PREFERENCE_KEYS.accent) {
    // Explicit theme ownership is distinct from an absent (inherited) accent.
    return value === "theme" || /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : undefined;
  }
  if (
    key === UI_APPEARANCE_PREFERENCE_KEYS.fontUi ||
    key === UI_APPEARANCE_PREFERENCE_KEYS.fontChat
  ) {
    return UI_APPEARANCE_TYPEFACES.has(value) ? value : undefined;
  }
  if (key === UI_APPEARANCE_PREFERENCE_KEYS.theme) {
    // Legacy browser-local "custom" never follows a profile without its palette.
    return isThemeId(value) ? value : undefined;
  }
  return normalizeThemeMode(value);
}
