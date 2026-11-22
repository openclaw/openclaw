# Workboard translations

`locales/en.ts` owns the browser plugin's English text. `locales/translated.json`
is an authored plugin catalog, including translations retained from the earlier
Control UI and subsequent plugin edits. Missing translations fall back to English.
English is included in the initial view bundle. The translated catalog loads on
the first non-English locale; the view uses English until that request settles.

The repository's `pnpm ui:i18n:verify` discovers `i18n/locales/` beside each
plugin's declared browser entry. It checks English key references, catalog shape,
supported locales, and translation placeholders. Historical keys are reported
without deleting or rewriting their translations.

The shared translation memory does not contain matching records for every
retained translation. Do not regenerate this catalog solely from translation
memory or assign current English hashes without verifying the translations.
Keep these plugin translations intact when extending the authoring pipeline.

The existing Control UI Locale Refresh workflow also fills missing plugin keys.
Each locale worker writes only its own `.i18n/<locale>.tm.jsonl` and
`.i18n/<locale>.meta.json` beside `locales/`. These records use verified English
hashes; authored values take precedence even during a forced refresh.

After collecting those independent patches, the aggregate `ui:i18n:sync --write`
run inserts only absent keys into `translated.json` and rebuilds the plugin's
immutable browser assets with the native builder. No-op catalogs keep their
original bytes. Missing or stale memory is an incomplete result, never generated
English presented as a translation. The same generated PR publishes memory,
metadata, the updated catalog and build manifest. Source PRs keep those generated
outputs separate. Keys shared with the host must have identical English text;
plugin-only keys stay outside the host's Vite locale catalog.
