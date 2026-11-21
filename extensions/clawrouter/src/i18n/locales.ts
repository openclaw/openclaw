import en from "./locales/en.ts";

export type TranslationMap = { readonly [key: string]: string | TranslationMap };

// English only for now: loading foreign catalogs needs a translated.json, which this plugin
// doesn't have yet. Missing locales fall back to English in translateControlUiMessage.
export function messages(locale: string): TranslationMap | undefined {
  return locale === "en" ? en : undefined;
}
