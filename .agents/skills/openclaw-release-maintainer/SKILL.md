---
name: openclaw-release-maintainer
description: Maintainer workflow for OpenClaw releases, prereleases, changelog release notes, and publish validation. Use when Codex needs to prepare or verify stable or beta release steps, align version naming, assemble release notes, check release auth requirements, or validate publish-time commands and artifacts.
---

# OpenClaw Release Maintainer

Use this skill for release and publish-time workflow. Keep ordinary development changes and GHSA-specific advisory work outside this skill.

## Respect release guardrails

- Do not change version numbers without explicit operator approval.
- Ask permission before any npm publish or release step.
- This skill should be sufficient to drive the normal release flow end-to-end.
- Use the private maintainer release docs for credentials, recovery steps, and mac signing/notary specifics, and use `docs/reference/RELEASING.md` for public policy.
- Core `openclaw` publish is manual `workflow_dispatch`; creating or pushing a tag does not publish by itself.

## Keep release channel naming aligned

- `stable`: tagged releases only, with npm dist-tag `latest`
- `beta`: prerelease tags like `vYYYY.M.D-beta.N`, with npm dist-tag `beta`
- Prefer `-beta.N`; do not mint new `-1` or `-2` beta suffixes
- `dev`: moving head on `main`
- When using a beta Git tag, publish npm with the matching beta version suffix so the plain version is not consumed or blocked

## Handle versions and release files consistently

- Version locations include:
  - `package.json`
  - `apps/android/app/build.gradle.kts`
  - `apps/ios/Sources/Info.plist`
  - `apps/ios/Tests/Info.plist`
  - `apps/macos/Sources/OpenClaw/Resources/Info.plist`
  - `docs/install/updating.md`
  - Peekaboo Xcode project and plist version fields
- Before creating a release tag, make every version location above match the version encoded by that tag.
- For fallback correction tags like `vYYYY.M.D-N`, the repo version locations still stay at `YYYY.M.D`.
- “Bump version everywhere” means all version locations above except `appcast.xml`.
- Release signing and notary credentials live outside the repo in the private maintainer docs.
- Every OpenClaw release ships the npm package and macOS app together.
- The production Sparkle feed lives at `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`, and the canonical published file is `appcast.xml` on `main` in the `openclaw` repo.
- That shared production Sparkle feed is stable-only. Beta mac releases may
  upload assets to the GitHub prerelease, but they must not replace the shared
  `appcast.xml` unless a separate beta feed exists.
- For fallback correction tags like `vYYYY.M.D-N`, the repo version still stays
  at `YYYY.M.D`, but the mac release must use a strictly higher numeric
  `APP_BUILD` / Sparkle build than the original release so existing installs
  see it as newer.

## Build changelog-backed release notes

- Changelog entries should be user-facing, not internal release-process notes.
- When cutting a mac release with a beta GitHub prerelease:
  - tag `vYYYY.M.D-beta.N` from the release commit
  - create a prerelease titled `openclaw YYYY.M.D-beta.N`
  - use release notes from the matching `CHANGELOG.md` version section
  - attach at least the zip and dSYM zip, plus dmg if available
- Keep the top version entries in `CHANGELOG.md` sorted by impact:
  - `### Changes` first
  - `### Fixes` deduped with user-facing fixes first

## Run publish-time validation

Before tagging or publishing, run:

```bash
node --import tsx scripts/release-check.ts
pnpm release:check
pnpm test:install:smoke
```

For a non-root smoke path:

```bash
  OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke
```

After npm publish, run:

```bash
node --import tsx scripts/openclaw-npm-postpublish-verify.ts <published-version>
```

- This verifies the published registry install path in a fresh temp prefix.
- For stable correction releases like `YYYY.M.D-N`, it also verifies the
  upgrade path from `YYYY.M.D` to `YYYY.M.D-N` so a correction publish cannot
  silently leave existing global installs on the old base stable payload.

## Check all relevant release builds

- Always validate the OpenClaw npm release path before creating the tag.
- Default release checks:
  - `pnpm check`
  - `pnpm build`
  - `node --import tsx scripts/release-check.ts`
  - `pnpm release:check`
  - `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`
- Check all release-related build surfaces touched by the release, not only the npm package.
- Include mac release readiness in preflight by running the public validation
  workflow in `openclaw/openclaw` and the real mac preflight in
  `openclaw/releases-private` for every release.
- Treat the `appcast.xml` update on `main` as part of mac release readiness, not an optional follow-up.
- The workflows remain tag-based. The agent is responsible for making sure
  preflight runs complete successfully before any publish run starts.
- Any fix after preflight means a new commit. Delete and recreate the tag and
  matching GitHub release from the fixed commit, then rerun preflight from
  scratch before publishing.
- For stable mac releases, generate the signed `appcast.xml` before uploading
  public release assets so the updater feed cannot lag the published binaries.
- Serialize stable appcast-producing runs across tags so two releases do not
  generate replacement `appcast.xml` files from the same stale seed.
- For stable releases, confirm the latest beta already passed the broader release workflows before cutting stable.
- If any required build, packaging step, or release workflow is red, do not say the release is ready.

## Use the right auth flow

- OpenClaw publish uses GitHub trusted publishing.
- The publish run must be started manually with `workflow_dispatch`.
- The npm workflow and the private mac publish workflow accept
  `preflight_only=true` to run validation/build/package steps without uploading
  public release assets.
- The private mac workflow also accepts `smoke_test_only=true` for branch-safe
  workflow smoke tests that use ad-hoc signing, skip notarization, skip shared
  appcast generation, and do not prove release readiness.
- `preflight_only=true` on the npm workflow is also the right way to validate an
  existing tag after publish; it should keep running the build checks even when
  the npm version is already published.
- Validation-only runs may be dispatched from a branch when you are testing a
  workflow change before merge.
- `.github/workflows/macos-release.yml` in `openclaw/openclaw` is now a
  public validation-only handoff. It validates the tag/release state and points
  operators to the private repo; it does not build or publish macOS artifacts.
- Real mac preflight and real mac publish both use
  `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml`.
- The private mac workflow runs on GitHub's xlarge macOS runner and uses a
  SwiftPM cache because the Swift build/test/package path is CPU-heavy.
- Private mac preflight uploads notarized build artifacts as workflow artifacts
  instead of uploading public GitHub release assets.
- Private smoke-test runs upload ad-hoc, non-notarized build artifacts as
  workflow artifacts and intentionally skip stable `appcast.xml` generation.
- npm preflight, public mac validation, and private mac preflight must all pass
  before any real publish run starts.
- Real publish runs must be dispatched from `main`; branch-dispatched publish
  attempts should fail before the protected environment is reached.
- The release workflows stay tag-based; rely on the documented release sequence
  rather than workflow-level SHA pinning.
- The `npm-release` environment must be approved by `@openclaw/openclaw-release-managers` before publish continues.
- Mac publish uses
  `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml` for
  build, signing, notarization, packaged mac artifact generation, and
  stable-feed `appcast.xml` artifact generation.
- Real private mac publish uploads the packaged `.zip`, `.dmg`, and
  `.dSYM.zip` assets to the existing GitHub release in `openclaw/openclaw`
  automatically when `OPENCLAW_PUBLIC_REPO_RELEASE_TOKEN` is present in the
  private repo `mac-release` environment.
- For stable releases, the agent must also download the signed
  `macos-appcast-<tag>` artifact from the successful private mac workflow and
  then update `appcast.xml` on `main`.
- For beta mac releases, do not update the shared production `appcast.xml`
  unless a separate beta Sparkle feed exists.
- The private repo targets a dedicated `mac-release` environment. If the GitHub
  plan does not yet support required reviewers there, do not assume the
  environment alone is the approval boundary; rely on private repo access and
  CODEOWNERS until those settings can be enabled.
- Do not use `NPM_TOKEN` or the plugin OTP flow for OpenClaw releases.
- `@openclaw/*` plugin publishes use a separate maintainer-only flow.
- Only publish plugins that already exist on npm; bundled disk-tree-only plugins stay unpublished.

## Fallback local mac publish

- Keep the original local macOS publish workflow available as a fallback in case
  CI/CD mac publishing is unavailable or broken.
- Preserve the existing maintainer workflow Peter uses: run it on a real Mac
  with local signing, notary, and Sparkle credentials already configured.
- Follow the private maintainer macOS runbook for the local steps:
  `scripts/package-mac-dist.sh` to build, sign, notarize, and package the app;
  manual GitHub release asset upload; then `scripts/make_appcast.sh` plus the
  `appcast.xml` commit to `main`.
- `scripts/package-mac-dist.sh` now fails closed for release builds if the
  bundled app comes out with a debug bundle id, an empty Sparkle feed URL, or a
  `CFBundleVersion` below the canonical Sparkle build floor for that short
  version. For correction tags, set a higher explicit `APP_BUILD`.
- `scripts/make_appcast.sh` first uses `generate_appcast` from `PATH`, then
  falls back to the SwiftPM Sparkle tool output under `apps/macos/.build`.
- For stable tags, the local fallback may update the shared production
  `appcast.xml`.
- For beta tags, the local fallback still publishes the mac assets but must not
  update the shared production `appcast.xml` unless a separate beta feed exists.
- Treat the local workflow as fallback only. Prefer the CI/CD publish workflow
  when it is working.
- After any stable mac publish, verify all of the following before you call the
  release finished:
  - the GitHub release has `.zip`, `.dmg`, and `.dSYM.zip` assets
  - `appcast.xml` on `main` points at the new stable zip
  - the packaged app reports the expected short version and a numeric
    `CFBundleVersion` at or above the canonical Sparkle build floor

## Run the release sequence

1. Confirm the operator explicitly wants to cut a release.
2. Choose the exact target version and git tag.
3. Make every repo version location match that tag before creating it.
4. Update `CHANGELOG.md` and assemble the matching GitHub release notes.
5. Run the full preflight for all relevant release builds, including mac readiness.
6. Confirm the target npm version is not already published.
7. Create and push the git tag.
8. Create or refresh the matching GitHub release.
9. Start `.github/workflows/openclaw-npm-release.yml` with `preflight_only=true`
   and wait for it to pass.
10. Start `.github/workflows/macos-release.yml` in `openclaw/openclaw` and wait
    for the public validation-only run to pass.
11. Start
    `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml`
    with `preflight_only=true` and wait for it to pass.
12. If any preflight or validation run fails, fix the issue on a new commit,
    delete the tag and matching GitHub release, recreate them from the fixed
    commit, and rerun all relevant preflights from scratch before continuing.
    Never reuse old preflight results after the commit changes.
13. Start `.github/workflows/openclaw-npm-release.yml` with the same tag for
    the real publish.
14. Wait for `npm-release` approval from `@openclaw/openclaw-release-managers`.
15. Start
    `openclaw/releases-private/.github/workflows/openclaw-macos-publish.yml`
    for the real publish and wait for success.
16. Verify the successful real private mac run uploaded the `.zip`, `.dmg`,
    and `.dSYM.zip` artifacts to the existing GitHub release in
    `openclaw/openclaw`.
17. For stable releases, download `macos-appcast-<tag>` from the successful
    private mac run, update `appcast.xml` on `main`, and verify the feed.
18. For beta releases, publish the mac assets but expect no shared production
    `appcast.xml` artifact and do not update the shared production feed unless a
    separate beta feed exists.
19. After publish, verify npm and the attached release artifacts.

## GHSA advisory work

- Use `openclaw-ghsa-maintainer` for GHSA advisory inspection, patch/publish flow, private-fork validation, and GHSA API-specific publish checks.
