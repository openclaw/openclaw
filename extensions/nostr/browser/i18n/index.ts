import { translateControlUiMessage } from "openclaw/plugin-sdk/control-ui";
import { messages } from "./locales.ts";

export function createTranslator(locale: () => string) {
  return (key: string, params?: Record<string, string>): string =>
    translateControlUiMessage(messages, locale(), key, params);
}

export type Translator = ReturnType<typeof createTranslator>;
