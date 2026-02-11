# Plan: PR pre-merge fixes (Hugging Face / Together onboarding)

**Scope:** Address review issues before merging the Hugging Face + Together onboarding PR.  
**Confidence:** 3/5 — fixes are well-scoped; one item may already be satisfied in current branch.

---

## Investigation summary

### 1. Non-interactive Together inference (“--together-api-key” → authChoice)

**Review claim:** `togetherApiKey` is in the inferred-options Pick but no `AUTH_CHOICE_FLAG_MAP` entry exists, so `--together-api-key` won’t infer authChoice.

**Current codebase:**

- **File:** `src/commands/onboard-non-interactive/local/auth-choice-inference.ts`
- **Pick (lines 9–27):** Includes `togetherApiKey` and `huggingfaceApiKey`.
- **AUTH_CHOICE_FLAG_MAP (lines 29–51):** Contains:
  - Line 43: `{ flag: "togetherApiKey", authChoice: "together-api-key", label: "--together-api-key" }`
  - Line 49: `{ flag: "huggingfaceApiKey", authChoice: "huggingface-api-key", label: "--huggingface-api-key" }`

**Conclusion:** In the current tree, Together (and Hugging Face) non-interactive inference is wired: both the Pick and the flag map include them. If the PR branch is behind or the review was against an older version, the fix is to add the same entry. No duplicate or conflicting definition of the map was found.

---

### 2. Unused import `isHuggingfacePolicyLocked`

**Review claim:** `isHuggingfacePolicyLocked` is imported but never used (only referenced in a comment), risking unused-import checks / dead code.

**Current codebase:**

- **Defined:** `src/agents/huggingface-models.ts` (line 13).
- **Used:** Only in `src/agents/huggingface-models.test.ts` (import + tests).
- **Other imports from `huggingface-models.js`:**
  - `auth-choice.apply.huggingface.ts`: only `discoverHuggingfaceModels`.
  - `models-config.providers.ts`: `discoverHuggingfaceModels`, `HUGGINGFACE_BASE_URL`, `HUGGINGFACE_MODEL_CATALOG`, `buildHuggingfaceModelDefinition`.
  - `onboard-auth.config-core.ts`: `buildHuggingfaceModelDefinition`, `HUGGINGFACE_BASE_URL`, `HUGGINGFACE_MODEL_CATALOG`.

**Conclusion:** No file in the current tree imports `isHuggingfacePolicyLocked` without using it. If the PR branch added such an import (e.g. in an apply or config file) and only mentioned it in a comment, that should be removed. Optional improvement: use `isHuggingfacePolicyLocked` in the Hugging Face apply flow (e.g. to hide “prefer backend” when the model ref is `:cheapest` or `:fastest`).

---

### 3. AuthChoiceGroupId defined in multiple places / inconsistent updates

**Review claim:** AuthChoiceGroupId is defined in multiple places; the PR adds the together group in one file while it already exists elsewhere, risking type mismatches.

**Current codebase:**

- **Single type definition:** `src/commands/onboard-types.ts` (lines 44–64). Union includes `"together"` and `"huggingface"`.
- **Re-export:** `src/commands/auth-choice-options.ts` imports `AuthChoiceGroupId` from `onboard-types.js` and re-exports it (lines 2, 4). No second definition.
- **Usage:** `auth-choice-options.ts` defines `AUTH_CHOICE_GROUP_DEFS` with `value: AuthChoiceGroupId`; entries for `"together"` (lines 114–118) and `"huggingface"` (120–124) are present and consistent with the type.

**Conclusion:** There is a single source of truth for `AuthChoiceGroupId` in `onboard-types.ts`. No duplicate type definition was found. The risk is any other list (e.g. validation allowlists, ordering arrays) that might be missing `together` or `huggingface`; those should be audited for consistency.

---

## Project activities and file-level tasks

### Activity 1: Non-interactive Together (and Hugging Face) inference

**Goal:** Ensure `--together-api-key` (and `--huggingface-api-key`) without `--auth-choice` correctly set authChoice in non-interactive onboarding.

| # | Task | File(s) | Owner |
|---|------|--------|--------|
| 1.1 | Verify `togetherApiKey` is in the Pick and that `AUTH_CHOICE_FLAG_MAP` has an entry for it. If the PR branch is missing the map entry, add it. | `src/commands/onboard-non-interactive/local/auth-choice-inference.ts` | Dev |
| 1.2 | Do the same for `huggingfaceApiKey` (Pick + map entry). | Same file | Dev |
| 1.3 | (Optional) Add a test that runs non-interactive onboarding with only `--together-api-key <key>` (no `--auth-choice`) and asserts authChoice is inferred as `together-api-key`. | New or existing test under `src/commands/onboard-non-interactive/` or `src/cli/program.smoke.test.ts` | Dev |
| 1.3 ✓ | **Done:** Added `src/commands/onboard-non-interactive/local/auth-choice-inference.test.ts` with tests for inferAuthChoiceFromFlags (together, huggingface, multiple flags, no flags, empty values). | `auth-choice-inference.test.ts` | — |

**Line-level subtasks (auth-choice-inference.ts):**

- **Lines 9–27:** Confirm `AuthChoiceFlagOptions` Pick includes both `togetherApiKey` and `huggingfaceApiKey`.
- **Lines 29–51:** Confirm `AUTH_CHOICE_FLAG_MAP` has exactly one entry with `flag: "togetherApiKey"` and `authChoice: "together-api-key"`, and one with `flag: "huggingfaceApiKey"` and `authChoice: "huggingface-api-key"`. If missing, add in the same style as existing entries (e.g. after `veniceApiKey` for together, and include huggingface).

---

### Activity 2: Unused import and dead code (isHuggingfacePolicyLocked)

**Goal:** Remove any unused import of `isHuggingfacePolicyLocked` so CI (e.g. unused-import checks) does not fail; optionally use the function where it adds value.

| # | Task | File(s) | Owner |
|---|------|--------|--------|
| 2.1 | Search the PR branch for `isHuggingfacePolicyLocked`; if any file imports it but does not use it in code (only in a comment), remove the import. | Any file importing from `huggingface-models.js` | Dev |
| 2.2 | (Optional) In the Hugging Face apply flow, use `isHuggingfacePolicyLocked(selectedModelRef)` to skip or adjust “prefer backend” UX when the ref is `:cheapest` or `:fastest`. | `src/commands/auth-choice.apply.huggingface.ts` | Dev |

**Line-level subtasks:**

- **Imports:** In any file that imports `isHuggingfacePolicyLocked`, ensure the symbol is used in an expression or type. If it is only mentioned in a comment, remove it from the import list.
- **auth-choice.apply.huggingface.ts (optional):** Where model options are built (e.g. around lines 83–90), if the default or selected ref uses `:cheapest` or `:fastest`, consider not offering a separate “prefer specific backend” step, or document that policy-locked refs are router-chosen.

---

### Activity 3: AuthChoiceGroupId single source of truth and consistency

**Goal:** Avoid duplicate definitions and keep all group lists in sync with `onboard-types.ts`.

| # | Task | File(s) | Owner |
|---|------|--------|--------|
| 3.1 | Confirm no other file defines a type or const union named `AuthChoiceGroupId` (or equivalent). Keep the only definition in `onboard-types.ts`. | Repo-wide grep / codebase search | Dev |
| 3.2 | List every place that maintains a list of auth-choice groups or group ids (e.g. validation allowlists, CLI choices, TUI options). Ensure each includes `together` and `huggingface` where applicable. | `src/commands/auth-choice-options.ts`, `src/commands/onboard-types.ts`, any CLI/TUI that builds auth choices | Dev |
| 3.3 | If the PR adds a new such list, derive it from `AuthChoiceGroupId` or from `AUTH_CHOICE_GROUP_DEFS` so it cannot drift. | As needed | Dev |

**Line-level subtasks:**

- **onboard-types.ts (lines 44–64):** No change required if the type already includes `"together"` and `"huggingface"`.
- **auth-choice-options.ts:** Ensure `AUTH_CHOICE_GROUP_DEFS` has one object with `value: "together"` and one with `value: "huggingface"`, and that both are in the same order as in the type (or document why order differs).
- **Any other file:** Replace ad-hoc string unions for “group id” with `AuthChoiceGroupId` or with a list built from the same defs.

---

## Verification and CI

- Run `pnpm check` (lint/format) and fix any unused-import or dead-code reports.
- Run `pnpm test` (and, if available, `pnpm test:coverage`) and ensure no regressions.
- Manually test: `openclaw onboard --non-interactive --together-api-key <redacted>` (no `--auth-choice`) and confirm config ends up with Together as the chosen provider and key stored.
- Repeat for `--huggingface-api-key` if desired.

---

## Summary table

| Issue | Current state (this branch) | Action |
|-------|----------------------------|--------|
| Together inference | Pick + FLAG_MAP entry present | Verify on PR branch; add map entry if missing |
| isHuggingfacePolicyLocked | Only used in test file | Remove unused import if present on PR; optionally use in HF apply |
| AuthChoiceGroupId | Single definition in onboard-types.ts | Audit group lists for consistency; no duplicate type |

---

## References

- Core onboarding types: `src/commands/onboard-types.ts`
- Non-interactive inference: `src/commands/onboard-non-interactive/local/auth-choice-inference.ts`
- Non-interactive auth application: `src/commands/onboard-non-interactive/local/auth-choice.ts`
- API provider apply (Together/Hugging Face): `src/commands/auth-choice.apply.api-providers.ts`
- Group defs and options: `src/commands/auth-choice-options.ts`
- Hugging Face models and policy helper: `src/agents/huggingface-models.ts`

Doc link: https://docs.openclaw.ai/ (configuration/onboarding as relevant).
