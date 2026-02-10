# OpenClaw macOS app (dev + signing)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Quick dev run（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# from repo root（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/restart-mac.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Options:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/restart-mac.sh --no-sign   # fastest dev; ad-hoc signing (TCC permissions do not stick)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/restart-mac.sh --sign      # force code signing (requires cert)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Packaging flow（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package-mac-app.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Creates `dist/OpenClaw.app` and signs it via `scripts/codesign-mac-app.sh`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Signing behavior（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Auto-selects identity (first match):（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
1) Developer ID Application（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
2) Apple Distribution（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
3) Apple Development（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
4) first available identity（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If none found:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- errors by default（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- set `ALLOW_ADHOC_SIGNING=1` or `SIGN_IDENTITY="-"` to ad-hoc sign（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Team ID audit (Sparkle mismatch guard)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
After signing, we read the app bundle Team ID and compare every Mach-O inside the app.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If any embedded binary has a different Team ID, signing fails.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Skip the audit:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SKIP_TEAM_ID_CHECK=1 scripts/package-mac-app.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Library validation workaround (dev only)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
If Sparkle Team ID mismatch blocks loading (common with Apple Development certs), opt in:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
DISABLE_LIBRARY_VALIDATION=1 scripts/package-mac-app.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This adds `com.apple.security.cs.disable-library-validation` to app entitlements.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use for local dev only; keep off for release builds.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Useful env flags（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SIGN_IDENTITY="Apple Development: Your Name (TEAMID)"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `ALLOW_ADHOC_SIGNING=1` (ad-hoc, TCC permissions do not persist)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `CODESIGN_TIMESTAMP=off` (offline debug)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `DISABLE_LIBRARY_VALIDATION=1` (dev-only Sparkle workaround)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `SKIP_TEAM_ID_CHECK=1` (bypass audit)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
