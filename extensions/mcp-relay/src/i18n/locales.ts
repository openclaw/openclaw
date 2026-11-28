import en from "./locales/en.ts";

export type TranslationMap = { readonly [key: string]: string | TranslationMap };
let translated: Readonly<Record<string, TranslationMap>> = {};

export function messages(locale: string): TranslationMap | undefined {
  return locale === "en" ? en : translated[locale];
}

// The page is plain DOM, so callers re-render when the returned promise settles.
export function loadMessages(locale: string): void | Promise<void> {
  if (locale === "en" || translated[locale]) {
    return;
  }
  return loadTranslated();
}

async function loadTranslated(): Promise<void> {
  try {
    const { default: catalog } = await import("./locales/translated.json", {
      with: { type: "json" },
    });
    translated = catalog;
  } catch {
    // Translation assets are optional; keep the English fallback if a fetch fails.
  }
}
