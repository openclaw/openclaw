---
summary: "Liste de controle de version macOS d’OpenClaw (flux Sparkle, packaging, signature)"
read_when:
  - Publication ou validation d’une version macOS d’OpenClaw
  - Mise a jour de l’appcast Sparkle ou des assets du flux
title: "Version macOS"
---

# Version macOS d’OpenClaw (Sparkle)

Cette application embarque des mises a jour automatiques Sparkle. Les builds de version doivent etre signes avec un Developer ID, zippes et publies avec une entree d’appcast signee.

## Prerequis

- Certificat Developer ID Application installe (exemple : `Developer ID Application: <Developer Name> (<TEAMID>)`).
- Chemin de la cle privee Sparkle defini dans l’environnement sous `SPARKLE_PRIVATE_KEY_FILE` (chemin vers votre cle privee ed25519 Sparkle ; la cle publique est integree dans Info.plist). S’il est manquant, verifiez `~/.profile`.
- Identifiants de notarisation (profil de trousseau ou cle API) pour `xcrun notarytool` si vous souhaitez une distribution DMG/zip compatible Gatekeeper.
  - Nous utilisons un profil de trousseau nomme `openclaw-notary`, cree a partir des variables d’environnement de cle API App Store Connect dans votre profil de shell :
    - `APP_STORE_CONNECT_API_KEY_P8`, `APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`
    - `echo "$APP_STORE_CONNECT_API_KEY_P8" | sed 's/\\n/\n/g' > /tmp/openclaw-notary.p8`
    - `xcrun notarytool store-credentials "openclaw-notary" --key /tmp/openclaw-notary.p8 --key-id "$APP_STORE_CONNECT_KEY_ID" --issuer "$APP_STORE_CONNECT_ISSUER_ID"`
- Dependances `pnpm` installees (`pnpm install --config.node-linker=hoisted`).
- Les outils Sparkle sont recuperes automatiquement via SwiftPM a `apps/macos/.build/artifacts/sparkle/Sparkle/bin/` (`sign_update`, `generate_appcast`, etc.).

## Build & packaging

Notes :

- `APP_BUILD` correspond a `CFBundleVersion`/`sparkle:version` ; conservez une valeur numerique et monotone (pas de `-beta`), sinon Sparkle les compare comme egales.
- Par defaut, l’architecture courante est utilisee (`$(uname -m)`). Pour les builds de version/universels, definissez `BUILD_ARCHS="arm64 x86_64"` (ou `BUILD_ARCHS=all`).
- Utilisez `scripts/package-mac-dist.sh` pour les artefacts de version (zip + DMG + notarisation). Utilisez `scripts/package-mac-app.sh` pour le packaging local/dev.

```bash
# From repo root; set release IDs so Sparkle feed is enabled.
# APP_BUILD must be numeric + monotonic for Sparkle compare.
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.4 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-app.sh

# Zip for distribution (includes resource forks for Sparkle delta support)
ditto -c -k --sequesterRsrc --keepParent dist/OpenClaw.app dist/OpenClaw-2026.2.4.zip

# Optional: also build a styled DMG for humans (drag to /Applications)
scripts/create-dmg.sh dist/OpenClaw.app dist/OpenClaw-2026.2.4.dmg

# Recommended: build + notarize/staple zip + DMG
# First, create a keychain profile once:
#   xcrun notarytool store-credentials "openclaw-notary" \
#     --apple-id "<apple-id>" --team-id "<team-id>" --password "<app-specific-password>"
NOTARIZE=1 NOTARYTOOL_PROFILE=openclaw-notary \
BUNDLE_ID=bot.molt.mac \
APP_VERSION=2026.2.4 \
APP_BUILD="$(git rev-list --count HEAD)" \
BUILD_CONFIG=release \
SIGN_IDENTITY="Developer ID Application: <Developer Name> (<TEAMID>)" \
scripts/package-mac-dist.sh

# Optional: ship dSYM alongside the release
ditto -c -k --keepParent apps/macos/.build/release/OpenClaw.app.dSYM dist/OpenClaw-2026.2.4.dSYM.zip
```

## Entree d’appcast

Utilisez le generateur de notes de version afin que Sparkle rende des notes HTML formatees :

```bash
SPARKLE_PRIVATE_KEY_FILE=/path/to/ed25519-private-key scripts/make_appcast.sh dist/OpenClaw-2026.2.4.zip https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml
```

Genere des notes de version HTML a partir de `CHANGELOG.md` (via [`scripts/changelog-to-html.sh`](https://github.com/openclaw/openclaw/blob/main/scripts/changelog-to-html.sh)) et les integre dans l’entree d’appcast.
Committez le `appcast.xml` mis a jour en meme temps que les assets de version (zip + dSYM) lors de la publication.

## Publier & verifier

- Televersez `OpenClaw-2026.2.4.zip` (et `OpenClaw-2026.2.4.dSYM.zip`) dans la version GitHub pour le tag `v2026.2.4`.
- Assurez-vous que l’URL brute de l’appcast correspond au flux integre : `https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml`.
- Verifications de bon sens :
  - `curl -I https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml` renvoie 200.
  - `curl -I <enclosure url>` renvoie 200 apres le televersement des assets.
  - Sur une version publique precedente, lancez « Rechercher des mises a jour… » depuis l’onglet A propos et verifiez que Sparkle installe correctement la nouvelle version.

Definition de termine : l’application signee et l’appcast sont publies, le flux de mise a jour fonctionne depuis une version plus ancienne installee, et les assets de version sont attaches a la version GitHub.
