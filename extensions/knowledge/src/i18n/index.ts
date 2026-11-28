import { translateControlUiMessage } from "openclaw/plugin-sdk/control-ui";
import { messages } from "./locales.js";

let locale = (): string => "en";

/** Read every later lookup in the locale the host currently shows. */
export function bindLocale(host: { readonly locale: string }): void {
  locale = () => host.locale;
}

/** Knowledge-owned Control UI copy; views read it when they render. */
export function t(key: string, params?: Record<string, string>): string {
  return translateControlUiMessage(messages, locale(), key, params);
}
