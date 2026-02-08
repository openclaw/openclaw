---
summary: "OpenClaw macOS-udgivelsestjekliste (Sparkle-feed, pakning, signering)"
read_when:
  - Når du klargør eller validerer en OpenClaw macOS-udgivelse
  - Når du opdaterer Sparkle-appcast eller feed-aktiver
title: "macOS-udgivelse"
x-i18n:
  source_path: platforms/mac/release.md
  source_hash: 98d6640ae4ea9cc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T10:50:29Z
---

# OpenClaw macOS-udgivelse (Sparkle)

Denne app leveres nu med Sparkle auto-opdateringer. Udgivelsesbuilds skal være Developer ID-signeret, zippet og udgivet med en signeret appcast-post.

## Forudsætninger

- Developer ID Application-certifikat installeret (eksempel: `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Sparkle privat nøglesti sat i miljøet som `SPARKLE_PRIVATE_KEY_FILE` (sti til din Sparkle ed25519 private nøgle; offentlig nøgle er indbygget i Info.plist). Hvis den mangler, tjek `~/.profile`.
- Notary-legitimationsoplysninger (Keychain-profil eller API-nøgle) for `xcrun notarytool`, hvis du vil have Gatekeeper-sikker DMG/zip-distribution.
  - Vi bruger en Keychain-profil med navnet `openclaw-notary`, oprettet fra App Store Connect API-nøgle-miljøvariabler i din shell-profil:
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- `pnpm`-afhængigheder installeret (`pnpm install --config.node-linker=hoisted`).
- Sparkle-værktøjer hentes automatisk via SwiftPM ved `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast` osv.).

## Build & pakning

Noter:

- `APP_BUILD` kortlægges til `CFBundleVersion`/`sparkle:version`; hold den numerisk og monoton (ingen `-beta`), ellers sammenligner Sparkle den som lig.
- Standard er den aktuelle arkitektur (`$(uname -m)`). For release/universal builds, sæt `BUILD_ARCHS="arm64 x86_64"` (eller `BUILD_ARCHS=all`).
- Brug `scripts/package-mac-dist.sh` til release-artefakter (zip + DMG + notarization). Brug `scripts/package-mac-app.sh` til lokal/dev-pakning.

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

Brug generatoren til release-noter, så Sparkle renderer formaterede HTML-noter:

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.6.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Genererer HTML-release-noter fra `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) og indlejrer dem i appcast-posten.
Commit den opdaterede `appcast.xml` sammen med release-aktiverne (zip + dSYM) ved udgivelse.

## Udgiv & verificér

- Upload `OpenClaw-2026.2.6.zip` (og `OpenClaw-2026.2.6.dSYM.zip`) til GitHub-udgivelsen for tag `v2026.2.6`.
- Sørg for, at den rå appcast-URL matcher det indbyggede feed: `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Sundhedstjek:
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` returnerer 200.
  - `curl -I <enclosure url>` returnerer 200 efter upload af aktiver.
  - På en tidligere offentlig build: kør “Check for Updates…” fra Om-fanen og bekræft, at Sparkle installerer den nye build korrekt.

Definition of done: signeret app + appcast er udgivet, opdateringsflowet virker fra en ældre installeret version, og release-aktiver er vedhæftet GitHub-udgivelsen.
