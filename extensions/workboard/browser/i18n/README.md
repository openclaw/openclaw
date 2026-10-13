# Workboard translations

`locales/en.ts` owns the browser plugin's English text. `locales/translated.json`
is an authored plugin catalog, including translations retained from the earlier
Control UI and subsequent plugin edits. Missing translations fall back to English.

The repository's `pnpm ui:i18n:verify` discovers `i18n/locales/` beside each
plugin's declared browser entry. It checks English key references, catalog shape,
supported locales, and translation placeholders. Historical keys are reported
without deleting or rewriting their translations.

The shared translation memory does not contain matching records for every
retained translation. Do not regenerate this catalog solely from translation
memory or assign current English hashes without verifying the translations.
Keep these plugin translations intact when extending the authoring pipeline.
