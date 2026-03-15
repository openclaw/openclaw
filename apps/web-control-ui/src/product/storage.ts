import {
  PREFERENCE_MEMORY_STORAGE_KEY,
  defaultPreferenceMemory,
} from "./defaults";
import type { PreferenceMemory } from "./agent-contract";
import type { Language } from "../core/i18n";

const LANGUAGE_STORAGE_KEY = "openclaw:web-control-ui:language";

export function loadLanguagePreference(): Language | null {
  try {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === "zh" || stored === "en") {
      return stored;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveLanguagePreference(lang: Language): void {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    // Ignore storage errors
  }
}

export function loadPreferenceMemory(): PreferenceMemory {
  try {
    const raw = window.localStorage.getItem(PREFERENCE_MEMORY_STORAGE_KEY);
    if (!raw) {
      return defaultPreferenceMemory();
    }
    const parsed = JSON.parse(raw) as Partial<PreferenceMemory>;
    const fallback = defaultPreferenceMemory();
    return {
      visualStyle: Array.isArray(parsed.visualStyle)
        ? parsed.visualStyle.filter((v): v is string => typeof v === "string")
        : fallback.visualStyle,
      layout: Array.isArray(parsed.layout)
        ? parsed.layout.filter((v): v is string => typeof v === "string")
        : fallback.layout,
      modules: Array.isArray(parsed.modules)
        ? parsed.modules.filter((v): v is string => typeof v === "string")
        : fallback.modules,
      dislikes: Array.isArray(parsed.dislikes)
        ? parsed.dislikes.filter((v): v is string => typeof v === "string")
        : fallback.dislikes,
      currentGoal:
        typeof parsed.currentGoal === "string" && parsed.currentGoal.trim()
          ? parsed.currentGoal
          : fallback.currentGoal,
    };
  } catch {
    return defaultPreferenceMemory();
  }
}

export function savePreferenceMemory(memory: PreferenceMemory) {
  window.localStorage.setItem(PREFERENCE_MEMORY_STORAGE_KEY, JSON.stringify(memory));
}
