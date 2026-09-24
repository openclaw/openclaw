# Release validation and confidence

Use `$release-openclaw-ci` for workflow dispatch, manifests, and failed-child
recovery. Select the phase below; deferred or omitted checks are not passed.
Every selected child needs terminal evidence. A required failure cannot be
waived by success on another surface.

## Source and package gates

Before tagging or publishing, complete the relevant source/package checks:

```bash
pnpm release:fast-pretag-check
pnpm check:architecture
pnpm build
pnpm ui:build
pnpm qa:otel:smoke
pnpm release:check
pnpm test:install:smoke
```

Use existing equivalent exact-SHA release evidence; do not repeat successful
checks solely because this list mentions them. Source CI, including `pnpm check`,
`pnpm check:test-types`, and cross-OS outcomes, is advisory for npm/ClawHub.
Artifact, install-smoke, survivor, first-hop, pack/npm qualification, target,
and provenance proofs remain required. Code SHA and Release SHA may be the
same commit when it contains final notes; the same successful full parent
qualifies that source and its exact publication bytes. Only a later
CHANGELOG-only descendant may reuse earlier product evidence through the
changelog-only policy, while qualifying its changed package bytes.

`release:fast-pretag-check` protects package-root README, plugin-local runtime,
and npm/ClawHub metadata contracts. Fix real packaging defects before tagging.
For newly publishable packages, read [first-package registry
preparation](first-package.md); do not discover missing ownership during publish
or consume the next beta with ad-hoc bootstrap publication.

Keep plugin `openclaw.release.requireLatestDependencies` declarations. Upstream
latest drift/unavailable lookups are advisory: retain the tested Codex pin and
record warnings. Malformed runtime metadata, package/install failures and
required validation failures still block.

Install smoke also checks pack budget and direct npm global fresh/update paths;
keep those enabled. `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1` is the existing
non-root-skip mode, not permission to skip install proof. Published correction
versions must prove upgrade from their base stable package. Postpublish use:

```bash
OPENCLAW_NPM_EXPECTED_WORKFLOW_REF=refs/tags/release-publish/<tooling-sha12>-<epoch> \
OPENCLAW_NPM_EXPECTED_WORKFLOW_SHA=<tooling-sha> \
node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>
```

Run it from a checkout of the Release SHA once the registry lists the version
(see [regular release](regular-release.md#publish-and-verify)).

`pnpm qa:otel:smoke` supplies local OTLP/redaction coverage without hosted
telemetry credentials. Video-provider checks are conditional on release scope:
`pnpm test:live:media video` is bounded default coverage; explicit FAL coverage
uses `--video-providers fal`. Full transform modes require intentional
`OPENCLAW_LIVE_VIDEO_GENERATION_FULL_MODES=1`. Use `$one-password` before
credentialed tests. Local live model/Parallels rosters require both OpenAI and
Anthropic keys; missing either blocks those lanes, never print their values.

## Beta-publish and the stable fast path

Use `release_profile=beta`, `run_release_soak=false` for beta. Stable-publish
defaults to `release_profile=stable`; the beta profile is a stable's explicit
operator fast path only with `stable_soak_waiver`. A qualifying `all` run for
an actual beta on its canonical branch/tag records `npm-beta-v1`. Native app
CI, performance, and published-package Telegram move to confidence. Node,
Control UI, plugin, cross-OS, QA parity, runtime-pair/restart, and tool coverage
remain selected but advisory; required package/install/update proofs remain
enforced. Beta `all` without soak
also defers Package Acceptance Telegram, broad live/E2E, QA-live and Parallels.
Package Telegram deferral applies to beta-profile main/alpha too, but those do
not qualify for `npm-beta-v1`.

Native app lanes (macos-swift, platform publishers) are advisory for the
npm/ClawHub decision: record their conclusion and fix them in parallel.
Windows node-test outcomes are also advisory for npm/ClawHub; repair their
owner in parallel without holding publication for a green rerun.

Linux Gateway cross-OS lanes are required proof; Windows/macOS variants are
recorded as advisory. Coverage is never reduced: all-group
`cross_os_suite_filter` selections must retain `packaged-fresh`,
`installer-fresh`, and `packaged-upgrade` on all three OSes (nine pairs).
Focused `cross-os` reruns may select individual lanes. Publishing a stable with
a failed advisory lane requires `lane_waiver` (RELEASING.md "Publication
modes"). Read required versus advisory conclusions in the manifest and
`release-ci-summary`.

## Postpublish confidence

Target the exact published beta with `run_release_soak=true` or focused groups.
This phase owns deferred native apps, performance, Telegram, QA-live, broad
Docker/live E2E and Parallels:

- Verify registry/provenance and install/update of the published package,
  including Docker coverage.
- Dispatch **NPM Telegram Beta E2E** from main with
  `package_spec=openclaw@<beta-version>`, `provider_mode=mock-openai`; require
  success. Its shared QA secrets use `qa-live-shared`, not npm publish approval.
  Local `pnpm test:docker:npm-telegram-live` with matching package spec and
  Convex CI environment is a debugging/fallback path.
- Use `$openclaw-parallels-smoke` for published-package install/update with both
  provider keys. Keep plugin installs enabled; disabling them proves no
  plugin/dependency release contract.
- Credentialed channel QA uses **QA-Lab - All Lanes**
  (`qa-live-transports-convex.yml`) against the published tag. SHA targets must
  satisfy its main-ancestor/open-PR-head credential trust gate. It covers mock
  parity, live Matrix and Convex-leased Telegram. After later fixes, rerun
  touched surfaces; rerun this workflow for channel, credential or QA-harness
  changes. Do not substitute unrelated local proof.

A confidence failure does not retroactively unpublish a beta. Classify it and
admit a confirmed product fix only to a new operator-approved candidate.

## Stable-publish and bounded execution

The default stable publishes from beta-profile evidence with the recorded soak
waiver (precedent 2026.9.5 and 2026.9.6); soak, live/E2E, Telegram, QA-live
and Parallels run as postpublish confidence. Opt-in `release_profile=stable` or
`full` selects its stable roster and soak; performance and ordinary tests remain
advisory. Matching beta confidence may support the light promotion
roster in [regular release](regular-release.md), not waive a required gate.

Preserve the validation parent and successful children when continuation is
eligible; parents that produced sealed candidate artifacts need a new parent
with verified evidence reuse. Diagnose failures and retry only the affected
surface within the controller's budget. Flaky tests never hold publication
through advisory suites; an untouched test or passing replay alone proves
neither a flake nor a fix. Change Code SHA only for a confirmed defect in
required proof or publication bytes. Aim to seal within approximately 20 minutes
and publish within an hour; report observed blockers and timing rather than
claiming those objectives as measured guarantees.

Native publication retains separate signing/notarization/promotion gates under
[platform publication](platform-publication.md). Native app lanes stay
advisory for the npm/ClawHub decision and are fixed in parallel. Native publication
never gates npm/ClawHub, GitHub finalization, or main closeout; report each
platform's readiness separately.

Local proof is targeted: never mirror Full Release Validation locally. Run a
lane locally only after it failed in CI, to separate flake from defect, bounded
to 15 minutes per lane; a lane that needs longer reruns in CI through its
focused `rerun_group`. Individual npm install/update phases cap at 300 seconds.
On timeout, inspect the affected lane instead of leaving it running. Serialize
build/package mutations before VM packing so a concurrent build cannot remove
`dist`; avoid load-induced noise.

Fix related required failures at their owner and rerun affected evidence. For
PR preparation/landing or observed hosted-runner stalls, use
`$openclaw-pr-maintainer` / `$openclaw-ci-limits`; never synthesize prepare
artifacts or replace canonical `scripts/pr` with PR-controlled scripts. Record
unrelated main failures instead of adopting them into release scope.
