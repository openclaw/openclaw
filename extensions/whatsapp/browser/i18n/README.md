# WhatsApp Settings translations

`locales/en.ts` owns the English catalog. `locales/translated.json` retains the existing translations. Missing translations fall back to English.

English is included in the initial view bundle. The translated catalog loads on the first non-English locale; the view uses English until that request settles. Locale changes retain the existing settings controls and login state.
