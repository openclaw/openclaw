import { isThemeId, normalizeThemeMode, type ThemeId, type ThemeMode } from "../theme-ids.js";
import {
  normalizeBackgroundPreference,
  type BackgroundPreference,
} from "./background-preferences.js";
import { normalizeTabIconPreference, type TabIconPreference } from "./tab-icon.js";
import { UI_APPEARANCE_TYPEFACE_VALUES } from "./ui-appearance-typefaces.js";

export { normalizeTabIconPreference, type TabIconPreference } from "./tab-icon.js";

export const UI_APPEARANCE_PREFERENCE_KEYS = {
  theme: "ui.theme",
  themeMode: "ui.themeMode",
  accent: "ui.accent",
  fontUi: "ui.fontUi",
  fontChat: "ui.fontChat",
  background: "ui.background",
  tabIcon: "ui.tabIcon",
} as const;

export type UiAppearancePreferenceValues = {
  "ui.theme": ThemeId;
  "ui.themeMode": ThemeMode;
  "ui.accent": string;
  "ui.fontUi": (typeof UI_APPEARANCE_TYPEFACE_VALUES)[number];
  "ui.fontChat": (typeof UI_APPEARANCE_TYPEFACE_VALUES)[number];
  "ui.background": BackgroundPreference;
  "ui.tabIcon": TabIconPreference;
};
export type UiAppearancePreferenceKey = keyof UiAppearancePreferenceValues;

const normalizeTypeface = (value: unknown) =>
  UI_APPEARANCE_TYPEFACE_VALUES.find((typeface) => typeface === value);

const normalizers: {
  [K in UiAppearancePreferenceKey]: (value: unknown) => UiAppearancePreferenceValues[K] | undefined;
} = {
  // Legacy browser-local "custom" never follows a profile without its palette.
  "ui.theme": (value) => (isThemeId(value) ? value : undefined),
  "ui.themeMode": normalizeThemeMode,
  // Explicit theme ownership is distinct from an absent (inherited) accent.
  "ui.accent": (value) =>
    typeof value === "string" && (value === "theme" || /^#[0-9a-f]{6}$/i.test(value))
      ? value.toLowerCase()
      : undefined,
  "ui.fontUi": normalizeTypeface,
  "ui.fontChat": normalizeTypeface,
  "ui.background": normalizeBackgroundPreference,
  "ui.tabIcon": normalizeTabIconPreference,
};

export function normalizeUiAppearancePreference<K extends UiAppearancePreferenceKey>(
  key: K,
  value: unknown,
): UiAppearancePreferenceValues[K] | undefined {
  return normalizers[key](value);
}
