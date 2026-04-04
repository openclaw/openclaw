# VeriClaw 爪印 macOS app (dev + signing)

## Quick dev run

```bash
# from repo root
scripts/restart-mac.sh
```

## Package tests

Run package tests through the Xcode toolchain wrapper instead of plain
`swift test`, especially when `xcode-select` still points at Command Line
Tools:

```bash
# from repo root
pnpm mac:test
```

Equivalent direct command:

```bash
scripts/macos-swift.sh test
```

The same wrapper works for local builds and runs:

```bash
scripts/macos-swift.sh build
scripts/macos-swift.sh run OpenClaw
scripts/macos-swift.sh run openclaw-mac discover --timeout 3000 --json
```

For the synchronized GitHub + App Store ship gate, pair this with:

- `pnpm release:apple:check`
- `pnpm release:apple:repo-check`
- `pnpm ios:doctor`
- Full runbook: [docs/platforms/apple-release-readiness.md](/Users/alma/openclaw/docs/platforms/apple-release-readiness.md)

Do not call the Apple side ready if `pnpm mac:test` is green but the iOS doctor or
repo-side Apple checks are still blocked.

Options:

```bash
scripts/restart-mac.sh --no-sign   # fastest dev; ad-hoc signing (TCC permissions do not stick)
scripts/restart-mac.sh --sign      # force code signing (requires cert)
```

## Packaging flow

```bash
scripts/package-mac-app.sh
```

Creates `dist/VeriClaw 爪印.app` and signs it via `scripts/codesign-mac-app.sh`.
The packager also removes stale legacy bundles from `dist/legacy-branding/`,
`dist/Vericlaw.app`, and `dist/OpenClaw.app` so the final handoff stays on a
single canonical app bundle.

## Signing behavior

Auto-selects identity (first match):
1) Developer ID Application
2) Apple Distribution
3) Apple Development
4) first available identity

If none found:
- errors by default
- set `ALLOW_ADHOC_SIGNING=1` or `SIGN_IDENTITY="-"` to ad-hoc sign

## Team ID audit (Sparkle mismatch guard)

After signing, we read the app bundle Team ID and compare every Mach-O inside the app.
If any embedded binary has a different Team ID, signing fails.

Skip the audit:
```bash
SKIP_TEAM_ID_CHECK=1 scripts/package-mac-app.sh
```

## Library validation workaround (dev only)

If Sparkle Team ID mismatch blocks loading (common with Apple Development certs), opt in:

```bash
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh
```

This adds `com.apple.security.cs.disable-library-validation` to app entitlements.
Use for local dev only; keep off for release builds.

## Useful env flags

- `SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`
- `ALLOW_ADHOC_SIGNING=1` (ad-hoc, TCC permissions do not persist)
- `CODESIGN_TIMESTAMP=off` (offline debug)
- `DISABLE_LIBRARY_VALIDATION=1` (dev-only Sparkle workaround)
- `SKIP_TEAM_ID_CHECK=1` (bypass audit)
