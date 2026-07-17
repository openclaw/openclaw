import { OpenClawLocale } from "./locale-registry.mjs";

//#region src/context.d.ts
type LocalizationAudience = "user" | "operator";
type LocalizationSource = "explicit-user" | "explicit-recipient" | "request" | "surface-preference" | "operator-default" | "platform" | "english-default";
type LocalizationContext = {
  locale: OpenClawLocale;
  fallbackLocales: readonly OpenClawLocale[];
  source: LocalizationSource;
  audience: LocalizationAudience;
};
type LocaleResolutionFinding = {
  source: LocalizationSource;
  value: string;
  reason: "invalid" | "unsupported-by-surface";
};
type LocaleResolutionResult = {
  context: LocalizationContext;
  findings: readonly LocaleResolutionFinding[];
};
declare function createLocalizationContext(params: {
  locale: OpenClawLocale;
  source: LocalizationSource;
  audience: LocalizationAudience;
  supportedLocales?: readonly OpenClawLocale[];
}): LocalizationContext;
declare function resolveLocalizationContext(params: {
  audience: LocalizationAudience;
  explicitUser?: string | null;
  request?: string | null;
  surfacePreference?: string | null;
  operatorDefault?: string | null;
  platform?: readonly (string | null | undefined)[];
  supportedLocales?: readonly OpenClawLocale[];
}): LocaleResolutionResult;
declare function resolveProcessLocalizationContext(env: Readonly<Record<string, string | undefined>>, options: {
  audience: LocalizationAudience;
  supportedLocales?: readonly OpenClawLocale[];
  platform?: readonly (string | null | undefined)[];
}): LocaleResolutionResult;
//#endregion
export { LocaleResolutionFinding, LocaleResolutionResult, LocalizationAudience, LocalizationContext, LocalizationSource, createLocalizationContext, resolveLocalizationContext, resolveProcessLocalizationContext };