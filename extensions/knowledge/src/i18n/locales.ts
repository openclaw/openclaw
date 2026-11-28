import en from "./locales/en.js";

export type TranslationMap = { readonly [key: string]: string | TranslationMap };

/**
 * English ships with the view bundle. The Control UI locale refresh adds translated
 * catalogs; until one exists, every locale falls back to English.
 */
export function messages(locale: string): TranslationMap | undefined {
  return locale === "en" ? en : undefined;
}
