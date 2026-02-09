---
summary: "OpenClaw macOS-utchecklista för release (Sparkle-flöde, paketering, signering)"
read_when:
  - Skapa eller validera en OpenClaw macOS-release
  - Uppdatera Sparkle-appcasten eller flödestillgångar
title: "macOS-release"
---

# OpenClaw macOS-release (Sparkle)

Denna app fartyg nu Sparkle auto-uppdateringar. Utgåvorna måste vara utvecklarID-signerade, zippade och publicerade med en signerad appcast-post.

## Förutsättningar

- Developer ID Application-certifikat installerat (exempel: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle privat nyckelväg i miljön som `SPARKLE_PRIVATE_KEY_FILE` (sökväg till din Sparkle ed25519 privata nyckel, offentlig nyckel bakad i Info.plist). Om det saknas, kontrollera `~/.profile`.
- Notariseringuppgifter (nyckelringsprofil eller API-nyckel) för `xcrun notarytool` om du vill ha Gatekeeper-säker DMG/zip-distribution.
  - Vi använder en nyckelringsprofil med namnet `openclaw-notary`, skapad från App Store Connect API-nyckelns miljövariabler i din shellprofil:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm`-beroenden installerade (`pnpm install --config.node-linker=hoisted`).
- Sparkle-verktyg hämtas automatiskt via SwiftPM på `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, etc.).

## Bygg & paketera

Noteringar:

- `APP_BUILD` mappas till `CFBundleVersion`/`sparkle:version`; håll det numeriskt + monotont (inga `-beta`), annars jämför Sparkle det som lika.
- Standardvärdet för den aktuella arkitekturen (`$(uname -m)`). För utgåva/universella byggen, sätt `BUILD_ARCHS="arm64 x86_64"` (eller `BUILD_ARCHS=alla`).
- Använd `scripts/package-mac-dist.sh` för release-artefakter (zip + DMG + notarization). Använd `scripts/package-mac-app.sh` för local/dev-paketering.

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

## Appcast-post

Använd generatorn för versionsanteckningar så att Sparkle renderar formaterade HTML-anteckningar:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Skapar HTML-versionsanteckningar från `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) och bäddar in dem i appcast-posten.
Commit the updated `appcast.xml` alongside the release assets (zip + dSYM) when publishing. (Automatic Copy)

## Publicera & verifiera

- Ladda upp `OpenClaw-2026.2.6.zip` (och `OpenClaw-2026.2.6.dSYM.zip`) till GitHub-releasen för taggen `v2026.2.6`.
- Säkerställ att den råa appcast-URL:en matchar det inbakade flödet: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Rimlighetskontroller:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` returnerar 200.
  - `curl -I <enclosure url>` returnerar 200 efter att tillgångar laddats upp.
  - På en tidigare publik build, kör ”Check for Updates…” från fliken About och verifiera att Sparkle installerar den nya builden utan problem.

Definition av klart: signerad app + appcast är publicerade, uppdateringsflödet fungerar från en äldre installerad version och releaseartefakter är bifogade till GitHub-releasen.
