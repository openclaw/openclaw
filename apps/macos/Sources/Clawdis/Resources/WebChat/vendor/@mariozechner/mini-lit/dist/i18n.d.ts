/**
 * Flexible i18n system for mini-lit
 *
 * Users can extend this with their own messages while ensuring
 * mini-lit's required messages are included.
 */
export type LanguageCode = "en" | "de" | string;
export interface MiniLitRequiredMessages {
    "*": string;
    Copy: string;
    "Copy code": string;
    "Copied!": string;
    Download: string;
    Close: string;
    Preview: string;
    Code: string;
    "Loading...": string;
    "Select an option": string;
    "Mode 1": string;
    "Mode 2": string;
    Required: string;
    Optional: string;
    "Input Required": string;
    Cancel: string;
    Confirm: string;
}
export interface i18nMessages extends MiniLitRequiredMessages {
}
export declare const defaultEnglish: MiniLitRequiredMessages;
export declare const defaultGerman: MiniLitRequiredMessages;
/**
 * Set custom translations for your app
 *
 * @example
 * import { setTranslations } from '@mariozechner/mini-lit';
 *
 * // Your messages must include all MiniLitRequiredMessages
 * const myTranslations = {
 *   en: {
 *     // Required mini-lit messages
 *     "Copy": "Copy",
 *     "Copied!": "Copied!",
 *     // ... all other required messages
 *
 *     // Your app messages
 *     "Welcome": "Welcome",
 *     "Settings": "Settings",
 *   },
 *   de: {
 *     // Required mini-lit messages
 *     "Copy": "Kopieren",
 *     "Copied!": "Kopiert!",
 *     // ... all other required messages
 *
 *     // Your app messages
 *     "Welcome": "Willkommen",
 *     "Settings": "Einstellungen",
 *   }
 * };
 *
 * setTranslations(myTranslations);
 */
export declare function setTranslations(customTranslations: Record<string, i18nMessages>): void;
/**
 * Get current translations
 */
export declare function getTranslations(): Record<string, i18nMessages>;
export declare function getCurrentLanguage(): LanguageCode;
export declare function setLanguage(code: LanguageCode): void;
export declare function i18n<T extends keyof i18nMessages>(key: T): i18nMessages[T];
export declare function i18n<TCategory extends keyof i18nMessages, TKey extends keyof i18nMessages[TCategory]>(category: TCategory, key: TKey): i18nMessages[TCategory][TKey];
export default i18n;
//# sourceMappingURL=i18n.d.ts.map