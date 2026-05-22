import type { WizardI18nParams, WizardLocale, WizardTranslationMap } from "./types.js";
export type { WizardI18nParams, WizardLocale, WizardTranslationMap };
export type SetupTranslator = (key: string, params?: WizardI18nParams) => string;
export declare const WIZARD_DEFAULT_LOCALE: WizardLocale;
export declare const WIZARD_SUPPORTED_LOCALES: readonly WizardLocale[];
export declare function resolveWizardLocale(value: string | undefined): WizardLocale;
export declare function resolveWizardLocaleFromEnv(env?: NodeJS.ProcessEnv): WizardLocale;
export declare function wizardT(key: string, params?: WizardI18nParams, options?: {
    locale?: WizardLocale;
}): string;
export declare const t: typeof wizardT;
export declare function createSetupTranslator(options?: {
    locale?: WizardLocale;
    keyPrefix?: string;
}): SetupTranslator;
export declare function listWizardI18nKeys(locale?: WizardLocale): string[];
