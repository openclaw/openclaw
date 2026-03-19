---
name: openclaw-release-maintainer
description: Maintainer workflow for OpenClaw releases, prereleases, advisories, changelog release notes, and publish validation. Use when Codex needs to prepare or verify stable or beta release steps, align version naming, assemble release notes, handle GHSA patch or publish flow, check release auth requirements, or validate publish-time commands and artifacts.
---

# OpenClaw Release Maintainer

Use this skill for release, advisory, and publish-time workflow. Keep ordinary development changes outside this skill.

## Respect release guardrails

- Do not change version numbers without explicit operator approval.
- Ask permission before any npm publish or release step.
- Use the private maintainer release docs for the actual runbook and `docs/reference/RELEASING.md` for public policy.

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

## Use the right auth flow

- Core `openclaw` publish uses GitHub trusted publishing.
- Do not use `NPM_TOKEN` or the plugin OTP flow for core releases.
- `@openclaw/*` plugin publishes use a separate maintainer-only flow.
- Only publish plugins that already exist on npm; bundled disk-tree-only plugins stay unpublished.

## Patch and publish GHSAs safely

- Before advisory review, read `SECURITY.md`.
- Fetch advisory details:

```bash
gh api /repos/openclaw/openclaw/security-advisories/<GHSA>
npm view openclaw version --userconfig "$(mktemp)"
```

- Make sure private fork PRs are closed:

```bash
fork=$(gh api /repos/openclaw/openclaw/security-advisories/<GHSA> | jq -r .private_fork.full_name)
gh pr list -R "$fork" --state open
```

- Write Markdown descriptions through a heredoc file, not escaped `\n` strings.
- Build advisory patch JSON with `jq`.
- Do not set `severity` and `cvss_vector_string` in the same PATCH call.
- Publish by PATCHing the advisory with `"state":"published"`; there is no separate `/publish` endpoint.
- After publish, re-fetch and confirm:
  - `state=published`
  - `published_at` is set
  - the description does not contain literal escaped `\\n`
