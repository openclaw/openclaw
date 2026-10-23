import { messages, type TranslationMap } from "./locales.ts";

function lookup(locale: string, key: string): unknown {
  let value: string | TranslationMap | undefined = messages[locale];
  for (const part of key.split(".")) {
    value = value && typeof value === "object" ? value[part] : undefined;
  }
  return value;
}

export function createTranslator(locale: () => string) {
  return (key: string, params?: Record<string, string>): string => {
    const value = lookup(locale(), key) ?? lookup("en", key);
    return typeof value === "string"
      ? value.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? `{${name}}`)
      : key;
  };
}

export type Translator = ReturnType<typeof createTranslator>;
