/**
 * Flexible i18n system for mini-lit
 *
 * Users can extend this with their own messages while ensuring
 * mini-lit's required messages are included.
 */
// Default minimal translations for mini-lit components
export const defaultEnglish = {
    "*": "*",
    Copy: "Copy",
    "Copy code": "Copy code",
    "Copied!": "Copied!",
    Download: "Download",
    Close: "Close",
    Preview: "Preview",
    Code: "Code",
    "Loading...": "Loading...",
    "Select an option": "Select an option",
    "Mode 1": "Mode 1",
    "Mode 2": "Mode 2",
    Required: "Required",
    Optional: "Optional",
    "Input Required": "Input Required",
    Cancel: "Cancel",
    Confirm: "Confirm",
};
export const defaultGerman = {
    "*": "*",
    Copy: "Kopieren",
    "Copy code": "Code kopieren",
    "Copied!": "Kopiert!",
    Download: "Herunterladen",
    Close: "Schließen",
    Preview: "Vorschau",
    Code: "Code",
    "Loading...": "Laden...",
    "Select an option": "Option auswählen",
    "Mode 1": "Modus 1",
    "Mode 2": "Modus 2",
    Required: "Erforderlich",
    Optional: "Optional",
    "Input Required": "Eingabe erforderlich",
    Cancel: "Abbrechen",
    Confirm: "Bestätigen",
};
// Store for user-provided translations
let userTranslations = null;
// Default translations (can be overridden)
let translations = {
    en: defaultEnglish,
    de: defaultGerman,
};
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
export function setTranslations(customTranslations) {
    userTranslations = customTranslations;
    translations = customTranslations;
}
/**
 * Get current translations
 */
export function getTranslations() {
    return translations;
}
// Language management
export function getCurrentLanguage() {
    // Check localStorage first
    const stored = localStorage.getItem("language");
    if (stored && translations[stored]) {
        return stored;
    }
    // Fall back to browser language
    const userLocale = navigator.language || navigator.userLanguage;
    const languageCode = userLocale ? userLocale.split("-")[0] : "en";
    return translations[languageCode] ? languageCode : "en";
}
export function setLanguage(code) {
    // Store in localStorage for persistence
    localStorage.setItem("language", code);
    // Reload page to apply new language
    window.location.reload();
}
export function i18n(categoryOrKey, key) {
    const languageCode = getCurrentLanguage();
    const implementation = translations[languageCode] || translations.en;
    if (key === undefined) {
        // Flat access
        const value = implementation[categoryOrKey];
        if (!value) {
            // For functions that return strings, we need to handle them
            if (typeof value === "function") {
                return value;
            }
            console.error(`Unknown i18n key: ${categoryOrKey}`);
            return categoryOrKey;
        }
        return value;
    }
    else {
        // Nested access
        const category = implementation[categoryOrKey];
        if (!category || typeof category !== "object") {
            console.error(`Unknown i18n category: ${categoryOrKey}`);
            return key;
        }
        const value = category[key];
        if (!value) {
            console.error(`Unknown i18n key: ${categoryOrKey}.${key}`);
            return key;
        }
        return value;
    }
}
// Export default for convenience
export default i18n;
//# sourceMappingURL=i18n.js.map