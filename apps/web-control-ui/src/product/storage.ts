import {
  PREFERENCE_MEMORY_STORAGE_KEY,
  defaultPreferenceMemory,
} from "./defaults";
import type { PreferenceMemory } from "./agent-contract";

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
