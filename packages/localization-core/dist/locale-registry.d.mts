//#region src/locale-registry.d.ts
type LocaleDirection = "ltr" | "rtl";
type LocaleRegistration = {
  id: OpenClawLocale;
  aliases: readonly string[];
  fallback: readonly OpenClawLocale[];
  direction: LocaleDirection;
  englishName: string;
  inferredLanguageDefault?: boolean;
};
declare const OPENCLAW_LOCALES: readonly ["en", "zh-CN", "zh-TW", "pt-BR", "de", "es", "ja-JP", "ko", "fr", "hi", "ar", "it", "tr", "uk", "id", "pl", "th", "vi", "nl", "fa", "ru", "sv"];
type OpenClawLocale = (typeof OPENCLAW_LOCALES)[number];
declare const OPENCLAW_LOCALE_REGISTRY_REVISION = "sha256:f1fc485ce67ea02b74c69e63e648da3fddc51e276d507a2eeb21d49a18898207";
declare const OPENCLAW_LOCALE_REGISTRY: readonly LocaleRegistration[];
declare function normalizeLocaleToken(raw: string | null | undefined): string | null;
declare function matchExactOpenClawLocale(raw: string | null | undefined, supportedLocales?: readonly OpenClawLocale[]): OpenClawLocale | null;
declare function matchInferredOpenClawLocale(raw: string | null | undefined, supportedLocales?: readonly OpenClawLocale[]): OpenClawLocale | null;
declare function getLocaleRegistration(localeId: OpenClawLocale): LocaleRegistration;
declare function getLocaleDirection(localeId: OpenClawLocale): LocaleDirection;
//#endregion
export { LocaleDirection, LocaleRegistration, OPENCLAW_LOCALES, OPENCLAW_LOCALE_REGISTRY, OPENCLAW_LOCALE_REGISTRY_REVISION, OpenClawLocale, getLocaleDirection, getLocaleRegistration, matchExactOpenClawLocale, matchInferredOpenClawLocale, normalizeLocaleToken };