import { translateControlUiMessage } from "openclaw/plugin-sdk/control-ui";
import en from "./i18n/locales/en.js";

/** Plugin-owned role copy uses the host's locale and public translation contract. */
export function roleText(locale: string, key: string, params?: Record<string, string>): string {
  return translateControlUiMessage(
    (language) => (language === "en" ? en : undefined),
    locale,
    key,
    params,
  );
}
