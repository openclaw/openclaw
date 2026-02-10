---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "Release Checklist"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "Step-by-step release checklist for npm + macOS app"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Cutting a new npm release（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Cutting a new macOS app release（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Verifying metadata before publishing（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Release Checklist (npm + macOS)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use `pnpm` (Node 22+) from the repo root. Keep the working tree clean before tagging/publishing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Operator trigger（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
When the operator says “release”, immediately do this preflight (no extra questions unless blocked):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Read this doc and `docs/platforms/mac/release.md`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Load env from `~/.profile` and confirm `SPARKLE_PRIVATE_KEY_FILE` + App Store Connect vars are set (SPARKLE_PRIVATE_KEY_FILE should live in `~/.profile`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use Sparkle keys from `~/Library/CloudStorage/Dropbox/Backup/Sparkle` if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. **Version & metadata**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Bump `package.json` version (e.g., `2026.1.29`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Run `pnpm plugins:sync` to align extension package versions + changelogs.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Update CLI/version strings: [`src/cli/program.ts`](https://github.com/openclaw/openclaw/blob/main/src/cli/program.ts) and the Baileys user agent in [`src/provider-web.ts`](https://github.com/openclaw/openclaw/blob/main/src/provider-web.ts).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Confirm package metadata (name, description, repository, keywords, license) and `bin` map points to [`openclaw.mjs`](https://github.com/openclaw/openclaw/blob/main/openclaw.mjs) for `openclaw`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] If dependencies changed, run `pnpm install` so `pnpm-lock.yaml` is current.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. **Build & artifacts**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] If A2UI inputs changed, run `pnpm canvas:a2ui:bundle` and commit any updated [`src/canvas-host/a2ui/a2ui.bundle.js`](https://github.com/openclaw/openclaw/blob/main/src/canvas-host/a2ui/a2ui.bundle.js).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm run build` (regenerates `dist/`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Verify npm package `files` includes all required `dist/*` folders (notably `dist/node-host/**` and `dist/acp/**` for headless node + ACP CLI).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Confirm `dist/build-info.json` exists and includes the expected `commit` hash (CLI banner uses this for npm installs).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Optional: `npm pack --pack-destination /tmp` after the build; inspect the tarball contents and keep it handy for the GitHub release (do **not** commit it).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. **Changelog & docs**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Update `CHANGELOG.md` with user-facing highlights (create the file if missing); keep entries strictly descending by version.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Ensure README examples/flags match current CLI behavior (notably new commands or options).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4. **Validation**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm build`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm check`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm test` (or `pnpm test:coverage` if you need coverage output)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `pnpm release:check` (verifies npm pack contents)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke` (Docker install smoke test, fast path; required before release)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If the immediate previous npm release is known broken, set `OPENCLAW_INSTALL_SMOKE_PREVIOUS=<last-good-version>` or `OPENCLAW_INSTALL_SMOKE_SKIP_PREVIOUS=1` for the preinstall step.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] (Optional) Full installer smoke (adds non-root + CLI coverage): `pnpm test:install:smoke`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] (Optional) Installer E2E (Docker, runs `curl -fsSL https://openclaw.ai/install.sh | bash`, onboards, then runs real tool calls):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:install:e2e:openai` (requires `OPENAI_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:install:e2e:anthropic` (requires `ANTHROPIC_API_KEY`)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `pnpm test:install:e2e` (requires both keys; runs both providers)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] (Optional) Spot-check the web gateway if your changes affect send/receive paths.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
5. **macOS app (Sparkle)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Build + sign the macOS app, then zip it for distribution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Generate the Sparkle appcast (HTML notes via [`scripts/make_appcast.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/make_appcast.sh)) and update `appcast.xml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Keep the app zip (and optional dSYM zip) ready to attach to the GitHub release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Follow [macOS release](/platforms/mac/release) for the exact commands and required env vars.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `APP_BUILD` must be numeric + monotonic (no `-beta`) so Sparkle compares versions correctly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - If notarizing, use the `openclaw-notary` keychain profile created from App Store Connect API env vars (see [macOS release](/platforms/mac/release)).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
6. **Publish (npm)**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Confirm git status is clean; commit and push as needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `npm login` (verify 2FA) if needed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] `npm publish --access public` (use `--tag beta` for pre-releases).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Verify the registry: `npm view openclaw version`, `npm view openclaw dist-tags`, and `npx -y openclaw@X.Y.Z --version` (or `--help`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
### Troubleshooting (notes from 2.0.0-beta2 release)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **npm pack/publish hangs or produces huge tarball**: the macOS app bundle in `dist/OpenClaw.app` (and release zips) get swept into the package. Fix by whitelisting publish contents via `package.json` `files` (include dist subdirs, docs, skills; exclude app bundles). Confirm with `npm pack --dry-run` that `dist/OpenClaw.app` is not listed.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **npm auth web loop for dist-tags**: use legacy auth to get an OTP prompt:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `NPM_CONFIG_AUTH_TYPE=legacy npm dist-tag add openclaw@X.Y.Z latest`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **`npx` verification fails with `ECOMPROMISED: Lock compromised`**: retry with a fresh cache:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `NPM_CONFIG_CACHE=/tmp/npm-cache-$(date +%s) npx -y openclaw@X.Y.Z --version`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- **Tag needs repointing after a late fix**: force-update and push the tag, then ensure the GitHub release assets still match:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `git tag -f vX.Y.Z && git push -f origin vX.Y.Z`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
7. **GitHub release + appcast**（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z` (or `git push --tags`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Create/refresh the GitHub release for `vX.Y.Z` with **title `openclaw X.Y.Z`** (not just the tag); body should include the **full** changelog section for that version (Highlights + Changes + Fixes), inline (no bare links), and **must not repeat the title inside the body**.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Attach artifacts: `npm pack` tarball (optional), `OpenClaw-X.Y.Z.zip`, and `OpenClaw-X.Y.Z.dSYM.zip` (if generated).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Commit the updated `appcast.xml` and push it (Sparkle feeds from main).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] From a clean temp directory (no `package.json`), run `npx -y openclaw@X.Y.Z send --help` to confirm install/CLI entrypoints work.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- [ ] Announce/share release notes.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Plugin publish scope (npm)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
We only publish **existing npm plugins** under the `@openclaw/*` scope. Bundled（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
plugins that are not on npm stay **disk-tree only** (still shipped in（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
`extensions/**`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Process to derive the list:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1. `npm search @openclaw --json` and capture the package names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2. Compare with `extensions/*/package.json` names.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3. Publish only the **intersection** (already on npm).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Current npm plugin list (update as needed):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/bluebubbles（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/diagnostics-otel（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/discord（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/feishu（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/lobster（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/matrix（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/msteams（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/nextcloud-talk（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/nostr（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/voice-call（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/zalo（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- @openclaw/zalouser（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Release notes must also call out **new optional bundled plugins** that are **not（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
on by default** (example: `tlon`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
