# Implementation Plan: Bedrock Guardrails

## Overview

Add Amazon Bedrock Guardrails support to the `amazon-bedrock` extension plugin. The implementation extends the plugin config schema, adds a guardrail stream wrapper factory, wires it into registration, and updates documentation. Each task builds incrementally so the feature is testable at every step.

## Environment Setup

- [ ] 0. Prepare development environment
  - [x] 0.1 Install pnpm 10.32.1
    - The repo declares `"packageManager": "pnpm@10.32.1"` — all scripts, CI, and lockfile depend on pnpm
    - Run: `npm install -g pnpm@10.32.1`
    - Alternative: `npm install -g corepack && corepack enable && corepack prepare pnpm@10.32.1 --activate`
    - Verify: `pnpm --version` should output `10.32.1`

  - [x] 0.2 Enable Windows Developer Mode (if not already enabled)
    - pnpm uses symlinks for `node_modules` — Windows requires Developer Mode or an elevated terminal for symlink creation
    - Settings > For Developers > Developer Mode toggle
    - Without this, `pnpm install` may fail with `EPERM` errors on symlink creation

  - [ ] 0.3 Enable long paths (if not already enabled)
    - Deep `node_modules` paths in this monorepo can exceed the Windows 260-char default limit
    - Run as admin: `New-Item -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -Value 1 -PropertyType DWORD -Force`
    - Requires reboot to take effect
    - Also ensure git is configured: `git config --system core.longpaths true`

  - [x] 0.4 Install dependencies
    - Run: `pnpm install`
    - This pulls all devDependencies (Vitest, fast-check, TypeScript, Oxlint, Oxfmt) and extension deps (`@aws-sdk/client-bedrock` for the amazon-bedrock extension)
    - Watch for patch application warnings — the repo uses `pnpm.patchedDependencies` with Unix-style patch files; if patches fail, check `.gitattributes` is preserving line endings on `.patch` files

  - [x] 0.5 Verify the toolchain works
    - Run: `pnpm build` — type-check + compile (may need `NODE_OPTIONS=--max-old-space-size=8192` if OOM on this large monorepo)
    - Run: `pnpm check` — lint + format check via Oxlint/Oxfmt
    - Run: `pnpm test:extension amazon-bedrock` — scoped test for the extension we're modifying
    - If any of these fail on a clean checkout with no local changes, the failures are pre-existing on `main` and not your problem

  - [ ] 0.6 (Optional) Install Bun
    - AGENTS.md recommends Bun for TypeScript execution (scripts, dev, tests) but it's not required
    - Node works for everything; Bun is a nice-to-have for faster script execution
    - Install: https://bun.sh/docs/installation (Windows support exists but is less mature)
    - Skip this if you don't want the extra dependency

## Tasks

- [ ] 1. Extend config schema and define GuardrailConfig type
  - [ ] 1.1 Add `guardrail` object to `configSchema.properties` in `extensions/amazon-bedrock/openclaw.plugin.json`
    - Add `guardrail` as an optional object property with `additionalProperties: false`
    - Define `guardrailIdentifier` (string), `guardrailVersion` (string), `streamProcessingMode` (string, enum: `["sync", "async"]`)
    - Set `required: ["guardrailIdentifier", "guardrailVersion"]` on the `guardrail` object
    - _Requirements: 1.1, 1.2, 1.3, 1.4_

  - [ ] 1.2 Add `GuardrailConfig` type in `extensions/amazon-bedrock/index.ts`
    - Define a local `GuardrailConfig` type with `guardrailIdentifier: string`, `guardrailVersion: string`, `streamProcessingMode?: "sync" | "async"`
    - _Requirements: 1.1, 1.2, 1.3_

- [ ] 2. Implement guardrail wrapper factory and wire into registration
  - [ ] 2.1 Implement `createGuardrailWrapStreamFn` in `extensions/amazon-bedrock/index.ts`
    - Import `streamWithPayloadPatch` from `openclaw/plugin-sdk/provider-stream`
    - Create a function that takes the inner `wrapStreamFn` callback and a `GuardrailConfig`, returns a new `wrapStreamFn` callback
    - The returned callback calls the inner `wrapStreamFn` first (preserving cache behavior), then applies `streamWithPayloadPatch` on the result to inject `guardrailConfig` into the payload
    - Always set `guardrailIdentifier` and `guardrailVersion`; conditionally include `streamProcessingMode` only when specified
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2_

  - [ ] 2.2 Wire guardrail wrapper in `register(api)` in `extensions/amazon-bedrock/index.ts`
    - Read `api.pluginConfig` and extract the `guardrail` property
    - If `guardrail` is present with required fields, build a `GuardrailConfig` and wrap the existing `wrapStreamFn` with `createGuardrailWrapStreamFn`
    - If `guardrail` is absent, use the existing `wrapStreamFn` unchanged
    - _Requirements: 1.5, 2.1, 3.3_

  - [ ]* 2.3 Write property test: streamProcessingMode rejects invalid values
    - **Property 1: streamProcessingMode rejects invalid values**
    - **Validates: Requirements 1.4**

  - [ ]* 2.4 Write property test: Absent guardrail config means no injection
    - **Property 2: Absent guardrail config means no injection**
    - **Validates: Requirements 1.5, 3.3**

  - [ ]* 2.5 Write property test: Guardrail config round-trip into payload
    - **Property 3: Guardrail config round-trip into payload**
    - **Validates: Requirements 2.1, 2.2, 2.3**

  - [ ]* 2.6 Write property test: onPayload chain preservation
    - **Property 4: onPayload chain preservation**
    - **Validates: Requirements 2.4**

  - [ ]* 2.7 Write property test: Guardrail injection composes with cache behavior for all model types
    - **Property 5: Guardrail injection composes with cache behavior for all model types**
    - **Validates: Requirements 2.5, 3.1, 3.2**

- [ ] 3. Checkpoint - Verify core implementation
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Add unit tests for guardrail behavior
  - [ ]* 4.1 Write unit tests in `extensions/amazon-bedrock/index.test.ts`
    - Test: schema shape validation — verify `openclaw.plugin.json` contains the `guardrail` object with correct property types, required fields, and enum constraint
    - Test: no guardrail config — register without `guardrail`, call `wrapStreamFn`, verify no `guardrailConfig` in payload
    - Test: guardrail with `streamProcessingMode` — register with full config including `streamProcessingMode: "sync"`, verify payload contains all three fields
    - Test: guardrail without `streamProcessingMode` — register omitting `streamProcessingMode`, verify payload contains only `guardrailIdentifier` and `guardrailVersion`
    - Test: Anthropic model with guardrail — verify Anthropic model ID gets `guardrailConfig` but not `cacheRetention: "none"`
    - Test: non-Anthropic model with guardrail — verify non-Anthropic model ID gets both `guardrailConfig` and `cacheRetention: "none"`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.3_

- [ ] 5. Update documentation
  - [ ] 5.1 Add Guardrails section to `docs/providers/bedrock.md`
    - Add a new "Guardrails" section after the existing "Notes" section
    - Include a configuration example showing the `guardrail` object with `guardrailIdentifier`, `guardrailVersion`, and `streamProcessingMode`
    - Note that `guardrailIdentifier` accepts both guardrail IDs and full ARNs
    - Note the required IAM permission: `bedrock:ApplyGuardrail`
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 5.2 Write unit test for documentation content
    - Verify `docs/providers/bedrock.md` contains a Guardrails section with the required configuration example and IAM permission note
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [ ] 6. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Finalize PR description and pre-submission checklist
  - [ ] 7.1 Update `pr-draft.md` with actual implementation details
    - Fill in the "Actual" results in Repro + Verification based on real test output
    - Fill in "Human Verification" with scenarios actually verified
    - Attach evidence (test output, logs) in the Evidence section
    - Update "Linked Issue/PR" with the actual GitHub Discussion or Issue number
  - [ ] 7.2 Run the full contribution gate
    - Run `pnpm test:extension amazon-bedrock` (fast extension lane)
    - Run `pnpm build && pnpm check && pnpm test` (full landing gate)
    - If config schema changed, run `pnpm config:docs:gen` and `pnpm config:docs:check`
    - Verify no `[INEFFECTIVE_DYNAMIC_IMPORT]` warnings from `pnpm build`
  - [ ] 7.3 Validate PR against CONTRIBUTING.md checklist
    - Confirm PR is focused (one feature, no unrelated changes)
    - Confirm American English in all code, comments, docs, UI strings
    - Confirm no `CODEOWNERS`-protected files were touched without owner approval
    - Confirm AI-assistance is disclosed in PR description
    - Confirm bot review conversations are resolved or replied to
    - If Codex access available, run `codex review --base origin/main` and address findings

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using `fast-check`
- Unit tests validate specific examples and edge cases
- All code is TypeScript (ESM), matching the repo's existing patterns
- The guardrail wrapper imports `streamWithPayloadPatch` from `openclaw/plugin-sdk/provider-stream` (the public SDK surface)
