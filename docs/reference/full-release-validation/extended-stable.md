---
doc-schema-version: 1
summary: "Extended-stable validation dispatch, changelog-only Release SHA reuse, coverage policies, and Telegram deferrals and waivers"
title: "Extended-stable and changelog-only validation"
read_when:
  - Validating an extended-stable candidate
  - Reusing evidence for a changelog-only Release SHA
  - Checking npm-beta-v1 and npm-stable-v1 coverage policies
---

## Extended-stable validation

Extended-stable validation uses the same checked helper with an immutable
trusted-main Tooling SHA. Keep the exact candidate, Tooling SHA, canonical
context, and workflow transport separate:

```bash
VALIDATION_SHA="<exact-candidate-sha>"
TOOLING_SHA="<recorded-full-main-ancestor-sha>"
CONTEXT_REF="extended-stable/YYYY.M.33"
pnpm ci:full-release \
  --sha "$VALIDATION_SHA" \
  --target-ref "$CONTEXT_REF" \
  --workflow-sha "$TOOLING_SHA" \
  -f release_profile=stable \
  -f run_release_soak=true \
  -f fail_fast=false \
  -f rerun_group=all \
  -f reuse_evidence=false \
  -f dispatch_release_evidence=false
```

The helper creates `release-ci/<tooling-prefix>-<unique-id>` at the Tooling SHA,
dispatches from that named branch, supplies the trusted-main identity, and uses
the exact Validation SHA for both `ref` and `expected_sha` with the canonical
branch in `target_context_ref`. GitHub workflow dispatch `--ref` accepts a branch
or tag, not a raw SHA. Outside extended-stable validation, a direct
canonical-branch dispatch is valid only when its head is also the trusted
workflow implementation. Current extended-stable validation uses distinct
trusted-main tooling and therefore requires the immutable helper.

Backport product failures; make the smallest behavior-preserving repair for
frozen-target tooling; retry provider, approval, or runner failures without a
source change. Any branch change needs a complete new run. Do not omit required
package, installer, update, channel, or live behavior because the target is old.

For a regular release whose qualified Code SHA already contains final notes,
use that same commit as the **Release SHA**. Retain its successful full
validation parent and exact prepared publication artifacts; no extra commit or
validation run is needed solely to separate those roles.

If notes change after qualification, commit only `CHANGELOG.md` as a new
Release SHA and run the same helper for that commit. Product evidence reuse is
optional and requires GitHub to prove that the Release SHA descends from the
green Code SHA with a complete changed path set of exactly `CHANGELOG.md`.
That path records `changelog-only-release-v1` and still qualifies the changed
package and image bytes. Any other source change returns to full Code
validation. See [Releasing](/reference/RELEASING) for the publication sequence.

The conceptual phases map to current inputs:

- `beta-publish`: `release_profile=beta`, `run_release_soak=false`
- `postpublish-confidence`: exact published package plus
  `run_release_soak=true` or explicit focused groups
- `stable-publish`: `release_profile=stable`

For an actual beta package on its matching canonical release branch or beta
tag, `all` with `release_profile=beta` and no soak records
`coveragePolicy=npm-beta-v1`. It retains Linux, macOS, and Windows Node checks,
Control UI, plugins, package integrity, install/update acceptance, Linux cross-OS
package checks, QA parity, core runtime-pair/restart proof, and runtime tool
coverage. Native app qualification, product performance, and published-package
Telegram confidence are deferred. Broad live/E2E and QA-live also remain outside
this bounded gate.

Run deferred confidence against the exact published beta with
`run_release_soak=true`, or select `ci`, `performance`, `npm-telegram`,
`package`, or the relevant QA/live group explicitly. Selected children must
still finish and pass their existing policy; a deferred check is **not run**,
never passed. Stable, full, soak-enabled, and focused validation retain their
existing confidence coverage. `main`, alpha, and non-beta targets do not qualify
for `npm-beta-v1`.

For a regular final package on its matching release branch or tag, `all` with
`release_profile=stable` records `coveragePolicy=npm-stable-v1` and uses CI's
`npm-stable` scope. Numeric corrections qualify, including an unchanged base
package whose base tag resolves to the same source SHA. This policy defers only
macOS Swift/OpenClawKit, iOS/Watch, Android, and native i18n. Linux, macOS, and
Windows Node coverage, Control UI, plugins, package and installer acceptance,
QA, stable soak, and blocking product performance remain required. Extended-stable,
`main` without release context, `full`, and explicit `ci` runs retain full CI.
Evidence reuse requires the same coverage policy, exact package version, target
context, and effective inputs; a beta or historical full receipt cannot silently
replace stable npm qualification.

Native publication owns the deferred qualification. For an npm-stable release,
`OpenClaw Release Publish` starts an exact-source full CI run with Android enabled
in parallel with core publication. Only successful native qualification and core
publication permit the separate Android job to issue a v3 approval receipt and
dispatch the tag-owned APK publisher. The receipt binds the exact native CI run,
attempt, and tooling ref. The publisher rechecks that proof before writing approval,
immediately before dispatch, before APK attestation, and before each asset upload.
Frozen tags without the v3 consumer, including `v2026.8.2` and its same-source
corrections, must use `release_profile=full`; publication rejects npm-only evidence
for those targets before starting core publication. Their historical full-validation
route retains the v2 approval contract. Native failures are
recorded and block Android approval, while core npm publication and GitHub
release finalization remain independent. The parent may remain active for native
work after core publication completes. macOS retains its separate native
validation, signing, notarization, and promotion gates. Stable npm publication
still rejects evidence without soak and blocking product performance.

macOS app signing, notarization, appcast publication, and Windows Hub asset
promotion run in parallel with or after npm publication and never delay npm.
Their own artifact validation and promotion gates still apply; Windows Hub
assets remain required before the regular GitHub release leaves draft.

Package Acceptance normally builds the candidate tarball from the resolved
`ref`, including full-SHA runs dispatched with `pnpm ci:full-release`. After a
beta publish, pass `release_package_spec=openclaw@YYYY.M.PATCH-beta.N` to reuse
the shipped npm package across release checks, Package Acceptance, cross-OS,
release-path Docker, and package Telegram. Use `package_acceptance_package_spec`
only when Package Acceptance should intentionally prove a different package.
The Codex plugin live package lane follows the same state: published
`release_package_spec` values derive `codex_plugin_spec=npm:@openclaw/codex@<version>`;
SHA/artifact runs pack `extensions/codex` from the selected ref; and operators
can set `codex_plugin_spec` directly for `npm:`, `npm-pack:`, or `git:` plugin
sources. The lane grants the explicit Codex CLI install approval required by
that plugin, then runs Codex CLI preflight and same-session OpenAI agent turns.
Its final zero-retry, medium-thinking turn sends visible progress with omitted
Codex `final`, reads randomized workspace inputs, writes their exact artifact,
and sends explicit completion. This catches the v2026.7.1 regression where an
ordinary progress send terminated the turn.

Telegram release tests are best effort in every release profile. Selected source
and package lanes still attempt the real Test Server flow when a Convex credential
is available. They use the canonical 90-second lease-acquisition retry budget;
missing broker access, an exhausted pool, or failed tests remain visible as
failures or skips in the job summaries and evidence, but never block release
validation. Assertions, credential isolation, lease cleanup, and exact candidate
identity checks remain unchanged. A successful release decision does not imply
that Telegram passed; inspect the recorded Telegram outcome separately.

Package Acceptance Telegram E2E is automatically deferred for every beta-profile
`all` run without soak, including beta-profile checks of `main` or alpha targets.
The effective `skip_package_telegram_e2e=true` is captured in the inputs and
summary as **not run**. Soak-enabled runs and explicit `rerun_group=package`
keep Telegram selected by default. The existing
`-f skip_package_telegram_e2e=true` input remains available for an explicit beta
deferral; it is rejected for `stable` and `full` and does not disable the focused
`rerun_group=npm-telegram` workflow.

Best effort is separate from an explicit omission. The reviewed exceptions are
`-f telegram_waiver=2026.8.1-owner-approved` and
`-f telegram_waiver=2026.9.1-owner-approved`. Any future exception requires a
reviewed code change; a matching `<target-version>-owner-approved` string alone
is not authorization. The value must name the validated target's actual
`package.json` version, the sealed candidate version must match, and the profile
must be `stable` or `full`. Beta, prerelease, and unlisted targets are rejected.
Package-spec overrides must be exactly `openclaw@<target-version>`; blank specs
select the sealed candidate.
It omits source Telegram QA, Package Acceptance Telegram E2E, and the
published-package Telegram E2E; their evidence states **waived / not run**,
never passed. Telegram unit tests and every other selected gate remain active,
including stable soak and performance checks. An explicit Telegram rerun or
suite filter, including an aggregate such as `qa-live` or `qa-live-non-slack`
that selects Telegram, conflicts with the waiver and is rejected. The declaration and
target version bind the immutable execution plan, manifest, and reuse identity;
the publisher carries the waiver into release verification notes. The beta-only
package deferral above remains unchanged.
