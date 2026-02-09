---
summary: "OpenClaw macOS-releasechecklist (Sparkle-feed, packaging, ondertekening)"
read_when:
  - Een OpenClaw macOS-release maken of valideren
  - De Sparkle-appcast of feed-assets bijwerken
title: "macOS-release"
---

# OpenClaw macOS-release (Sparkle)

Deze app levert nu Sparkle automatische updates. Release-builds moeten met een Developer ID worden ondertekend, gecomprimeerd (zip) en gepubliceerd met een ondertekende appcast-vermelding.

## Prereqs

- Developer ID Application-certificaat geïnstalleerd (voorbeeld: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle-privésleutelpad ingesteld in de omgeving als `SPARKLE_PRIVATE_KEY_FILE` (pad naar je Sparkle ed25519-privésleutel; publieke sleutel ingebakken in Info.plist). Als dit ontbreekt, controleer `~/.profile`.
- Notary-referenties (sleutelhangprofiel of API-sleutel) voor `xcrun notarytool` als je Gatekeeper-veilige DMG/zip-distributie wilt.
  - We gebruiken een Sleutelhang-profiel met de naam `openclaw-notary`, aangemaakt op basis van App Store Connect API-sleutel-omgevingsvariabelen in je shellprofiel:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm`-deps geïnstalleerd (`pnpm install --config.node-linker=hoisted`).
- Sparkle-tools worden automatisch opgehaald via SwiftPM op `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, enz.).

## Build & packaging

Notities:

- `APP_BUILD` komt overeen met `CFBundleVersion`/`sparkle:version`; houd dit numeriek en monotoon (geen `-beta`), anders vergelijkt Sparkle het als gelijk.
- Standaard wordt de huidige architectuur gebruikt (`$(uname -m)`). Voor release-/universal-builds stel je `BUILD_ARCHS="arm64 x86_64"` in (of `BUILD_ARCHS=all`).
- Gebruik `scripts/package-mac-dist.sh` voor release-artefacten (zip + DMG + notarization). Gebruik `scripts/package-mac-app.sh` voor lokale/dev-packaging.

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

## Appcast-vermelding

Gebruik de release note generator zodat Sparkle opgemaakte HTML-notities rendert:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Genereert HTML-release notes uit `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) en embedt ze in de appcast-vermelding.
Commit de bijgewerkte `appcast.xml` samen met de release-artefacten (zip + dSYM) bij het publiceren.

## Publiceren & verifiëren

- Upload `OpenClaw-2026.2.6.zip` (en `OpenClaw-2026.2.6.dSYM.zip`) naar de GitHub-release voor tag `v2026.2.6`.
- Zorg dat de ruwe appcast-URL overeenkomt met de ingebakken feed: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Sanitychecks:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` retourneert 200.
  - `curl -I <enclosure url>` retourneert 200 na het uploaden van de assets.
  - Voer op een eerdere publieke build “Check for Updates…” uit via het tabblad About en verifieer dat Sparkle de nieuwe build probleemloos installeert.

Definition of done: ondertekende app + appcast zijn gepubliceerd, de updateflow werkt vanuit een oudere geïnstalleerde versie en release-artefacten zijn gekoppeld aan de GitHub-release.
