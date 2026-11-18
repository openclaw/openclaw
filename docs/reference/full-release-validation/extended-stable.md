---
doc-schema-version: 1
summary: "Extended-stable validation dispatch, changelog-only Release SHA reuse, coverage policies, and beta Telegram deferrals"
title: "Extended-stable and changelog-only validation"
read_when:
  - Validating an extended-stable candidate
  - Reusing evidence for a changelog-only Release SHA
  - Checking npm-beta-v1 and npm-stable-v1 coverage policies
---

## Extended-stable validation

Use the admitted helper with [frozen C/Q/P identities and recovery rules](/reference/RELEASING#frozen-qualification-identity): C owns source/version/baselines; Q owns qualification (default C; reviewed main-ancestor via `--workflow-sha <Q>`); independently trusted P admits/verifies.

```bash
VALIDATION_SHA="<exact-candidate-sha>"
PUBLISHER_SHA="<recorded-full-trusted-main-ancestor-sha>"
CONTEXT_REF="extended-stable/YYYY.M.33"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref "$CONTEXT_REF" \
  --admission-workflow-sha "$PUBLISHER_SHA" \
  --admission-workflow-ref main \
  -f validation_purpose=publish \
  -f publication_selection_json='{"route":"extended-stable","npmDistTag":"extended-stable","publishOpenclawNpm":true,"pluginPublishScope":"all-publishable","plugins":[]}' \
  -f release_profile=stable \
  -f run_release_soak=true \
  -f fail_fast=false \
  -f rerun_group=all \
  -f reuse_evidence=false \
  -f dispatch_release_evidence=false
```

- After admission, immutable `release-ci/<Q-prefix>-<unique-id>` selects Q; `ref`/`expected_sha` select C; `target_context_ref` supplies context, not authority. Dispatch `--ref` requires branch/tag, not SHA. Never manually create transport refs or substitute moving main.
- Publication requires admitted candidate-owned `rerun_group=all` evidence and the exact successful attempt; `release-publish/*` selects P, not Q. Follow the linked identity contract for product/qualification/tooling repairs, historical recovery, and diagnostic-only exclusions. Provider/approval/runner recovery preserves identities/inputs. Old targets still require package/installer/update/channel/live proof.

**Changelog-only releases:** final notes at green Code SHA → same Release SHA, successful full parent, exact prepared artifacts; no extra commit/run. Later notes → commit Release SHA and run this helper. [Optional reuse](/reference/RELEASING#changelog-only-evidence-reuse) requires GitHub-proven descent, changed `CHANGELOG/YYYY.M.PATCH.md`, optional matching `CHANGELOG/records/YYYY.M.PATCH.md` additions/modifications, and only modifications to `CHANGELOG.md`. No renames, deletions, other releases, or docs edits. `split-changelog-release-v1` qualifies new package/image bytes; historical root-only receipts retain `changelog-only-release-v1`. Other changes require full Code validation.

| Phase                    | Inputs                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beta-publish`           | `release_profile=beta`, `run_release_soak=false`                                                                                                   |
| `postpublish-confidence` | `validation_purpose=postpublish-confidence`, no publication selection; exact published package; `run_release_soak=true` or explicit focused groups |
| `stable-publish`         | `release_profile=stable`                                                                                                                           |

| All-group policy               | Eligibility                                                                                                                                             | Retained / deferred                                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coveragePolicy=npm-beta-v1`   | Actual beta package, matching release branch/beta tag, beta profile, no soak; not `main` or non-beta targets                                            | Retains Linux/macOS/Windows Node, Control UI, plugins, package integrity, install/update and cross-OS acceptance, QA parity, runtime-pair/restart and tool coverage. Defers native apps, performance, published-package Telegram; broad live/E2E and QA-live remain outside the gate. |
| `coveragePolicy=npm-stable-v1` | Regular final package, matching release branch/tag, stable profile; includes numeric corrections and unchanged base packages with same-source base tags | CI `npm-stable` scope defers only iOS/Watch, Android, native i18n. Retains macOS Swift/OpenClawKit `tests`/`packages`, Linux/macOS/Windows Node, Control UI, plugins, package/installer acceptance, QA, soak, blocking performance.                                                   |

- Deferred beta confidence: exact published beta with `run_release_soak=true`, or explicit `ci`, `performance`, `npm-telegram`, `package`, or relevant QA/live group. Selected children must finish/pass policy; deferred means **not run**, never passed. Stable/full/soak/focused confidence coverage is unchanged.
- Extended-stable, contextless `main`, `full`, and explicit `ci` retain full CI. Reuse requires identical coverage policy, package version, target context, and effective inputs; beta/historical-full receipts cannot substitute for stable npm evidence.

**Native publication:** Current source has no Android version manifest, so Gateway publication skips Android. The following Android path remains for legacy tagged-source recovery. `OpenClaw Release Publish` runs exact-source full CI with Android alongside npm-stable core publication. Successful native qualification **and** core publication gate the separate Android job’s v3 receipt and tag-owned APK dispatch. The receipt binds native run/attempt/tooling ref; proof is rechecked before approval, immediately before dispatch, before APK attestation, and each upload. Frozen non-v3 tags (including `v2026.8.2` and same-source corrections) require `release_profile=full` and retain v2; npm-only evidence is rejected before core publication. Recorded native failures block Android, not core npm/GitHub finalization; the parent may remain active afterward.

macOS keeps native validation/signing/notarization/promotion gates. Signing, notarization, appcast and Windows Hub promotion run alongside/after npm, never delaying it; artifact/promotion gates remain. Windows Hub assets are required before the regular GitHub release leaves draft. Stable npm still requires soak and blocking performance.

**Package selection:** Package Acceptance normally packs resolved `ref`, including full-SHA `pnpm ci:full-release` runs. After beta publication, `release_package_spec=openclaw@YYYY.M.PATCH-beta.N` selects shipped bytes across release checks, Package Acceptance, cross-OS, release-path Docker, and package Telegram. Override `package_acceptance_package_spec` only to intentionally test a different package.

The Codex lane derives `codex_plugin_spec=npm:@openclaw/codex@<version>` from published specs; SHA/artifact runs pack `extensions/codex` at the selected ref. Explicit `codex_plugin_spec` supports `npm:`, `npm-pack:`, `git:`. It grants required Codex CLI install approval, runs CLI preflight and same-session OpenAI turns. Final proof: zero retries, medium thinking, visible progress without Codex `final`, randomized workspace reads, exact artifact write, explicit completion (v2026.7.1 progress-termination regression).

**Telegram:** selected source QA, standalone npm, and Package Acceptance tests run; failures block unless the pinned [waiver policy](/reference/full-release-validation/evidence#release-tooling-waivers) grants that exact failure. Missing credentials/exhausted pools are not proof; preserve candidate identity, credential isolation, and lease cleanup.

- Every beta-profile `all` run without soak—including `main`—automatically defers Package Acceptance Telegram E2E and records effective `skip_package_telegram_e2e=true` in inputs/summary as **not run**. Soak or explicit `rerun_group=package` selects Telegram by default. Explicit beta `-f skip_package_telegram_e2e=true` remains available; stable/full reject it; focused `rerun_group=npm-telegram` is unaffected.
- Source QA requires C to remain a release-branch ancestor or equal its release tag. Build and execution admission independently check context, candidate version, signature/merge attribution, and live maintainer authority. Branch advancement neither selects a new C nor invalidates the old one.
