---
summary: "Checklist ng release ng OpenClaw sa macOS (Sparkle feed, packaging, signing)"
read_when:
  - Pag-cut o pag-validate ng isang OpenClaw macOS release
  - Pag-update ng Sparkle appcast o mga feed asset
title: "macOS Release"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:45:44Z
---

# OpenClaw macOS release (Sparkle)

Ang app na ito ay may kasamang Sparkle auto-updates. Ang mga release build ay dapat naka–Developer ID–signed, naka-zip, at nai-publish na may signed appcast entry.

## Mga paunang kinakailangan

- Naka-install ang Developer ID Application cert (halimbawa: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Naka-set sa environment ang Sparkle private key path bilang `SPARKLE_PRIVATE_KEY_FILE` (path papunta sa iyong Sparkle ed25519 private key; ang public key ay naka-bake sa Info.plist). Kung nawawala, i-check ang `~/.profile`.
- Notary credentials (keychain profile o API key) para sa `xcrun notarytool` kung gusto mo ng Gatekeeper-safe na DMG/zip distribution.
  - Gumagamit kami ng Keychain profile na pinangalanang `openclaw-notary`, na ginawa mula sa App Store Connect API key env vars sa iyong shell profile:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Naka-install ang `pnpm` deps (`pnpm install --config.node-linker=hoisted`).
- Awtomatikong kinukuha ang Sparkle tools via SwiftPM sa `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, atbp.).

## Build & package

Mga tala:

- Ang `APP_BUILD` ay nagma-map sa `CFBundleVersion`/`sparkle:version`; panatilihin itong numeric + monotonic (walang `-beta`), kung hindi ay iko-compare ito ng Sparkle bilang equal.
- Default sa kasalukuyang architecture (`$(uname -m)`). Para sa release/universal builds, i-set ang `BUILD_ARCHS="arm64 x86_64"` (o `BUILD_ARCHS=all`).
- Gamitin ang `scripts/package-mac-dist.sh` para sa mga release artifact (zip + DMG + notarization). Gamitin ang `scripts/package-mac-app.sh` para sa local/dev packaging.

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.6.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.6.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.6 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.6.dSYM.zip
```

## Appcast entry

Gamitin ang release note generator para mag-render ang Sparkle ng formatted HTML notes:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Bumubuo ng HTML release notes mula sa `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) at ini-embed ang mga ito sa appcast entry.
I-commit ang na-update na `appcast.xml` kasama ng mga release asset (zip + dSYM) kapag nagpa-publish.

## I-publish at i-verify

- I-upload ang `OpenClaw-2026.2.6.zip` (at `OpenClaw-2026.2.6.dSYM.zip`) sa GitHub release para sa tag na `v2026.2.6`.
- Siguraduhing tugma ang raw appcast URL sa baked feed: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Mga sanity check:
  - Nagbabalik ng 200 ang `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
  - Nagbabalik ng 200 ang `curl -I <enclosure url>` pagkatapos ng pag-upload ng mga asset.
  - Sa isang naunang public build, patakbuhin ang “Check for Updates…” mula sa About tab at tiyaking maayos na ini-install ng Sparkle ang bagong build.

Kahulugan ng tapos: nai-publish ang signed app + appcast, gumagana ang update flow mula sa mas lumang naka-install na bersyon, at naka-attach ang mga release asset sa GitHub release.
