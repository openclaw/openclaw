import controlUiLocaleEntries from "./control-ui-i18n-config.json" with { type: "json" };
import type { LocaleEntry } from "./control-ui-i18n-sync-plan.ts";

export const CONTROL_UI_LOCALE_ENTRIES = controlUiLocaleEntries satisfies readonly LocaleEntry[];

const LANGUAGE_LABELS = new Map([
  ["en", "English"],
  ["zh-CN", "Simplified Chinese"],
  ["zh-TW", "Traditional Chinese"],
  ["pt-BR", "Brazilian Portuguese"],
  ["ja-JP", "Japanese"],
  ["ko", "Korean"],
  ["fr", "French"],
  ["hi", "Hindi"],
  ["ar", "Arabic"],
  ["it", "Italian"],
  ["tr", "Turkish"],
  ["uk", "Ukrainian"],
  ["id", "Indonesian"],
  ["pl", "Polish"],
  ["th", "Thai"],
  ["vi", "Vietnamese"],
  ["nl", "Dutch"],
  ["fa", "Persian"],
  ["ru", "Russian"],
  ["ca", "Catalan"],
  ["sv", "Swedish"],
  ["de", "German"],
  ["es", "Spanish"],
]);

export function controlUiLanguageLabel(locale: string): string {
  return LANGUAGE_LABELS.get(locale) ?? locale;
}
