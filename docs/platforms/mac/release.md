---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
summary: "OpenClaw macOS release checklist (Sparkle feed, packaging, signing)"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
read_when:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Cutting or validating a OpenClaw macOS release（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - Updating the Sparkle appcast or feed assets（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
title: "macOS Release"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
---（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# OpenClaw macOS release (Sparkle)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
This app now ships Sparkle auto-updates. Release builds must be Developer ID–signed, zipped, and published with a signed appcast entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Prereqs（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Developer ID Application cert installed (example: `Developer ID Application: <Developer Name> (<TEAMID>)`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sparkle private key path set in the environment as `SPARKLE_PRIVATE_KEY_FILE` (path to your Sparkle ed25519 private key; public key baked into Info.plist). If it is missing, check `~/.profile`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Notary credentials (keychain profile or API key) for `xcrun notarytool` if you want Gatekeeper-safe DMG/zip distribution.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - We use a Keychain profile named `openclaw-notary`, created from App Store Connect API key env vars in your shell profile:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `pnpm` deps installed (`pnpm install --config.node-linker=hoisted`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sparkle tools are fetched automatically via SwiftPM at `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, etc.).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Build & package（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- `APP_BUILD` maps to `CFBundleVersion`/`sparkle:version`; keep it numeric + monotonic (no `-beta`), or Sparkle compares it as equal.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Defaults to the current architecture (`$(uname -m)`). For release/universal builds, set `BUILD_ARCHS="arm64 x86_64"` (or `BUILD_ARCHS=all`).（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Use `scripts/package-mac-dist.sh` for release artifacts (zip + DMG + notarization). Use `scripts/package-mac-app.sh` for local/dev packaging.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# From repo root; set release IDs so Sparkle feed is enabled.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# APP_BUILD must be numeric + monotonic for Sparkle compare.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUNDLE_ID=bot.molt.mac \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_VERSION=2026.2.9 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_BUILD="$(git rev-list --count HEAD)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUILD_CONFIG=release \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package-mac-app.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Zip for distribution (includes resource forks for Sparkle delta support)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.9.zip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optional: also build a styled DMG for humans (drag to /Applications)（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.9.dmg（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Recommended: build + notarize/staple zip + DMG（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# First, create a keychain profile once:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#   xcrun notarytool store-credentials "openclaw-notary" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUNDLE_ID=bot.molt.mac \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_VERSION=2026.2.9 \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
APP_BUILD="$(git rev-list --count HEAD)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
BUILD_CONFIG=release \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
scripts/package-mac-dist.sh（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
# Optional: ship dSYM alongside the release（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.9.dSYM.zip（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Appcast entry（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Use the release note generator so Sparkle renders formatted HTML notes:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```bash（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.9.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
```（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Generates HTML release notes from `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) and embeds them in the appcast entry.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Commit the updated `appcast.xml` alongside the release assets (zip + dSYM) when publishing.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
## Publish & verify（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Upload `OpenClaw-2026.2.9.zip` (and `OpenClaw-2026.2.9.dSYM.zip`) to the GitHub release for tag `v2026.2.9`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Ensure the raw appcast URL matches the baked feed: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
- Sanity checks:（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` returns 200.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - `curl -I <enclosure url>` returns 200 after assets upload.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
  - On a previous public build, run “Check for Updates…” from the About tab and verify Sparkle installs the new build cleanly.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
Definition of done: signed app + appcast are published, update flow works from an older installed version, and release assets are attached to the GitHub release.（轉為繁體中文）（轉為繁體中文）（轉為繁體中文）
