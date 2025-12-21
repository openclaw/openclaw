---
summary: "Clawdis macOS release checklist (Sparkle feed, packaging, signing)"
read_when:
  - Cutting or validating a Clawdis macOS release
  - Updating the Sparkle appcast or feed assets
---

# Clawdis macOS release (Sparkle)

This app now ships Sparkle auto-updates. Release builds must be Developer ID–signed, zipped, and published with a signed appcast entry.

## Prereqs
- Developer ID Application cert installed (`Developer ID Application: Peter Steinberger (Y5PE65HELJ)` is expected).
- Sparkle private key path set in the environment as `SPARKLE_PRIVATE_KEY_FILE`; key lives in `/Users/steipete/Library/CloudStorage/Dropbox/Backup/Sparkle` (same key as Trimmy; public key baked into Info.plist).
- Notary credentials (keychain profile or API key) for `xcrun notarytool` if you want Gatekeeper-safe DMG/zip distribution.
- `pnpm` deps installed (`pnpm install --config.node-linker=hoisted`).
- Sparkle tools are fetched automatically via SwiftPM at `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, etc.).

## Build & package
```bash
# From repo root; set release IDs so Sparkle feed is enabled
BUNDLE_ID=com.steipete.clawdis \
APP_VERSION=0.1.0 \
APP_BUILD=0.1.0 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: Peter Steinberger (Y5PE65HELJ)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/Clawdis.app dist/Clawdis-0.1.0.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/Clawdis.app dist/Clawdis-0.1.0.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "clawdis-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=clawdis-notary \
BUNDLE_ID=com.steipete.clawdis \
APP_VERSION=0.1.0 \
APP_BUILD=0.1.0 \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: Peter Steinberger (Y5PE65HELJ)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/Clawdis.app.dSYM dist/Clawdis-0.1.0.dSYM.zip
```

## Appcast entry
1. Generate the ed25519 signature (requires `SPARKLE_PRIVATE_KEY_FILE`):
   ```bash
   SPARKLE_PRIVATE_KEY_FILE=/Users/steipete/Library/CloudStorage/Dropbox/Backup/Sparkle/ed25519-private-key \
   apps/macos/.build/artifacts/sparkle/Sparkle/bin/sign_update dist/Clawdis-0.1.0.zip
   ```
   Copy the reported signature and file size.
2. Edit `appcast.xml` (root of repo), add a new `<item>` at the top pointing to the GitHub release asset. Example snippet to adapt:
   ```xml
   <item>
     <title>Clawdis 0.1.0</title>
     <sparkle:releaseNotesLink>https://github.com/steipete/clawdis/releases/tag/v0.1.0</sparkle:releaseNotesLink>
     <pubDate>Sun, 07 Dec 2025 12:00:00 +0000</pubDate>
     <enclosure url="https://github.com/steipete/clawdis/releases/download/v0.1.0/Clawdis-0.1.0.zip"
                sparkle:edSignature="<signature from sign_update>"
                sparkle:version="0.1.0"
                sparkle:shortVersionString="0.1.0"
                length="<zip byte size>"
                type="application/octet-stream" />
   </item>
   ```
   Keep the newest item first; leave the channel metadata intact.
3. Commit the updated `appcast.xml` alongside the release assets (zip + dSYM) when publishing.

## Publish & verify
- Upload `Clawdis-0.1.0.zip` (and `Clawdis-0.1.0.dSYM.zip`) to the GitHub release for tag `v0.1.0`.
- Ensure the raw appcast URL matches the baked feed: `https://raw.githubusercontent.com/steipete/clawdis/main/appcast.xml`.
- Sanity checks:
  - `curl -I https://raw.githubusercontent.com/steipete/clawdis/main/appcast.xml` returns 200.
  - `curl -I <enclosure url>` returns 200 after assets upload.
  - On a previous public build, run “Check for Updates…” from the About tab and verify Sparkle installs the new build cleanly.

Definition of done: signed app + appcast are published, update flow works from an older installed version, and release assets are attached to the GitHub release.
