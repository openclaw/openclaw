---
title: "Release Checklist"
summary: "Step-by-step release checklist for npm + macOS app"
read_when:
  - Cutting a new npm release
  - Cutting a new macOS app release
  - Verifying metadata before publishing
---

# Release Checklist (npm + macOS)

Use `pnpm` from the repo root with Node 24 by default. Node 22 LTS, currently `22.16+`, remains supported for compatibility. Keep the working tree clean before tagging/publishing.

## Operator trigger

When the operator says “release”, immediately do this preflight (no extra questions unless blocked):

- Read this doc and `docs/platforms/mac/release.md`.
- Load env from `~/.profile` and confirm `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect vars are set (SPARKLE_PRIVATE_KEY_FILE should live in `~/.profile`).
- Use Sparkle keys from `~/Library/CloudStorage/Dropbox/Backup/Sparkle` if needed.

## Versioning

Current OpenClaw releases use date-based versioning.

- Stable release version: `YYYY.M.D`
  - Git tag: `vYYYY.M.D`
  - Examples from repo history: `v2026.2.26`, `v2026.3.8`
- Beta prerelease version: `YYYY.M.D-beta.N`
  - Git tag: `vYYYY.M.D-beta.N`
  - Examples from repo history: `v2026.2.15-beta.1`, `v2026.3.8-beta.1`
- Fallback correction tag: `vYYYY.M.D-N`
  - Use only as a last-resort recovery tag when a published immutable release burned the original stable tag and you cannot reuse it.
  - The npm package version stays `YYYY.M.D`; the `-N` suffix is only for the git tag and GitHub release.
  - Prefer betas for normal pre-release iteration, then cut a clean stable tag once ready.
- Use the same version string everywhere, minus the leading `v` where Git tags are not used:
  - `package.json`: `2026.3.8`
  - Git tag: `v2026.3.8`
  - GitHub release title: `openclaw 2026.3.8`
- Do not zero-pad month or day. Use `2026.3.8`, not `2026.03.08`.
- Stable and beta are npm dist-tags, not separate release lines:
  - `latest` = stable
  - `beta` = prerelease/testing
- Dev is the moving head of `main`, not a normal git-tagged release.
- The tag-triggered preview run accepts stable, beta, and fallback correction tags, and rejects versions whose CalVer date is more than 2 UTC calendar days away from the release date.

Historical note:

- Older tags such as `v2026.1.11-1`, `v2026.2.6-3`, and `v2.0.0-beta2` exist in repo history.
- Treat correction tags as a fallback-only escape hatch. New releases should still use `vYYYY.M.D` for stable and `vYYYY.M.D-beta.N` for beta.

1. **Version & metadata**

- [ ] Bump `package.json` version (e.g., `2026.1.29`).
- [ ] Run `pnpm plugins:sync` to align extension package versions + changelogs.
- [ ] Update CLI/version strings in [`src/version.ts`](https://github.com/openclaw/openclaw/blob/main/src/version.ts) and the Baileys user agent in [`src/web/session.ts`](https://github.com/openclaw/openclaw/blob/main/src/web/session.ts).
- [ ] Confirm package metadata (name, description, repository, keywords, license) and `bin` map points to [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) for `openclaw`.
- [ ] If dependencies changed, run `pnpm install` so `pnpm-lock.yaml` is current.

2. **Build & artifacts**

- [ ] If A2UI inputs changed, run `pnpm canvas:a2ui:bundle` and commit any updated [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).
- [ ] `pnpm run build` (regenerates `dist/`).
- [ ] Verify npm package `files` includes all required `dist/*` folders (notably `dist/node-host/**` and `dist/acp/**` for headless node + ACP CLI).
- [ ] Confirm `dist/build-info.json` exists and includes the expected `commit` hash (CLI banner uses this for npm installs).
- [ ] Optional: `npm pack --pack-destination /tmp` after the build; inspect the tarball contents and keep it handy for the GitHub release (do **not** commit it).

3. **Changelog & docs**

- [ ] Update `CHANGELOG.md` with user-facing highlights (create the file if missing); keep entries strictly descending by version.
- [ ] Ensure README examples/flags match current CLI behavior (notably new commands or options).

4. **Validation**

- [ ] `pnpm build`
- [ ] `pnpm check`
- [ ] `pnpm test` (or `pnpm test:coverage` if you need coverage output)
- [ ] `pnpm release:check` (verifies npm pack contents)
- [ ] If `pnpm config:docs:check` fails as part of release validation and the config-surface change is intentional, run `pnpm config:docs:gen`, review `docs/.generated/config-baseline.json` and `docs/.generated/config-baseline.jsonl`, commit the updated baselines, then rerun `pnpm release:check`.
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker install smoke test, fast path; required before release)
  - If the immediate previous npm release is known broken, set `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` or `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` for the preinstall step.
- [ ] (Optional) Full installer smoke (adds non-root + CLI coverage): `pnpm test:install:smoke`
- [ ] (Optional) Installer E2E (Docker, runs `curl -fsSL https://openclaw.ai/install.sh | bash`, onboards, then runs real tool calls):
  - `pnpm test:install:e2e:openai` (requires `OPENAI_API_KEY`)
  - `pnpm test:install:e2e:anthropic` (requires `ANTHROPIC_API_KEY`)
  - `pnpm test:install:e2e` (requires both keys; runs both providers)
- [ ] (Optional) Spot-check the web gateway if your changes affect send/receive paths.

5. **macOS app (Sparkle)**

- [ ] Build + sign the macOS app, then zip it for distribution.
- [ ] Generate the Sparkle appcast (HTML notes via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) and update `appcast.xml`.
- [ ] Keep the app zip (and optional dSYM zip) ready to attach to the GitHub release.
- [ ] Follow [macOS release](/platforms/mac/release) for the exact commands and required env vars.
  - `APP_BUILD` must be numeric + monotonic (no `-beta`) so Sparkle compares versions correctly.
  - If notarizing, use the `openclaw-notary` keychain profile created from App Store Connect API env vars (see [macOS release](/platforms/mac/release)).

6. **Publish (npm)**

- [ ] Confirm git status is clean; commit and push as needed.
- [ ] Confirm npm trusted publishing is configured for the `openclaw` package.
- [ ] Do not rely on an `NPM_TOKEN` secret for this workflow; the publish job uses GitHub OIDC trusted publishing.
- [ ] Push the matching git tag to trigger the preview run in `.github/workflows/openclaw-npm-release.yml`.
- [ ] Run `OpenClaw NPM Release` manually with the same tag to publish after `npm-release` environment approval.
  - Stable tags publish to npm `latest`.
  - Beta tags publish to npm `beta`.
  - Fallback correction tags like `v2026.3.13-1` map to npm version `2026.3.13`.
  - Both the preview run and the manual publish run reject tags that do not map back to `package.json`, are not on `main`, or whose CalVer date is more than 2 UTC calendar days away from the release date.
  - If `openclaw@YYYY.M.D` is already published, a fallback correction tag is still useful for GitHub release and Docker recovery, but npm publish will not republish that version.
- [ ] Verify the registry: `npm view openclaw version`, `npm view openclaw dist-tags`, and `npx -y openclaw@X.Y.Z --version` (or `--help`).

### Troubleshooting (notes from 2.0.0-beta2 release)

- **npm pack/publish hangs or produces huge tarball**: the macOS app bundle in `dist/OpenClaw.app` (and release zips) get swept into the package. Fix by whitelisting publish contents via `package.json` `files` (include dist subdirs, docs, skills; exclude app bundles). Confirm with `npm pack --dry-run` that `dist/OpenClaw.app` is not listed.
- **npm auth web loop for dist-tags**: use legacy auth to get an OTP prompt:
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`
- **`npx` verification fails with `ECOMPROMISED: Lock compromised`**: retry with a fresh cache:
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`
- **Tag needs recovery after a late fix**: if the original stable tag is tied to an immutable GitHub release, mint a fallback correction tag like `vX.Y.Z-1` instead of trying to force-update `vX.Y.Z`.
  - Keep the npm package version at `X.Y.Z`; the correction suffix is for the git tag and GitHub release only.
  - Use this only as a last resort. For normal iteration, prefer beta tags and then cut a clean stable release.

7. **GitHub release + appcast**

- [ ] Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z` (or `git push --tags`).
  - Pushing the tag also triggers the npm release workflow.
- [ ] Create/refresh the GitHub release for `vX.Y.Z` with **title `openclaw X.Y.Z`** (not just the tag); body should include the **full** changelog section for that version (Highlights + Changes + Fixes), inline (no bare links), and **must not repeat the title inside the body**.
- [ ] Attach artifacts: `npm pack` tarball (optional), `OpenClaw-X.Y.Z.zip`, and `OpenClaw-X.Y.Z.dSYM.zip` (if generated).
- [ ] Commit the updated `appcast.xml` and push it (Sparkle feeds from main).
- [ ] From a clean temp directory (no `package.json`), run `npx -y openclaw@X.Y.Z send --help` to confirm install/CLI entrypoints work.
- [ ] Announce/share release notes.

## Plugin publish scope (npm)

We only publish **existing npm plugins** under the `@openclaw/*` scope. Bundled
plugins that are not on npm stay **disk-tree only** (still shipped in
`extensions/**`).

Process to derive the list:

1. `npm search @openclaw --json` and capture the package names.
2. Compare with `extensions/*/package.json` names.
3. Publish only the **intersection** (already on npm).

Current npm plugin list (update as needed):

- @openclaw/bluebubbles
- @openclaw/diagnostics-otel
- @openclaw/discord
- @openclaw/feishu
- @openclaw/lobster
- @openclaw/matrix
- @openclaw/msteams
- @openclaw/nextcloud-talk
- @openclaw/nostr
- @openclaw/voice-call
- @openclaw/zalo
- @openclaw/zalouser

Release notes must also call out **new optional bundled plugins** that are **not
on by default** (example: `tlon`).
