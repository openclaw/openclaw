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

## Check all relevant release builds

- Always validate the core npm release path before creating the tag.
- Default core release checks:
  - `pnpm check`
  - `pnpm build`
  - `node --import tsx scripts/release-check.ts`
  - `pnpm release:check`
  - `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke`
- Check all release-related build surfaces touched by the release, not only the npm package.
- Include mac release readiness in preflight:
  - if the release includes mac artifacts, run or inspect the mac packaging/notary/appcast flow
  - if the release does not include mac artifacts, explicitly confirm that exception before continuing
- For stable releases, confirm the latest beta already passed the broader release workflows before cutting stable.
- If any required build, packaging step, or release workflow is red, do not say the release is ready.

## Use the right auth flow

- Core `openclaw` publish uses GitHub trusted publishing.
- The publish run must be started manually with `workflow_dispatch`.
- The `npm-release` environment must be approved by `@openclaw/openclaw-release-managers` before publish continues.
- Do not use `NPM_TOKEN` or the plugin OTP flow for core releases.
- `@openclaw/*` plugin publishes use a separate maintainer-only flow.
- Only publish plugins that already exist on npm; bundled disk-tree-only plugins stay unpublished.

## Run the release sequence

1. Confirm the operator explicitly wants to cut a release.
2. Choose the exact target version and git tag.
3. Make every repo version location match that tag before creating it.
4. Update `CHANGELOG.md` and assemble the matching GitHub release notes.
5. Run the full preflight for all relevant release builds, including mac readiness when applicable.
6. Confirm the target npm version is not already published.
7. Create and push the git tag.
8. Create or refresh the matching GitHub release.
9. Start `.github/workflows/openclaw-npm-release.yml` with `workflow_dispatch` and the same tag.
10. Wait for `npm-release` approval from `@openclaw/openclaw-release-managers`.
11. After publish, verify npm and any attached release artifacts.

## GHSA advisory work

- Use `openclaw-ghsa-maintainer` for GHSA advisory inspection, patch/publish flow, private-fork validation, and GHSA API-specific publish checks.
