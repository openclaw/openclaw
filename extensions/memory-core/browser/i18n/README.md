# Memory presentation translations

`locales/en.ts` owns the overview and indexed-search English catalog. `locales/translated.json` retains the existing host translations with matching English hashes. Missing translations fall back to English.

English is included in the initial view bundle. The translated catalog loads on the first non-English locale; the view uses English until that request settles.

The repository Control UI i18n verifier and locale refresh discover this catalog beside the declared browser entry. Keep generated translation memory updates separate from source changes, as for Workboard.
