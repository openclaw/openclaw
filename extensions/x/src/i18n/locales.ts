import en from "./locales/en.ts";

export type TranslationMap = { readonly [key: string]: string | TranslationMap };

// English only until the locale refresh adds locales/translated.json; then load it
// lazily on the Nostr pattern. Other locales fall back to English meanwhile.
export function messages(locale: string): TranslationMap | undefined {
  return locale === "en" ? en : undefined;
}
