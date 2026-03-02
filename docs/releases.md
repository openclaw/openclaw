# Release Channels & Versioning

## Release Channels

| Channel  | Description                                                                          |
| -------- | ------------------------------------------------------------------------------------ |
| `stable` | Tagged releases only (e.g. `vYYYY.M.D`), npm dist-tag `latest`                       |
| `beta`   | Prerelease tags `vYYYY.M.D-beta.N`, npm dist-tag `beta` (may ship without macOS app) |
| `dev`    | Moving head on `main` (no tag)                                                       |

Beta naming: prefer `-beta.N`; do not mint new `-1/-2` betas.

## Version Locations

Bump all of these when cutting a release:

- `package.json` (CLI)
- `apps/android/app/build.gradle.kts` (versionName/versionCode)
- `apps/ios/Sources/Info.plist` + `apps/ios/Tests/Info.plist` (CFBundleShortVersionString/CFBundleVersion)
- `apps/macos/Sources/OpenClaw/Resources/Info.plist` (CFBundleShortVersionString/CFBundleVersion)
- `docs/install/updating.md` (pinned npm version)
- `docs/platforms/mac/release.md` (APP_VERSION/APP_BUILD examples)

Do **not** touch `appcast.xml` unless cutting a new macOS Sparkle release.

## Pre-release Checks

```bash
node --import tsx scripts/release-check.ts
pnpm release:check
OPENCLAW_INSTALL_SMOKE_SKIP_NONROOT=1 pnpm test:install:smoke
```

## npm Publish (via 1Password)

All `op` commands must run inside a fresh tmux session:

```bash
eval "$(op signin --account my.1password.com)"
OTP=$(op read 'op://Private/Npmjs/one-time password?attribute=otp')
npm publish --access public --otp="$OTP"
```

Verify: `npm view <pkg> version --userconfig "$(mktemp)"`

## GitHub Release (macOS beta)

- Tag: `vYYYY.M.D-beta.N` from the release commit
- Title: `openclaw YYYY.M.D-beta.N`
- Body: release notes from `CHANGELOG.md` (Changes + Fixes sections only)
- Attach: `OpenClaw-YYYY.M.D.zip`, `OpenClaw-YYYY.M.D.dSYM.zip`, `.dmg` if available

## CHANGELOG

- User-facing changes only; no internal/meta notes
- Keep top version entries sorted: `### Changes` first, then `### Fixes` (user-facing first)

## Full Release Checklist

See `docs/reference/RELEASING.md` and `docs/platforms/mac/release.md`.

## Release Guardrails

- Do not change version numbers without explicit consent
- Always ask permission before running any npm publish/release step
- When using a beta tag, publish npm with matching beta suffix (e.g. `2026.2.15-beta.1` not plain version on `--tag beta`)
