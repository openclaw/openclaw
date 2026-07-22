---
summary: "Add or update product-owned text without breaking fallback, structured output, or generated catalogs"
read_when:
  - Adding or changing user-visible text
  - Adding a locale or translation
  - Updating UI, CLI, native-app, or documentation catalogs
title: "Localization contributor guide"
---

# Localize product-owned text

Use this guide when you add or change text that OpenClaw presents to users or
operators. Start from reviewed English, work in the catalog owned by the
rendering surface, and keep operational data unchanged.

Do not translate logs, developer-only diagnostics, model-generated content,
upstream error details, protocol codes, commands, flags, paths, IDs, versions,
provider names, or user-authored data.

## Before you begin

- Identify the product owner for the message meaning and English fallback.
- Identify the rendering owner for locale selection, catalogs, escaping, and
  final presentation.
- Check whether the surface already has a catalog and locale resolver. Extend
  that owner boundary instead of adding a second translation path.
- Preserve structured modes such as `--json`. Localization must not change
  field names, status codes, reason codes, array ordering, or value semantics.
- Ask the owning maintainer before changing Gateway, approval, channel safety,
  Plugin SDK, command metadata, or skill metadata contracts.

## Choose the owning workflow

| Surface                          | Reviewed English source                                             | Translation workflow                                                                             | Focused validation                                                                    |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Control UI                       | `ui/src/i18n/locales/en.ts`                                         | Land reviewed English; the Control UI locale refresh workflow updates generated locale artifacts | `pnpm ui:i18n:verify`                                                                 |
| CLI updater dry-run              | `src/cli/i18n/locales/en.ts`                                        | Update the typed CLI catalog and its reviewed locale catalogs                                    | `node scripts/run-vitest.mjs src/cli/i18n/runtime.test.ts src/cli/update-cli.test.ts` |
| CLI onboarding and channel setup | `src/wizard/i18n/locales/en.ts`                                     | Update the wizard-owned catalogs                                                                 | `node scripts/run-vitest.mjs src/wizard/i18n/index.test.ts`                           |
| Android and Apple apps           | Native source projected through `apps/.i18n/native-source.json`     | Update native source, then use the native locale refresh workflow for generated artifacts        | `pnpm native:i18n:baseline` followed by `pnpm native:i18n:verify`                     |
| Documentation                    | English pages under `docs/` and `docs/.i18n/glossary.<locale>.json` | Land English docs; the publish repository owns translated docs and translation memory            | `pnpm docs:check-i18n-glossary`                                                       |

Other CLI commands, the TUI, Gateway errors, approvals, channels, plugins, and
skill metadata do not gain localization merely because the shared runtime can
render a catalog. Add each message family through its existing owner and review
boundary.

Do not hand-edit generated native catalogs, translated documentation trees, or
translation-memory files. Use the owning generator so source and artifact
revisions remain reproducible.

## Add a message

1. **Name both owners.** Record who owns the message meaning and reviewed
   English, and who owns locale selection and final rendering.
2. **Classify the text.** Confirm that it is product-owned presentation rather
   than a log, opaque upstream diagnostic, or operational value.
3. **Localize at the edge.** Pass structured data to the final CLI, UI, TUI,
   channel, or native renderer. Do not translate deep exception construction or
   business logic.
4. **Add a semantic key.** Use a stable namespaced key that describes meaning,
   such as `cli.update.dryRun.channel`, rather than copying the English phrase
   into code.
5. **Classify parameters.** Keep commands, flags, paths, IDs, PIDs, versions,
   protocol codes, raw errors, and user data literal. Put product-owned modes or
   statuses behind catalog labels or bounded selectors.
6. **Update reviewed English.** Preserve existing English output unless the
   change intentionally includes an English-copy update.
7. **Update translations through the owner workflow.** A generated translation
   is evidence of generation, not evidence of linguistic or safety approval.
8. **Delete the superseded authority.** Remove the duplicated hardcoded or
   parsed-prose path after the catalog-backed renderer is proven.

## Change an existing message

Treat an English source edit as a new translation revision:

1. Update the English source and any owner glossary entries.
2. Refresh the owning locale catalogs or generated artifacts.
3. Review placeholder names and protected literals.
4. Update snapshots only when the English change is intentional.
5. Run the owner validation and focused renderer tests.

Keeping the same message key does not make an older translation current.

## Protect structured and sensitive data

Localize presentation around operational values, not the values themselves.
For example, translate the label before a package version, but keep the exact
version parameter unchanged.

When a surface has human and structured output:

- render human output from the selected locale catalog;
- preserve the existing structured payload;
- compare English and non-English structured output for exact equality; and
- keep translated text and locale context out of public diagnostics unless a
  reviewed protocol explicitly owns those fields.

Approval, authentication, authorization, destructive-action, privacy, and
recovery copy require the named product or security reviewer. Until that review
is recorded, use the reviewed English fallback instead of shipping an
unattested production translation.

## Add a locale

1. Add the canonical BCP 47 identifier to `OPENCLAW_LOCALES`, add its aliases,
   fallback, and direction to `OPENCLAW_LOCALE_REGISTRY`, and update the locale
   count assertion in `packages/localization-core/src/locale-registry.test.ts`.
2. Recompute `OPENCLAW_LOCALE_REGISTRY_REVISION` as `sha256:` plus the SHA-256
   digest of `JSON.stringify(OPENCLAW_LOCALE_REGISTRY)`.
3. Add resolution tests for canonical IDs, aliases, unsupported inputs, and
   fallback behavior, then run
   `node scripts/run-vitest.mjs packages/localization-core/src/locale-registry.test.ts`.
4. Add the locale only to owner catalogs and generators that support it.
5. Add representative shaping, segmentation, expansion, and bidirectional
   fixtures when the script requires them.
6. Prove fallback on every adopted surface before claiming support.

Locale registration means OpenClaw recognizes the locale. It does not claim
that every product surface is translated.

## Test the change

Cover the message family rather than only the shared renderer:

- reviewed English output;
- at least one non-English locale;
- unsupported-locale fallback;
- placeholders and protected literal parameters;
- invalid parameters or selectors when applicable;
- structured-output equality; and
- privacy-safe failure diagnostics.

Run the focused command from the workflow table, then run the repository checks
required for the files you changed.

## Troubleshooting

### A locale falls back to English

Confirm that the surface supports the canonical locale, its catalog contains
the key, and the call site uses the surface localization context. A registered
locale without an adopted surface catalog correctly falls back to English.

### Placeholder validation fails

Use the same placeholder names in every translated branch. Do not translate
placeholder names or replace a literal parameter with translated prose.

### Structured output changed

Keep canonical values separate from human presentation. Build the JSON object
from stable English or protocol-owned values, and build localized labels and
sentences only for the human renderer.

### A generated catalog changed unexpectedly

Stop and confirm that you ran the generator for the owning surface. Do not
manually repair generated output. Revert unrelated generated changes and rerun
the narrow workflow.

### A translated message contains English fragments

Check whether the renderer received a raw internal enum or English presentation
label as a parameter. Move product-owned labels into the catalog. Preserve only
genuine operational literals.

## See also

- [Testing](/reference/test)
- [CLI reference](/cli/index)
- [Control UI](/web/control-ui)
- [Plugin manifest](/plugins/manifest)
